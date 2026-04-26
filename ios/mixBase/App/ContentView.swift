import SwiftUI

// MARK: - ContentView
// Root view. Shows LoginView until authenticated, then the main tab navigation.

struct ContentView: View {

    @EnvironmentObject var authService: AuthService
    @EnvironmentObject var audioService: AudioService

    @State private var selectedTab = 0

    var body: some View {
        if authService.isAuthenticated {
            mainTabView
        } else {
            LoginView()
        }
    }

    // MARK: - Main Tab View
    private var mainTabView: some View {
        ZStack(alignment: .bottom) {
            TabView(selection: $selectedTab) {
                HomeView()
                    .tabItem { Image(systemName: "house"); Text("Home") }
                    .tag(0)

                ProjectsView()
                    .tabItem { Image(systemName: "square.grid.2x2"); Text("Projects") }
                    .tag(1)

                PlayerView()
                    .tabItem { Image(systemName: "play.circle"); Text("Player") }
                    .tag(2)

                PipelineView()
                    .tabItem { Image(systemName: "checklist"); Text("Pipeline") }
                    .tag(3)
            }
            .tint(Color(hex: "#2dd4bf"))
            .onAppear {
                let appearance = UITabBarAppearance()
                appearance.configureWithOpaqueBackground()
                appearance.backgroundColor = UIColor(Color(hex: "#0a0a0a"))
                UITabBar.appearance().standardAppearance = appearance
                UITabBar.appearance().scrollEdgeAppearance = appearance
            }

            if audioService.currentVersion != nil {
                VStack(spacing: 0) {
                    Spacer()
                    MiniPlayerView(onTap: { selectedTab = 2 })
                        .padding(.bottom, 49)
                }
            }
        }
    }
}

// MARK: - Color Hex Extension
extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let r = Double((int >> 16) & 0xFF) / 255.0
        let g = Double((int >> 8) & 0xFF) / 255.0
        let b = Double(int & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }
}
