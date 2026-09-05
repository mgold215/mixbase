import SwiftUI

@main
struct mixBaseApp: App {

    @ObservedObject private var audioService = AudioService.shared
    @ObservedObject private var authService = AuthService.shared

    @Environment(\.scenePhase) private var scenePhase

    init() {
        // The Now Playing widget's play/pause button executes in THIS process
        // (AudioPlaybackIntent background-launches the app if needed); the
        // intent itself can't see AudioService — it's not compiled into the
        // widget target — so it calls through this hook.
        PlayPauseWidgetIntent.performer = {
            AudioService.shared.handleWidgetPlayPause()
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(audioService)
                .environmentObject(authService)
        }
        .onChange(of: scenePhase) { _, newPhase in
            // Returning to the foreground after the app was backgrounded for a
            // while: top up the access token if it expired so the next request
            // doesn't 401 and bounce the user to login.
            if newPhase == .active {
                Task { await authService.ensureFreshToken() }
            }
        }
    }
}
