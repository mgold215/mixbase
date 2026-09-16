// mixBase Android — Gradle settings.
//
// Two modules:
//   :core — pure Kotlin/JVM. Models, the Supabase Auth + PostgREST + Storage
//           clients, the mixbase.app web-API client, and the display-name
//           parser. No Android dependency, so it builds and unit-tests
//           anywhere a JDK exists (including sandboxes that cannot reach the
//           Android SDK repository — see settings.core.gradle.kts).
//   :app  — the Jetpack Compose Android application.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "mixbase-android"
include(":core")
include(":app")
