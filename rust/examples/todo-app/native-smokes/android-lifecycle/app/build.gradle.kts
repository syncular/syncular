plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "dev.syncular.smoke"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.syncular.smoke"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    sourceSets {
        getByName("main") {
            kotlin.directories.addAll(
                listOf(
                    "../../../../../bindings/kotlin/kotlin",
                    "../../../generated/kotlin/android",
                    "src/main/kotlin",
                ),
            )
            jniLibs.directories.add(
                "../../../../../../.context/native-smokes/android-lifecycle/jniLibs",
            )
        }
        getByName("androidTest") {
            kotlin.directories.add("src/androidTest/kotlin")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
}
