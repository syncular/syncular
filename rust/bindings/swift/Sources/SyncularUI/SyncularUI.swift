import Combine
import Foundation
import SwiftUI
import Syncular

public protocol SyncularEventJsonStreaming {
    func eventJsonStream(capacity: UInt64) -> AsyncThrowingStream<String, Error>
}

extension SyncularBoltClient: SyncularEventJsonStreaming {}

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
