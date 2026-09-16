// Root build file — intentionally empty of plugin declarations. Plugins are
// applied per module via the version catalog, so the core-only settings file
// (settings.core.gradle.kts) never has to resolve the Android Gradle Plugin.
tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
