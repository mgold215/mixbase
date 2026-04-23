import SwiftUI

@main
struct mixBaseApp: App {

    @ObservedObject private var audioService = AudioService.shared
    @ObservedObject private var authService = AuthService.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(audioService)
                .environmentObject(authService)
        }
    }
}
