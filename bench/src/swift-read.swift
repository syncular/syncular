import Foundation
import MachO
import Syncular

// Private benchmark protocol. All client calls use the separately compiled SDK.
@main
struct SwiftReadBench {
    static func main() throws {
        var client: SyncularClient?
        defer { client?.close() }
        while let line = readLine() {
            let request = try JSONValue(decoding: line)
            let id = request["id"] ?? .null
            do {
                guard let method = request["method"]?.stringValue,
                      let params = request["params"] else {
                    throw SyncularError(code: "bench.invalid_request", message: "Missing command")
                }
                let result: JSONValue
                if method == "create" {
                    guard client == nil, let schema = params["schema"],
                          let transport = params["transport"],
                          let baseUrl = transport["baseUrl"]?.stringValue,
                          let clientId = params["clientId"]?.stringValue else {
                        throw SyncularError(code: "bench.invalid_request", message: "Invalid create")
                    }
                    var headers: [String: String] = [:]
                    for (key, value) in transport["headers"]?.objectValue ?? [:] {
                        guard let text = value.stringValue else {
                            throw SyncularError(code: "bench.invalid_request", message: "Invalid header")
                        }
                        headers[key] = text
                    }
                    client = try SyncularClient(
                        clientId: clientId, schema: schema,
                        config: SyncularConfig(baseUrl: baseUrl,
                            wsUrl: transport["wsUrl"]?.stringValue, headers: headers,
                            dbPath: params["dbPath"]?.stringValue),
                        limits: params["limits"],
                        deliveryQueue: DispatchQueue(label: "syncular.bench.delivery")
                    )
                    result = .object([:])
                } else {
                    guard let client else {
                        throw SyncularError(code: "bench.invalid_request", message: "Client missing")
                    }
                    if method == "benchRead" {
                        result = try measure(client, params)
                    } else {
                        result = try client.command(method: method, params: params)
                    }
                }
                print(try JSONValue.object(["id": id, "result": result]).encodedString())
            } catch {
                print(try JSONValue.object(["id": id, "error": .object([
                    "code": .string((error as? SyncularError)?.code ?? "bench.failed"),
                    "message": .string(String(describing: error)),
                ])]).encodedString())
            }
            fflush(stdout)
        }
    }

    static func measure(_ client: SyncularClient, _ params: JSONValue) throws -> JSONValue {
        guard params["mode"]?.stringValue == "swift",
              let count = params["iterations"]?.numberValue,
              count.rounded() == count, (1...100).contains(count),
              let queries = params["queries"]?.arrayValue, queries.count == 2 else {
            throw SyncularError(code: "bench.invalid_request", message: "Invalid read fixture")
        }
        let iterations = Int(count)
        guard let revision = try client.command(method: "localRevision", params: .object([:]))["revision"] else {
            throw SyncularError(code: "bench.validation_failed", message: "Missing revision")
        }
        var measured: [JSONValue] = []
        for query in queries {
            guard let name = query["name"]?.stringValue, let sql = query["sql"]?.stringValue,
                  let inputs = query["inputs"]?.arrayValue, inputs.count == iterations + 3 else {
                throw SyncularError(code: "bench.invalid_request", message: "Invalid query inputs")
            }
            var samples: [String: [JSONValue]] = ["query": [], "snapshot": []]
            for (iteration, input) in inputs.enumerated() {
                guard let binds = input["params"]?.arrayValue, let expected = input["rows"]?.arrayValue else {
                    throw SyncularError(code: "bench.invalid_request", message: "Invalid expected rows")
                }
                for offset in 0..<2 {
                    let surface = ["query", "snapshot"][(iteration + offset) % 2]
                    // Release temporary Foundation objects after every sample. The SDK call
                    // and its result materialization are timed; validation and pool drain are not.
                    let elapsed: UInt64 = try autoreleasepool {
                        let started = DispatchTime.now().uptimeNanoseconds
                        let rows: [JSONValue]
                        let snapshot: JSONValue?
                        if surface == "query" {
                            rows = try client.query(sql, params: binds)
                            snapshot = nil
                        } else {
                            snapshot = try client.querySnapshot(sql, params: binds)
                            rows = snapshot?["rows"]?.arrayValue ?? []
                        }
                        let elapsed = DispatchTime.now().uptimeNanoseconds - started
                        guard rows == expected,
                              snapshot == nil || (snapshot?["revision"] == revision &&
                                  snapshot?["coverage"]?["complete"]?.boolValue == true) else {
                            throw SyncularError(code: "bench.validation_failed", message: "Read result differs from fixture")
                        }
                        return elapsed
                    }
                    if iteration >= 3 { samples[surface, default: []].append(.number(Double(elapsed))) }
                }
            }
            measured.append(.object([
                "name": .string(name), "sql": .string(sql),
                "plan": .array(try client.query("EXPLAIN QUERY PLAN \(sql)", params: inputs[0]["params"]?.arrayValue ?? [])),
                "samplesNs": .object(samples.mapValues(JSONValue.array)),
            ]))
        }
        guard try client.command(method: "localRevision", params: .object([:]))["revision"] == revision,
              try client.statusSnapshot()["outbox"]?.numberValue == 0 else {
            throw SyncularError(code: "bench.validation_failed", message: "Read changed replica state")
        }
        let images = (0..<_dyld_image_count()).compactMap { index -> JSONValue? in
            guard let name = _dyld_get_image_name(index) else { return nil }
            let path = String(cString: name)
            return ["libsyncular.dylib", "libSyncularSwiftBench.dylib"].contains(URL(fileURLWithPath: path).lastPathComponent)
                ? .string(path) : nil
        }
        return .object([
            "binding": .string("swift"), "loadedLibraries": .array(images),
            "iterations": .number(count), "warmups": .number(3), "revision": revision,
            "queries": .array(measured),
            "schema": .array(try client.query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name")),
            "sqlite": .object([
                "version": try client.query("SELECT sqlite_version() AS version").first?["version"] ?? .null,
                "journalMode": try client.query("SELECT journal_mode FROM pragma_journal_mode").first?["journal_mode"] ?? .null,
                "synchronous": try client.query("SELECT synchronous FROM pragma_synchronous").first?["synchronous"] ?? .null,
            ]),
        ])
    }
}
