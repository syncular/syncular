import Combine
import Foundation
import SwiftUI
import Syncular

public protocol SyncularEventJsonStreaming {
    func eventJsonStream(capacity: UInt64) -> AsyncThrowingStream<String, Error>
}

extension SyncularBoltClient: SyncularEventJsonStreaming {}

public protocol SyncularNativeJsonReading: SyncularEventJsonStreaming {
    func presenceJson(scopeKey: String) throws -> String
    func listTableJson(table: String) throws -> String
    func queryJson(requestJson: String) throws -> String
    func blobUploadQueueStatsJson() throws -> String
    func outboxSummariesJson() throws -> String
    func conflictSummariesJson() throws -> String
    func registerQueryJson(queryJson: String) throws -> String
    func unregisterQuery(id: String) throws -> Bool
}

extension SyncularBoltClient: SyncularNativeJsonReading {}

@MainActor
public final class SyncularEventJsonStore: ObservableObject {
    @Published public private(set) var latestEventJson: String?
    @Published public private(set) var eventCount: UInt64 = 0
    @Published public private(set) var isRunning = false
    @Published public private(set) var lastError: Error?

    private var task: Task<Void, Never>?

    public init() {}

    public func start(
        source: SyncularEventJsonStreaming,
        capacity: UInt64 = 256,
        onEvent: @escaping @MainActor (String) -> Void = { _ in }
    ) {
        stop()
        isRunning = true
        lastError = nil
        let stream = source.eventJsonStream(capacity: capacity)
        task = Task { [weak self] in
            do {
                for try await eventJson in stream {
                    await MainActor.run {
                        guard let self else { return }
                        self.latestEventJson = eventJson
                        self.eventCount += 1
                        onEvent(eventJson)
                    }
                }
                await MainActor.run {
                    self?.isRunning = false
                }
            } catch {
                await MainActor.run {
                    self?.lastError = error
                    self?.isRunning = false
                }
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
        isRunning = false
    }
}

@MainActor
public final class SyncularDecodedEventStore<Event>: ObservableObject {
    @Published public private(set) var latestEvent: Event?
    @Published public private(set) var latestEventJson: String?
    @Published public private(set) var eventCount: UInt64 = 0
    @Published public private(set) var isRunning = false
    @Published public private(set) var lastError: Error?

    private var task: Task<Void, Never>?

    public init() {}

    public func start(
        source: SyncularEventJsonStreaming,
        capacity: UInt64 = 256,
        decode: @escaping @Sendable (String) throws -> Event,
        onEvent: @escaping @MainActor (Event) -> Void = { _ in }
    ) {
        stop()
        isRunning = true
        lastError = nil
        let stream = source.eventJsonStream(capacity: capacity)
        task = Task { [weak self] in
            do {
                for try await eventJson in stream {
                    let event = try decode(eventJson)
                    await MainActor.run {
                        guard let self else { return }
                        self.latestEventJson = eventJson
                        self.latestEvent = event
                        self.eventCount += 1
                        onEvent(event)
                    }
                }
                await MainActor.run {
                    self?.isRunning = false
                }
            } catch {
                await MainActor.run {
                    self?.lastError = error
                    self?.isRunning = false
                }
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
        isRunning = false
    }
}

public final class SyncularEventJsonPublisher {
    public let publisher: AnyPublisher<String, Error>

    private let subject = PassthroughSubject<String, Error>()
    private var task: Task<Void, Never>?

    public init(source: SyncularEventJsonStreaming, capacity: UInt64 = 256) {
        publisher = subject.eraseToAnyPublisher()
        let stream = source.eventJsonStream(capacity: capacity)
        task = Task { [subject] in
            do {
                for try await eventJson in stream {
                    subject.send(eventJson)
                }
                subject.send(completion: .finished)
            } catch {
                subject.send(completion: .failure(error))
            }
        }
    }

    public func cancel() {
        task?.cancel()
        task = nil
    }

    deinit {
        cancel()
    }
}

@MainActor
public final class SyncularJsonSnapshotStore: ObservableObject {
    @Published public private(set) var latestJson: String?
    @Published public private(set) var refreshCount: UInt64 = 0
    @Published public private(set) var isObserving = false
    @Published public private(set) var lastError: Error?

    private var task: Task<Void, Never>?

    public init() {}

    public func refresh(read: () throws -> String) {
        do {
            latestJson = try read()
            refreshCount += 1
            lastError = nil
        } catch {
            lastError = error
        }
    }

    public func observe(
        source: SyncularEventJsonStreaming,
        capacity: UInt64 = 256,
        shouldRefresh: @escaping @Sendable (String) -> Bool = { _ in true },
        read: @escaping @MainActor () throws -> String
    ) {
        stop()
        isObserving = true
        refresh(read: read)
        let stream = source.eventJsonStream(capacity: capacity)
        task = Task { [weak self] in
            do {
                for try await eventJson in stream {
                    guard shouldRefresh(eventJson) else { continue }
                    await MainActor.run {
                        self?.refresh(read: read)
                    }
                }
                await MainActor.run {
                    self?.isObserving = false
                }
            } catch {
                await MainActor.run {
                    self?.lastError = error
                    self?.isObserving = false
                }
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
        isObserving = false
    }
}

@MainActor
public final class SyncularPresenceJsonStore: ObservableObject {
    @Published public private(set) var entriesJson = "[]"
    @Published public private(set) var refreshCount: UInt64 = 0
    @Published public private(set) var isObserving = false
    @Published public private(set) var lastError: Error?

    public let scopeKey: String
    private var task: Task<Void, Never>?

    public init(scopeKey: String) {
        self.scopeKey = scopeKey
    }

    public func refresh(client: SyncularNativeJsonReading) {
        do {
            entriesJson = try client.presenceJson(scopeKey: scopeKey)
            refreshCount += 1
            lastError = nil
        } catch {
            lastError = error
        }
    }

    public func observe(client: SyncularNativeJsonReading, capacity: UInt64 = 256) {
        stop()
        isObserving = true
        refresh(client: client)
        let stream = client.eventJsonStream(capacity: capacity)
        task = Task { [weak self] in
            do {
                for try await eventJson in stream {
                    guard eventJson.contains("PresenceChanged") else { continue }
                    await MainActor.run {
                        guard let self else { return }
                        self.refresh(client: client)
                    }
                }
                await MainActor.run {
                    self?.isObserving = false
                }
            } catch {
                await MainActor.run {
                    self?.lastError = error
                    self?.isObserving = false
                }
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
        isObserving = false
    }
}

@MainActor
public final class SyncularStatsJsonStore: ObservableObject {
    @Published public private(set) var outboxJson = "[]"
    @Published public private(set) var conflictsJson = "[]"
    @Published public private(set) var blobUploadQueueJson = "{}"
    @Published public private(set) var refreshCount: UInt64 = 0
    @Published public private(set) var isObserving = false
    @Published public private(set) var lastError: Error?

    private var task: Task<Void, Never>?

    public init() {}

    public func refresh(client: SyncularNativeJsonReading) {
        do {
            outboxJson = try client.outboxSummariesJson()
            conflictsJson = try client.conflictSummariesJson()
            blobUploadQueueJson = try client.blobUploadQueueStatsJson()
            refreshCount += 1
            lastError = nil
        } catch {
            lastError = error
        }
    }

    public func observe(client: SyncularNativeJsonReading, capacity: UInt64 = 256) {
        stop()
        isObserving = true
        refresh(client: client)
        let stream = client.eventJsonStream(capacity: capacity)
        task = Task { [weak self] in
            do {
                for try await eventJson in stream {
                    guard Self.shouldRefresh(for: eventJson) else { continue }
                    await MainActor.run {
                        self?.refresh(client: client)
                    }
                }
                await MainActor.run {
                    self?.isObserving = false
                }
            } catch {
                await MainActor.run {
                    self?.lastError = error
                    self?.isObserving = false
                }
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
        isObserving = false
    }

    private static func shouldRefresh(for eventJson: String) -> Bool {
        eventJson.contains("Sync") ||
            eventJson.contains("Conflict") ||
            eventJson.contains("ConflictsChanged") ||
            eventJson.contains("WorkerCommand")
    }
}

@MainActor
public final class SyncularTableJsonStore: ObservableObject {
    @Published public private(set) var rowsJson = "[]"
    @Published public private(set) var refreshCount: UInt64 = 0
    @Published public private(set) var isObserving = false
    @Published public private(set) var lastError: Error?

    public let table: String
    private var task: Task<Void, Never>?

    public init(table: String) {
        self.table = table
    }

    public func refresh(client: SyncularNativeJsonReading) {
        do {
            rowsJson = try client.listTableJson(table: table)
            refreshCount += 1
            lastError = nil
        } catch {
            lastError = error
        }
    }

    public func observe(client: SyncularNativeJsonReading, capacity: UInt64 = 256) {
        stop()
        isObserving = true
        refresh(client: client)
        let stream = client.eventJsonStream(capacity: capacity)
        let tableName = table
        task = Task { [weak self] in
            do {
                for try await eventJson in stream {
                    guard eventJson.contains("RowsChanged") || eventJson.contains("QueriesChanged") else { continue }
                    guard eventJson.contains("\"\(tableName)\"") else { continue }
                    await MainActor.run {
                        self?.refresh(client: client)
                    }
                }
                await MainActor.run {
                    self?.isObserving = false
                }
            } catch {
                await MainActor.run {
                    self?.lastError = error
                    self?.isObserving = false
                }
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
        isObserving = false
    }
}

@MainActor
public final class SyncularLiveQueryJsonStore: ObservableObject {
    @Published public private(set) var resultJson = "[]"
    @Published public private(set) var queryId: String?
    @Published public private(set) var refreshCount: UInt64 = 0
    @Published public private(set) var isObserving = false
    @Published public private(set) var lastError: Error?

    public let requestJson: String
    public let registrationJson: String?
    private var task: Task<Void, Never>?

    public init(requestJson: String, registrationJson: String? = nil) {
        self.requestJson = requestJson
        self.registrationJson = registrationJson
    }

    public func refresh(client: SyncularNativeJsonReading) {
        do {
            resultJson = try client.queryJson(requestJson: requestJson)
            refreshCount += 1
            lastError = nil
        } catch {
            lastError = error
        }
    }

    @discardableResult
    public func register(client: SyncularNativeJsonReading) -> String? {
        guard let registrationJson else { return nil }
        do {
            let id = try client.registerQueryJson(queryJson: registrationJson)
            queryId = id
            lastError = nil
            return id
        } catch {
            lastError = error
            return nil
        }
    }

    public func unregister(client: SyncularNativeJsonReading) {
        guard let queryId else { return }
        do {
            _ = try client.unregisterQuery(id: queryId)
            self.queryId = nil
            lastError = nil
        } catch {
            lastError = error
        }
    }

    public func observe(client: SyncularNativeJsonReading, capacity: UInt64 = 256) {
        stop()
        _ = register(client: client)
        isObserving = true
        refresh(client: client)
        let stream = client.eventJsonStream(capacity: capacity)
        task = Task { [weak self] in
            do {
                for try await eventJson in stream {
                    guard eventJson.contains("RowsChanged") || eventJson.contains("QueriesChanged") else { continue }
                    await MainActor.run {
                        self?.refresh(client: client)
                    }
                }
                await MainActor.run {
                    self?.isObserving = false
                }
            } catch {
                await MainActor.run {
                    self?.lastError = error
                    self?.isObserving = false
                }
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
        isObserving = false
    }
}
