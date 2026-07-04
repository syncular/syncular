rootProject.name = "syncular-kotlin"

// The todo example is a separate `application` module (bindings/kotlin/example)
// depending on the root wrapper project. It proves the wrapper drives a real
// terminal app; the CI smoke runs it against a live quickstart server.
include(":example")
