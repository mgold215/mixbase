import SwiftUI

// MARK: - ContentView
// Root view. Shows LoginView until authenticated, then the main tab navigation.
// Tab layout mirrors the web app: Submit lives inside Pipeline (like the web's
// overflow menu), and Artwork is the media library tab (web's /media).

struct ContentView: View {

    @EnvironmentObject var authService: AuthService
    @EnvironmentObject var audioService: AudioService

    @State private var selectedTab = 0

    // Raised by the mixbase://new-project widget deep link; ProjectsView
    // consumes it and opens the New Project sheet.
    @State private var openNewProject = false

    // Raised by the widget's Tracks / Collections shortcuts; ProjectsView
    // consumes it and switches to that section (0 = Tracks, 1 = Collections).
    @State private var openProjectsSegment: Int?

    var body: some View {
        Group {
            if authService.isAuthenticated {
                mainTabView
            } else {
                LoginView()
            }
        }
        // Widget deep links (mixbase://player etc.) land on the right tab.
        // Safe to set even while logged out — the tab shows after login.
        .onOpenURL { url in
            guard url.scheme?.lowercased() == "mixbase" else { return }
            switch url.host?.lowercased() {
            case "home": selectedTab = 0
            case "projects": selectedTab = 1
            case "tracks":
                selectedTab = 1
                openProjectsSegment = 0
            case "collections":
                selectedTab = 1
                openProjectsSegment = 1
            case "player": selectedTab = 2
            case "artwork": selectedTab = 3
            case "pipeline": selectedTab = 4
            case "new-project":
                selectedTab = 1
                openNewProject = true
            case "mix-note":
                selectedTab = 2
                openMixNote(from: url)
            default: break
            }
        }
        // The app is dark by design. Without this, iOS renders system chrome
        // (nav bars, the floating tab bar, menus, sheets) in the device's
        // current appearance — which is why bars flipped black/white per tab.
        .preferredColorScheme(.dark)
        #if os(macOS)
        // Keep the five-tab layout from collapsing below a usable size.
        .frame(minWidth: 960, minHeight: 640)
        #endif
    }

    // MARK: - Widget "Mix Note"
    // mixbase://mix-note?project=<id>&version=<id> targets one upload; with no
    // ids it means "the mix that's playing", else the newest upload. The mix
    // is started if it isn't already up (notes stamp against the playhead),
    // then PlayerView opens the notes sheet for it.
    private func openMixNote(from url: URL) {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func param(_ name: String) -> UUID? {
            guard let value = items.first(where: { $0.name == name })?.value else { return nil }
            return UUID(uuidString: value)
        }

        var target: (project: UUID, version: UUID)?
        if let project = param("project"), let version = param("version") {
            target = (project, version)
        } else if let current = audioService.currentVersion {
            target = (current.projectId, current.id)
        } else if let newest = NowPlayingStore.loadRecentUploads()?.uploads.first {
            target = (newest.projectId, newest.versionId)
        }
        guard let target else { return }

        audioService.pendingMixNoteVersionId = target.version
        guard audioService.currentVersion?.id != target.version else { return }
        Task { @MainActor in
            guard let mix = await audioService.fetchOwnMix(projectId: target.project, versionId: target.version) else {
                audioService.pendingMixNoteVersionId = nil
                return
            }
            let (version, project) = mix
            audioService.play(
                version: version,
                trackName: project.title,
                artworkUrl: project.displayArtworkUrl,
                visualizerUrl: project.visualizerUrl
            )
        }
    }

