import SwiftUI

@main
struct mixBaseApp: App {

    @ObservedObject private var audioService = AudioService.shared
    @ObservedObject private var authService = AuthService.shared

    @Environment(\.scenePhase) private var scenePhase

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
