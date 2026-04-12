import SwiftUI

// MARK: - ContentView
// The root view of the app. It shows a password gate first,
// and once authenticated, displays the main tab navigation.

struct ContentView: View {

    // Access the shared audio service so MiniPlayerView can observe playback state
    @EnvironmentObject var audioService: AudioService

    // Track whether the user has passed the password gate
    @State private var isAuthenticated = false

    // The password the user types in
    @State private var passwordInput = ""

    // Show an error message if the password is wrong
    @State private var showError = false

    // Which tab is currently selected (0 = Home, 1 = Projects, 2 = Player, 3 = Pipeline)
    @State private var selectedTab = 0

    var body: some View {
        // If not authenticated, show the password gate; otherwise show the main app
        if isAuthenticated {
            mainTabView
        } else {
            passwordGateView
        }
    }

    // MARK: - Password Gate
    // A simple login screen with a text field and submit button.
    // Compares the input against Config.appPassword.
    private var passwordGateView: some View {
        ZStack {
            // Dark background fills the entire screen
            Color(hex: "#080808")
                .ignoresSafeArea()

            VStack(spacing: 24) {
                Spacer()

                // App title / branding
                Text("mixBase")
                    .font(.system(size: 36, weight: .bold))
                    .foregroundColor(Color(hex: "#2dd4bf"))

                Text("ROUGH-TO-RELEASE")
                    .font(.caption)
                    .foregroundColor(Color(hex: "#f0f0f0").opacity(0.3))
                    .textCase(.uppercase)
                    .tracking(2)

                // Password input field
                SecureField("Enter password", text: $passwordInput)
                    .textFieldStyle(.plain)
                    .padding()
                    .background(Color(hex: "#161616"))
                    .cornerRadius(10)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .padding(.horizontal, 40)

                // Show error text if password was wrong
                if showError {
                    Text("Incorrect password")
                        .font(.caption)
                        .foregroundColor(.red)
                }

                // Submit button
                Button(action: authenticate) {
                    Text("Enter")
                        .font(.headline)
                        .foregroundColor(Color(hex: "#080808"))
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color(hex: "#2dd4bf"))
                        .cornerRadius(10)
                }
                .padding(.horizontal, 40)

                Spacer()
                Spacer()
            }
        }
    }

    // MARK: - Main Tab View
    // The primary navigation after login. Uses a ZStack to layer the mini player
    // above the tab content but below the tab bar.
    private var mainTabView: some View {
        ZStack(alignment: .bottom) {
            // Tab bar with 4 tabs
            TabView(selection: $selectedTab) {
                HomeView()
                    .tabItem {
                        Image(systemName: "house")
                        Text("Home")
                    }
                    .tag(0)

                ProjectsView()
                    .tabItem {
                        Image(systemName: "square.grid.2x2")
                        Text("Projects")
                    }
                    .tag(1)

                PlayerView()
                    .tabItem {
                        Image(systemName: "play.circle")
                        Text("Player")
                    }
                    .tag(2)

                PipelineView()
                    .tabItem {
                        Image(systemName: "checklist")
                        Text("Pipeline")
                    }
                    .tag(3)
            }
            // Style the tab bar with dark background and teal accent
            .tint(Color(hex: "#2dd4bf"))
            .onAppear {
                // Customize the tab bar appearance globally
                let tabBarAppearance = UITabBarAppearance()
                tabBarAppearance.configureWithOpaqueBackground()
                tabBarAppearance.backgroundColor = UIColor(Color(hex: "#0a0a0a"))
                UITabBar.appearance().standardAppearance = tabBarAppearance
                UITabBar.appearance().scrollEdgeAppearance = tabBarAppearance
            }

            // Mini player sits above the tab bar (only visible when something is playing)
            if audioService.currentVersion != nil {
                VStack(spacing: 0) {
                    Spacer()
                    MiniPlayerView(onTap: {
                        // Switch to the Player tab when the mini player is tapped
                        selectedTab = 2
                    })
                    // Offset up to sit above the tab bar (~49pt is standard tab bar height)
                    .padding(.bottom, 49)
                }
            }
        }
    }

    // MARK: - Authenticate
    // Check the entered password against the stored app password
    private func authenticate() {
        if passwordInput == Config.appPassword {
            isAuthenticated = true
            showError = false
        } else {
            showError = true
        }
    }
}

// MARK: - Color Hex Extension
// Lets us write Color(hex: "#2dd4bf") instead of specifying RGB values manually.
extension Color {
    init(hex: String) {
        // Strip the "#" prefix if present
        let hex = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        // Parse the hex string into a 32-bit integer
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let r, g, b: Double
        // Extract red, green, blue channels (8 bits each)
        r = Double((int >> 16) & 0xFF) / 255.0
        g = Double((int >> 8) & 0xFF) / 255.0
        b = Double(int & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }
}
