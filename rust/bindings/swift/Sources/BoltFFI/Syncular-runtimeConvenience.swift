import Foundation

public extension SyncularBoltClient {
    func joinPresenceHandle(scopeKey: String, metadataJson: String? = nil) throws -> SyncularPresenceHandle {
        _ = try joinPresence(scopeKey: scopeKey, metadataJson: metadataJson)
        return SyncularPresenceHandle(
            scopeKey: scopeKey,
            update: { [weak self] metadataJson in
                guard let self else { throw FfiError(message: "Syncular client was released") }
                _ = try self.updatePresenceMetadata(scopeKey: scopeKey, metadataJson: metadataJson)
            },
            leave: { [weak self] in
                guard let self else { return }
                _ = try self.leavePresence(scopeKey: scopeKey)
            }
        )
    }

    func eventJsonStream(capacity: UInt64 = 256) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task.detached { [weak self] in
                guard let self else {
                    continuation.finish()
                    return
                }
                do {
                    _ = try self.startEventStream(capacity: capacity)
                    while !Task.isCancelled {
                        guard let eventJson = try self.nextEventJson() else { break }
                        continuation.yield(eventJson)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { [weak self] _ in
                task.cancel()
                _ = try? self?.closeEventStream()
            }
        }
    }
}

public final class SyncularPresenceHandle {
    public let scopeKey: String
    private let updateFn: (String) throws -> Void
    private let leaveFn: () throws -> Void
    private var active = true

    fileprivate init(
        scopeKey: String,
        update: @escaping (String) throws -> Void,
        leave: @escaping () throws -> Void
    ) {
        self.scopeKey = scopeKey
        updateFn = update
        leaveFn = leave
    }

    public func update(metadataJson: String) throws {
        try updateFn(metadataJson)
    }

    public func close() throws {
        guard active else { return }
        active = false
        try leaveFn()
    }

    deinit {
        try? close()
    }
}
