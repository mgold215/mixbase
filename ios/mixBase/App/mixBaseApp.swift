import SwiftUI

// MARK: - App Entry Point
// This is the main entry point for the mixBase iOS app.
// @main tells Swift this is where the app starts.

@main
struct mixBaseApp: App {

    // Reference the shared AudioService instance.
    // Using @ObservedObject since AudioService.shared is a singleton already managing its own lifecycle.
    @ObservedObject private var audioService = AudioService.shared

    var body: some Scene {
        WindowGroup {
            // ContentView is the root — it handles the password gate and main navigation.
            // .environmentObject makes audioService available to every child view.
            ContentView()
                .environmentObject(audioService)
        }
    }
}
