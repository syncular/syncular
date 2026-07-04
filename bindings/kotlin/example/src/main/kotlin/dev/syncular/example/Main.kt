package dev.syncular.example

/**
 * A terminal todo app over syncular — the Kotlin demo, mirroring the Swift
 * terminal app. It reads commands from stdin, so it drives interactively OR
 * from a piped script (the CI smoke pipes commands in).
 *
 * Commands (one per line):
 *   list            print the todos
 *   add <title>     add a todo
 *   toggle <id>     flip a todo's done flag
 *   sync            push local writes / pull remote (needs a server)
 *   pending         how many unsynced writes are queued
 *   quit            close and exit
 *
 * Point it at a server with SYNCULAR_URL (default http://localhost:8787);
 * unset/empty runs offline (mutations still queue and show).
 */
fun main() {
    val rawUrl = System.getenv("SYNCULAR_URL") ?: "http://localhost:8787"
    val baseUrl = rawUrl.ifEmpty { null }
    val clientId = System.getenv("SYNCULAR_CLIENT_ID") ?: "kotlin-terminal-todo"

    val store = TodoStore(clientId, baseUrl)
    println("syncular terminal todo — ${baseUrl?.let { "server $it" } ?: "offline"}")
    println("commands: list | add <title> | toggle <id> | sync | pending | quit")

    fun printTodos() {
        val todos = store.todos()
        if (todos.isEmpty()) { println("  (no todos yet)"); return }
        for (t in todos) println("  [${if (t.done) "x" else " "}] ${t.id}  ${t.title}")
    }

    generateSequence(::readLine).forEach { line ->
        val trimmed = line.trim()
        if (trimmed.isEmpty()) return@forEach
        val parts = trimmed.split(" ", limit = 2)
        val cmd = parts[0]
        val arg = parts.getOrNull(1)?.trim().orEmpty()
        try {
            when (cmd) {
                "list" -> printTodos()
                "add" -> if (arg.isEmpty()) println("usage: add <title>") else {
                    val t = store.add(arg); println("added ${t.id}: ${t.title}")
                }
                "toggle" -> if (arg.isEmpty()) println("usage: toggle <id>") else {
                    store.toggle(arg); println("toggled $arg")
                }
                "sync" -> println(if (store.sync()) "synced" else "sync unavailable (offline or no transport)")
                "pending" -> println("pending: ${store.pendingCount()}")
                "quit", "exit" -> { store.close(); println("bye"); return }
                else -> println("unknown: $cmd")
            }
        } catch (e: Exception) {
            println("error: ${e.message}")
        }
    }
    store.close()
}
