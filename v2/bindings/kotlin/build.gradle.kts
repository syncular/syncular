// The Kotlin/JVM syncular bindings — an idiomatic wrapper over the syncular-ffi
// C core via FFM (java.lang.foreign, JDK 21+): ZERO native-glue code, no JNI C
// shim. This is a SEPARATE Gradle project, isolated from the main workspaces
// exactly like bindings/tauri — it never joins `bun run check` / the main cargo
// gate. Its own gate is `./check.sh`.
//
// The wrapper compiles JVM-neutral (no Android SDK dependency), so it packages
// for both a plain JVM host and Android (AAR + jniLibs via cargo-ndk); the
// Android consumption path is documented in README.md.

plugins {
    kotlin("jvm") version "1.9.24"
}

repositories {
    mavenCentral()
}

kotlin {
    jvmToolchain(21) // FFM (java.lang.foreign) is stable from JDK 22, preview in 21.
}

dependencies {
    testImplementation(kotlin("test"))
}

// The vendored native library path (check.sh builds + copies it into vendor/).
// Passed to tests via the `syncular.library.path` system property so the FFM
// SymbolLookup loads exactly that dylib without touching java.library.path.
val vendoredLib: String? =
    listOf("libsyncular.dylib", "libsyncular.so", "syncular.dll")
        .map { file("vendor/$it") }
        .firstOrNull { it.exists() }
        ?.absolutePath

tasks.test {
    useJUnitPlatform()
    // FFM downcalls require native access to be enabled on the module/classpath.
    jvmArgs("--enable-native-access=ALL-UNNAMED")
    // On JDK 21 FFM is a preview feature; on 22+ these flags are ignored/benign.
    jvmArgs("--enable-preview")
    vendoredLib?.let { systemProperty("syncular.library.path", it) }
}

// FFM preview needs the flag at compile time on JDK 21; harmless on 22+.
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
    compilerOptions {
        freeCompilerArgs.add("-Xjvm-enable-preview")
    }
}
