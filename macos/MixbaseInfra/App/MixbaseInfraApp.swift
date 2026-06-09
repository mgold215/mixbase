import SwiftUI

@main
struct MixbaseInfraApp: App {
    @StateObject private var client: InfraAPIClient
    @StateObject private var auth: AuthViewModel
    @StateObject private var topo: TopologyViewModel

    init() {
        let c = InfraAPIClient()
        _client = StateObject(wrappedValue: c)
        _auth = StateObject(wrappedValue: AuthViewModel(client: c))
        _topo = StateObject(wrappedValue: TopologyViewModel(client: c))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(client)
                .environmentObject(auth)
                .environmentObject(topo)
                .preferredColorScheme(.dark)
        }
        .defaultSize(width: 1280, height: 800)
    }
}
