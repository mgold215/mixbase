// Core-only settings file: builds and tests the :core module WITHOUT touching
// the Android Gradle Plugin. Use it where dl.google.com is unreachable (the
// remote Claude sandbox) or when you only want the fast JVM tests:
//
//   gradle -c settings.core.gradle.kts :core:test
//
// Same version catalog (gradle/libs.versions.toml) as the full build, so the
// two can never drift.
pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
    }
}

rootProject.name = "mixbase-android"
include(":core")
