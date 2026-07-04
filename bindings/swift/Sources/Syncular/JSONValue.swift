// A minimal, dependency-free JSON value for the command surface. The core
// speaks JSON on the wire; this enum is the idiomatic Swift shape for building
// command params and reading results, with a couple of ergonomic accessors.
//
// Encoding/decoding go through Foundation's JSONSerialization (no Codable
// ceremony, no third-party dep) — the payloads are small command envelopes.

import Foundation

public enum JSONValue: Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    // MARK: - Ergonomic accessors

    public var stringValue: String? {
        if case let .string(s) = self { return s }
        return nil
    }

    public var boolValue: Bool? {
        if case let .bool(b) = self { return b }
        return nil
    }

    public var numberValue: Double? {
        if case let .number(n) = self { return n }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case let .array(a) = self { return a }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case let .object(o) = self { return o }
        return nil
    }

    public subscript(key: String) -> JSONValue? {
        if case let .object(o) = self { return o[key] }
        return nil
    }

    // MARK: - Encode / decode

    /// Serialize to a compact JSON string.
    public func encodedString() throws -> String {
        let data = try JSONSerialization.data(
            withJSONObject: toFoundation(),
            options: [.fragmentsAllowed]
        )
        guard let string = String(data: data, encoding: .utf8) else {
            throw SyncularError(code: "client.failed", message: "JSON is not UTF-8")
        }
        return string
    }

    /// Parse a JSON string into a `JSONValue`.
    public init(decoding string: String) throws {
        guard let data = string.data(using: .utf8) else {
            throw SyncularError(code: "client.failed", message: "input is not UTF-8")
        }
        let object = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        self = JSONValue(foundation: object)
    }

    // MARK: - Foundation bridging

    private func toFoundation() -> Any {
        switch self {
        case .null: return NSNull()
        case let .bool(b): return b
        case let .number(n): return n
        case let .string(s): return s
        case let .array(a): return a.map { $0.toFoundation() }
        case let .object(o): return o.mapValues { $0.toFoundation() }
        }
    }

    private init(foundation object: Any) {
        switch object {
        case is NSNull:
            self = .null
        case let number as NSNumber:
            // NSNumber bridges both Bool and numeric JSON; distinguish by type.
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                self = .bool(number.boolValue)
            } else {
                self = .number(number.doubleValue)
            }
        case let string as String:
            self = .string(string)
        case let array as [Any]:
            self = .array(array.map { JSONValue(foundation: $0) })
        case let dict as [String: Any]:
            self = .object(dict.mapValues { JSONValue(foundation: $0) })
        default:
            self = .null
        }
    }
}
