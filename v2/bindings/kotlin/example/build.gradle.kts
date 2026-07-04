// The syncular Kotlin todo example — a terminal app over the SyncularClient
// wrapper (the root project), talking to the quickstart server's `notes` table.
// It runs as a Gradle `application` module so `gradle :example:run` drives it;
// the CI smoke pipes a scripted stdin at it against a live quickstart server.
//
// Local reality: the wrapper's gate detect-and-skips without a JDK, so this
// example proves in CI (the swift-kotlin-bindings job). Nothing here needs a
// GUI — it is a terminal app, deterministic under piped stdin.

plugins {
    kotlin("jvm") version "1.9.24"
    application
}

repositories {
    mavenCentral()
}

kotlin {
    jvmToolchain(21) // FFM (java.lang.foreign): preview in 21, stable in 22.
}

dependencies {
    implementation(project(":")) // the SyncularClient wrapper (root project)
}

application {
    mainClass.set("dev.syncular.example.MainKt")
    // FFM downcalls need native access enabled; preview flag on JDK 21 (benign 22+).
    applicationDefaultJvmArgs = listOf("--enable-native-access=ALL-UNNAMED", "--enable-preview")
}

// The vendored native library path (check.sh builds + copies it into the root
// project's vendor/). Passed to the running app via `syncular.library.path` so
// the FFM SymbolLookup loads exactly that dylib without touching
// java.library.path.
val vendoredLib: String? =
    listOf("libsyncular.dylib", "libsyncular.so", "syncular.dll")
        .map { rootProject.file("vendor/$it") }
        .firstOrNull { it.exists() }
        ?.absolutePath

tasks.named<JavaExec>("run") {
    // Forward stdin so the app's readLine loop drives interactively / piped.
    standardInput = System.`in`
    vendoredLib?.let { systemProperty("syncular.library.path", it) }
}

// FFM preview needs the flag at compile time on JDK 21; harmless on 22+.
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
    compilerOptions {
        freeCompilerArgs.add("-Xjvm-enable-preview")
    }
}
