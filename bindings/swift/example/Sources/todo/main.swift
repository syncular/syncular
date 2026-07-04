// A terminal todo app over syncular — the scriptable, headless-friendly demo.
//
// Commands (one per line):
//   list            print the todos
//   add <title>     add a todo
//   toggle <id>     flip a todo's done flag
//   sync            push local writes / pull remote (needs a server)
//   pending         how many unsynced writes are queued
//   quit            close and exit
//
// It reads commands from stdin, so it drives interactively OR from a piped
// script (the CI smoke and the local end-to-end proof both pipe commands in).
// Point it at a server with SYNCULAR_URL (default http://localhost:8787);
// unset/empty runs offline (mutations still queue and show).

import Foundation
import Syncular
import TodoKit

let baseURLEnv = ProcessInfo.processInfo.environment["SYNCULAR_URL"] ?? "http://localhost:8787"
let baseURL = baseURLEnv.isEmpty ? nil : baseURLEnv
let clientId = ProcessInfo.processInfo.environment["SYNCULAR_CLIENT_ID"] ?? "swift-terminal-todo"

func printTodos(_ store: TodoStore) throws {
    let todos = try store.todos()
    if todos.isEmpty { print("  (no todos yet)"); return }
    for t in todos {
        print("  [\(t.done ? "x" : " ")] \(t.id)  \(t.title)")
    }
}

let store: TodoStore
do {
    store = try TodoStore(clientId: clientId, baseUrl: baseURL)
} catch {
    FileHandle.standardError.write("failed to start: \(error)\n".data(using: .utf8)!)
    exit(1)
}

print("syncular terminal todo — \(baseURL.map { "server \($0)" } ?? "offline")")
print("commands: list | add <title> | toggle <id> | sync | pending | quit")

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { continue }
    let parts = trimmed.split(separator: " ", maxSplits: 1).map(String.init)
    let cmd = parts[0]
    let arg = parts.count > 1 ? parts[1] : ""
    do {
        switch cmd {
        case "list":
            try printTodos(store)
        case "add":
            guard !arg.isEmpty else { print("usage: add <title>"); break }
            let t = try store.add(arg)
            print("added \(t.id): \(t.title)")
        case "toggle":
            guard !arg.isEmpty else { print("usage: toggle <id>"); break }
            try store.toggle(arg)
            print("toggled \(arg)")
        case "sync":
            let ok = try store.sync()
            print(ok ? "synced" : "sync unavailable (offline or no transport)")
        case "pending":
            print("pending: \(try store.pendingCount())")
        case "quit", "exit":
            store.close()
            print("bye")
            exit(0)
        default:
            print("unknown: \(cmd)")
        }
    } catch let e as SyncularError {
        print("error(\(e.code)): \(e.message)")
    } catch {
        print("error: \(error)")
    }
}
store.close()
