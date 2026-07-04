// A SwiftUI macOS todo window over syncular — a REAL window, no Xcode.
//
// This is a bundle-less SwiftPM executable: it boots NSApplication explicitly
// and hosts a SwiftUI view in an NSWindow via NSHostingView. That pattern
// compiles, links, AND presents a real titled window on a Command-Line-Tools-
// only mac (no full Xcode) — verified. A `.binaryTarget` xcframework build for
// a shipping .app is the release path (see the swift bindings README); this
// demo proves the wrapper drives a live SwiftUI list against a real server.
//
// The window: a todo list (query), an add field (mutate), per-row toggle
// (mutate), a Sync button (syncUntilIdle), a pending-count badge, and an
// event-driven refresh — the whole SyncularClient surface, ~150 lines.

import AppKit
import SwiftUI
import Syncular
import TodoKit

// MARK: - View model

@MainActor
final class TodoViewModel: ObservableObject {
    @Published var todos: [Todo] = []
    @Published var pending: Int = 0
    @Published var status: String = ""
    @Published var draft: String = ""

    private let store: TodoStore

    init() {
        let env = ProcessInfo.processInfo.environment
        let raw = env["SYNCULAR_URL"] ?? "http://localhost:8787"
        let baseURL = raw.isEmpty ? nil : raw
        let clientId = env["SYNCULAR_CLIENT_ID"] ?? "swift-ui-todo"
        do {
            store = try TodoStore(clientId: clientId, baseUrl: baseURL)
        } catch {
            fatalError("failed to start syncular: \(error)")
        }
        status = baseURL.map { "server \($0)" } ?? "offline"
        // A core event (e.g. sync-needed from a realtime push) refreshes the UI.
        store.onEvent { [weak self] _ in
            Task { @MainActor in self?.reload() }
        }
        reload()
    }

    func reload() {
        do {
            todos = try store.todos()
            pending = try store.pendingCount()
        } catch { status = "read error: \(error)" }
    }

    func add() {
        let title = draft.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return }
        draft = ""
        do { _ = try store.add(title) } catch { status = "add error: \(error)" }
        reload()
    }

    func toggle(_ id: String) {
        do { try store.toggle(id) } catch { status = "toggle error: \(error)" }
        reload()
    }

    func sync() {
        do {
            let ok = try store.sync()
            status = ok ? "synced" : "sync unavailable (offline / no transport)"
        } catch { status = "sync error: \(error)" }
        reload()
    }
}

// MARK: - View

struct TodoView: View {
    @ObservedObject var model: TodoViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Syncular Todos").font(.title2).bold()

            HStack {
                TextField("New todo…", text: $model.draft, onCommit: model.add)
                    .textFieldStyle(.roundedBorder)
                Button("Add", action: model.add)
            }

            List {
                ForEach(model.todos) { todo in
                    HStack {
                        Image(systemName: todo.done ? "checkmark.circle.fill" : "circle")
                            .foregroundColor(todo.done ? .green : .secondary)
                        Text(todo.title)
                            .strikethrough(todo.done)
                            .foregroundColor(todo.done ? .secondary : .primary)
                        Spacer()
                        Text(todo.id).font(.caption).foregroundColor(.secondary)
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { model.toggle(todo.id) }
                }
                if model.todos.isEmpty {
                    Text("No todos yet — add one above.").foregroundColor(.secondary)
                }
            }

            HStack {
                Button("Sync", action: model.sync)
                Spacer()
                Text("pending: \(model.pending)").foregroundColor(.secondary)
                Text(model.status).font(.caption).foregroundColor(.secondary)
            }
        }
        .padding()
        .frame(minWidth: 440, minHeight: 420)
    }
}

// MARK: - NSApplication bootstrap (bundle-less, CLT-friendly)

@main
enum TodoApp {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)

        let model = TodoViewModel()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 460),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Syncular Todos"
        window.contentView = NSHostingView(rootView: TodoView(model: model))
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        app.run()
    }
}