    // MARK: - Main Tab View
    private var mainTabView: some View {
        ZStack(alignment: .bottom) {
            TabView(selection: $selectedTab) {
                HomeView(selectedTab: $selectedTab)
                    .tabItem { Image(systemName: "house"); Text("Home") }
                    .tag(0)

                ProjectsView(openNewProject: $openNewProject, openSegment: $openProjectsSegment)
                    .tabItem { Image(systemName: "square.grid.2x2"); Text("Projects") }
                    .tag(1)

                PlayerView()
                    .tabItem { Image(systemName: "play.circle"); Text("Player") }
                    .tag(2)

                ArtworkLibraryView()
                    .tabItem { Image(systemName: "photo.on.rectangle"); Text("Artwork") }
                    .tag(3)

                PipelineView()
                    .tabItem { Image(systemName: "checklist"); Text("Pipeline") }
                    .tag(4)
            }
            .tint(Color(hex: "#2dd4bf"))
            #if os(iOS)
            .onAppear {
                let appearance = UITabBarAppearance()
                appearance.configureWithOpaqueBackground()
                appearance.backgroundColor = UIColor(Color(hex: "#0a0a0a"))
                UITabBar.appearance().standardAppearance = appearance
                UITabBar.appearance().scrollEdgeAppearance = appearance
            }
            #endif

            // Mini player — floats above the tab bar on every tab except the
            // full Player, so leaving the Player "minimizes" playback the same
            // way the web app's mini bar does. Tap to reopen the full player.
            if audioService.currentVersion != nil && selectedTab != 2 {
                MiniPlayerBar(onTap: { selectedTab = 2 })
                    .padding(.horizontal, 8)
                    .padding(.bottom, miniPlayerBottomPadding)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.2), value: selectedTab)
        .animation(.easeOut(duration: 0.2), value: audioService.currentVersion?.id)
    }

    /// iOS floats the mini player above the bottom tab bar; macOS puts tabs at
    /// the top of the window, so the bar just needs a small inset from the edge.
    private var miniPlayerBottomPadding: CGFloat {
        #if os(iOS)
        54
        #else
        12
        #endif
    }
}

// MARK: - MiniPlayerBar
// Compact now-playing bar: artwork, title/version, play-pause. Mirrors the web
// app's MiniPlayer. A thin progress line runs along the top edge.

struct MiniPlayerBar: View {

    @EnvironmentObject var audioService: AudioService

    let onTap: () -> Void

    private var progress: CGFloat {
        guard audioService.duration > 0 else { return 0 }
        return CGFloat(audioService.currentTime / audioService.duration)
    }

    var body: some View {
        VStack(spacing: 0) {
            // Progress hairline
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Rectangle().fill(Color(hex: "#333333"))
                    Rectangle()
                        .fill(Color(hex: "#2dd4bf"))
                        .frame(width: geo.size.width * progress)
                }
            }
            .frame(height: 2)

            HStack(spacing: 10) {
                if let artworkUrl = audioService.currentArtworkUrl,
                   let url = URL(string: artworkUrl) {
                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        RoundedRectangle(cornerRadius: 6).fill(Color(hex: "#222222"))
                    }
                    .frame(width: 38, height: 38)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                } else {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color(hex: "#222222"))
                        .frame(width: 38, height: 38)
                        .overlay(Image(systemName: "music.note").font(.caption).foregroundColor(.gray))
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(audioService.currentTrackName ?? "Unknown Track")
                        .font(.footnote)
                        .fontWeight(.semibold)
                        .foregroundColor(Color(hex: "#f0f0f0"))
                        .lineLimit(1)
                    if let version = audioService.currentVersion {
                        Text(version.displayName)
                            .font(.caption2)
                            .foregroundColor(.gray)
                            .lineLimit(1)
                    }
                }

                Spacer()

                Button(action: { audioService.togglePlayPause() }) {
                    Image(systemName: audioService.isPlaying ? "pause.fill" : "play.fill")
                        .font(.body)
                        .foregroundColor(Color(hex: "#f0f0f0"))
                        .frame(width: 36, height: 36)
                }

                Button(action: { audioService.next() }) {
                    Image(systemName: "forward.end.fill")
                        .font(.footnote)
                        .foregroundColor(Color(hex: "#f0f0f0").opacity(0.7))
                        .frame(width: 30, height: 36)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
        }
        .background(Color(hex: "#161616").opacity(0.98))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(hex: "#f0f0f0").opacity(0.08), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.4), radius: 12, y: 4)
        .contentShape(Rectangle())
        .onTapGesture { onTap() }
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
