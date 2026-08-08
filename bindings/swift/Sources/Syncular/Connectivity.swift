import Foundation

public protocol SyncularConnectivitySignal: AnyObject {
    var online: Bool { get }
    func subscribe(_ listener: @escaping (Bool) -> Void) -> () -> Void
}

/// Binds connectivity evidence to the client's offline lifecycle.
public final class SyncularConnectivityAdapter {
    private var unsubscribe: (() -> Void)?

    public init(client: SyncularClient, signal: SyncularConnectivitySignal) {
        signal.online ? client.resume() : client.pause()
        unsubscribe = signal.subscribe { [weak client] online in
            guard let client else { return }
            online ? client.resume() : client.pause()
        }
    }

    public func stop() {
        unsubscribe?()
        unsubscribe = nil
    }

    deinit {
        stop()
    }
}

#if canImport(Network)
import Network

/// `NWPathMonitor` implementation for iOS and macOS hosts.
public final class IOSPathConnectivitySignal: SyncularConnectivitySignal {
    private let monitor: NWPathMonitor
    private let lock = NSLock()
    private var listeners: [UUID: (Bool) -> Void] = [:]

    public var online: Bool { monitor.currentPath.status == .satisfied }

    public init(queue: DispatchQueue = DispatchQueue(label: "syncular.connectivity")) {
        monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            self.lock.lock()
            let callbacks = Array(self.listeners.values)
            self.lock.unlock()
            for callback in callbacks {
                callback(path.status == .satisfied)
            }
        }
        monitor.start(queue: queue)
    }

    public func subscribe(_ listener: @escaping (Bool) -> Void) -> () -> Void {
        let id = UUID()
        lock.lock()
        listeners[id] = listener
        lock.unlock()
        return { [weak self] in
            guard let self else { return }
            self.lock.lock()
            self.listeners.removeValue(forKey: id)
            self.lock.unlock()
        }
    }

    public func stop() {
        monitor.cancel()
        lock.lock()
        listeners.removeAll()
        lock.unlock()
    }

    deinit {
        stop()
    }
}
#endif
