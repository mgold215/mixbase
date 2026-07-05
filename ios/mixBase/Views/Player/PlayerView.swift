import SwiftUI
import AVKit
import MediaPlayer

// MARK: - AirPlayRoutePicker
// The native output-device picker (HomePod, Sonos, AirPods, car…). Wrapping
// AVRoutePickerView is the supported way to offer AirPlay from inside the app —
// routing itself is handled by the audio session (see AudioService).
struct AirPlayRoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.prioritizesVideoDevices = false
        view.backgroundColor = .clear
        view.tintColor = UIColor(red: 0xF0 / 255, green: 0xF0 / 255, blue: 0xF0 / 255, alpha: 1)
        view.activeTintColor = UIColor(red: 0x2D / 255, green: 0xD4 / 255, blue: 0xBF / 255, alpha: 1)
        return view
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}

// MARK: - SystemVolumeSlider
// Wraps MPVolumeView so the in-app slider controls the *real* device volume
// (and stays in sync when the user presses the hardware buttons). The route
// button is hidden — AirPlay already lives in the nav bar — so this reads as a
// clean, single-purpose volume control tinted to the mixBase teal.
struct SystemVolumeSlider: UIViewRepresentable {
    func makeUIView(context: Context) -> MPVolumeView {
        let volumeView = MPVolumeView()
        volumeView.showsRouteButton = false
        volumeView.tintColor = UIColor(red: 0x2D / 255, green: 0xD4 / 255, blue: 0xBF / 255, alpha: 1)
        return volumeView
    }

    func updateUIView(_ uiView: MPVolumeView, context: Context) {}
}

// MARK: - WaveformScrubber
// A stylized waveform-style progress bar. Each track gets its own stable set of
// bar heights derived deterministically from its version id, so it *looks* like
// an audio waveform without decoding the file on-device. Bars up to the current
// position glow teal; the rest sit dim. Dragging anywhere seeks.
struct WaveformScrubber: View {
    let progress: CGFloat            // 0…1 playback position
    let seed: UUID                   // stable per-track shape
    let onSeek: (CGFloat) -> Void    // fraction 0…1

    private let barCount = 56

    var body: some View {
        GeometryReader { geo in
            let heights = Self.samples(for: seed, count: barCount)
            let spacing: CGFloat = 3
            let barWidth = max(1.5, (geo.size.width - spacing * CGFloat(barCount - 1)) / CGFloat(barCount))

            HStack(alignment: .center, spacing: spacing) {
                ForEach(0..<barCount, id: \.self) { i in
                    let filled = CGFloat(i) / CGFloat(barCount) <= progress
                    Capsule()
                        .fill(filled
                              ? AnyShapeStyle(LinearGradient(
                                    colors: [Color(hex: "#2dd4bf"), Color(hex: "#2dd4bf").opacity(0.6)],
                                    startPoint: .top, endPoint: .bottom))
                              : AnyShapeStyle(Color(hex: "#f0f0f0").opacity(0.14)))
                        .frame(width: barWidth,
                               height: max(3, geo.size.height * heights[i]))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .center)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let fraction = max(0, min(1, value.location.x / geo.size.width))
                        onSeek(fraction)
                    }
            )
        }
        .frame(height: 44)
    }

    // Deterministic bar heights (0.2…1.0) from the 16 bytes of the track's UUID —
    // stable across launches so a track's waveform never "jumps around".
    static func samples(for id: UUID, count: Int) -> [CGFloat] {
        let bytes = withUnsafeBytes(of: id.uuid) { Array($0) }
        return (0..<count).map { i in
            let a = Int(bytes[i % 16])
            let b = Int(bytes[(i * 7 + 3) % 16])
            let raw = CGFloat((a ^ (b << 1)) & 0xFF) / 255.0
            return 0.2 + 0.8 * pow(raw, 0.7)
        }
    }
}

// MARK: - PlayerView
// A focused "Now Playing" screen. The track's artwork bleeds into a soft, blurred
// ambient backdrop so the whole surface feels alive instead of flat black. Below
// the artwork: title/version, a waveform scrubber, transport controls, a volume
// slider, and quick Share + queue access.
struct PlayerView: View {

    @EnvironmentObject var audioService: AudioService

    // All projects with their latest version. Powers the queue sheet + seeds the
    // shared playback queue in AudioService (which owns next/prev/loop/shuffle now).
    @State private var trackList: [TrackItem] = []
    @State private var allVersions: [Version] = []
    @State private var isLoading = true

    // Queue sheet
    @State private var showQueue = false

    var body: some View {
        NavigationStack {
            ZStack {
                // Base + ambient artwork backdrop
                Color(hex: "#080808").ignoresSafeArea()
                ambientBackdrop

                if let version = audioService.currentVersion {
                    nowPlayingScreen(version: version)
                } else {
                    emptyState
                }
            }
            .navigationTitle(audioService.currentVersion != nil ? "Now Playing" : "Player")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    AirPlayRoutePicker()
                        .frame(width: 28, height: 28)
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: { showQueue = true }) {
                        Image(systemName: "list.bullet")
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }
                }
            }
            .task {
                await loadAllTracks()
            }
            .sheet(isPresented: $showQueue) {
                QueueSheet(
                    trackList: trackList,
                    isLoading: isLoading,
                    onSelect: { item in
                        audioService.play(
                            version: item.latestVersion,
                            trackName: item.project.title,
                            artworkUrl: item.project.artworkUrl
                        )
                        showQueue = false
                    }
                )
            }
        }
    }

    // MARK: - Ambient Backdrop
    // Blurred, over-scaled artwork behind everything, faded into black. This is the
    // single biggest "premium not cheap" upgrade — the screen takes on the colour of
    // whatever is playing, like Apple Music / Spotify's now-playing surface.
    @ViewBuilder
    private var ambientBackdrop: some View {
        if let artworkUrl = audioService.currentArtworkUrl,
           let url = URL(string: artworkUrl) {
            GeometryReader { geo in
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: geo.size.width, height: geo.size.height)
                        .clipped()
                        .blur(radius: 70)
                        .opacity(0.55)
                } placeholder: {
                    Color.clear
                }
            }
            .ignoresSafeArea()
            .overlay(
                LinearGradient(
                    colors: [
                        Color(hex: "#080808").opacity(0.35),
                        Color(hex: "#080808").opacity(0.85),
                        Color(hex: "#080808")
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .ignoresSafeArea()
            )
            .animation(.easeInOut(duration: 0.6), value: audioService.currentArtworkUrl)
        }
    }

    // MARK: - Now Playing Screen
    @ViewBuilder
    private func nowPlayingScreen(version: Version) -> some View {
        VStack(spacing: 0) {
            Spacer(minLength: 12)

            // Artwork — large, centered, with a soft teal glow
            artworkImage
                .padding(.horizontal, 44)

            Spacer(minLength: 28)

            // Track title + version info
            VStack(spacing: 8) {
                Text(audioService.currentTrackName ?? "Unknown Track")
                    .font(.title2)
                    .fontWeight(.bold)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .lineLimit(1)

                HStack(spacing: 6) {
                    Text("v\(version.versionNumber)")
                        .fontWeight(.semibold)
                    if let label = version.label, !label.isEmpty {
                        Text("· \(label)")
                    }
                    StatusBadge(status: version.status)
                }
                .font(.caption)
                .foregroundColor(Color(hex: "#2dd4bf"))
            }
            .padding(.horizontal, 24)

            // Version switcher pills (only when there's more than one version)
            if allVersions.count > 1 {
                versionSwitcher
                    .padding(.top, 14)
            }

            Spacer(minLength: 24)

            // Waveform scrubber + time
            VStack(spacing: 6) {
                WaveformScrubber(
                    progress: playbackProgress,
                    seed: version.id,
                    onSeek: { fraction in
                        audioService.seek(to: Double(fraction) * audioService.duration)
                    }
                )
                HStack {
                    Text(formatTime(audioService.currentTime))
                    Spacer()
                    Text("-\(formatTime(max(0, audioService.duration - audioService.currentTime)))")
                }
                .font(.caption2)
                .foregroundColor(Color(hex: "#f0f0f0").opacity(0.5))
            }
            .padding(.horizontal, 28)

            // Transport controls
            playbackControls
                .padding(.top, 22)

            // Volume + Share row
            bottomBar
                .padding(.top, 24)
                .padding(.horizontal, 32)

            Spacer(minLength: 32)
        }
        // Reload versions when the playing project changes (for the switcher)
        .task(id: version.projectId) {
            await loadVersionsForCurrentProject(projectId: version.projectId)
        }
    }

    // MARK: - Bottom Bar (volume + share)
    private var bottomBar: some View {
        HStack(spacing: 16) {
            Image(systemName: "speaker.fill")
                .font(.caption)
                .foregroundColor(Color(hex: "#f0f0f0").opacity(0.4))

            SystemVolumeSlider()
                .frame(height: 28)

            Image(systemName: "speaker.wave.3.fill")
                .font(.caption)
                .foregroundColor(Color(hex: "#f0f0f0").opacity(0.4))

            ShareLink(item: shareURL) {
                Image(systemName: "square.and.arrow.up")
                    .font(.body)
                    .foregroundColor(Color(hex: "#2dd4bf"))
            }
        }
    }

    // The private listening link for the current version, matching the web app's
    // /share/<token> route. Falls back to the mixBase site if a track has no token.
    private var shareURL: URL {
        if let token = audioService.currentVersion?.shareToken,
           !token.isEmpty,
           let url = URL(string: "https://mixbase.app/share/\(token)") {
            return url
        }
        return URL(string: "https://mixbase.app")!
    }

    // MARK: - Empty State
    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "music.note")
                .font(.system(size: 56))
                .foregroundColor(.gray.opacity(0.3))

            Text("Nothing playing")
                .font(.headline)
                .foregroundColor(Color(hex: "#f0f0f0"))

            Text("Pick a track to start listening")
                .font(.subheadline)
                .foregroundColor(.gray)

            Button(action: { showQueue = true }) {
                HStack(spacing: 8) {
                    Image(systemName: "list.bullet")
                    Text("Browse Tracks")
                        .fontWeight(.semibold)
                }
                .foregroundColor(Color(hex: "#080808"))
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .background(Color(hex: "#2dd4bf"))
                .clipShape(Capsule())
            }
            .padding(.top, 8)
        }
        .padding()
    }

    // MARK: - Artwork Image
    private var artworkImage: some View {
        Group {
            if let artworkUrl = audioService.currentArtworkUrl,
               let url = URL(string: artworkUrl) {
                AsyncImage(url: url) { image in
                    image.resizable().aspectRatio(contentMode: .fit)
                } placeholder: {
                    artworkPlaceholder
                }
                .clipShape(RoundedRectangle(cornerRadius: 20))
                .shadow(color: Color(hex: "#2dd4bf").opacity(0.25), radius: 30, y: 10)
                .shadow(color: .black.opacity(0.6), radius: 24, y: 16)
            } else {
                artworkPlaceholder
                    .shadow(color: .black.opacity(0.5), radius: 24, y: 12)
            }
        }
    }

    private var artworkPlaceholder: some View {
        RoundedRectangle(cornerRadius: 20)
            .fill(
                LinearGradient(
                    colors: [Color(hex: "#1a1a1a"), Color(hex: "#111111")],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .aspectRatio(1, contentMode: .fit)
            .overlay(
                Image(systemName: "music.note")
                    .font(.system(size: 48))
                    .foregroundColor(.gray.opacity(0.3))
            )
    }

    // MARK: - Playback Controls
    private var playbackControls: some View {
        HStack(spacing: 36) {
            // Shuffle (state lives in AudioService so it applies everywhere)
            Button(action: { audioService.isShuffled.toggle() }) {
                Image(systemName: "shuffle")
                    .font(.body)
                    .foregroundColor(audioService.isShuffled ? Color(hex: "#2dd4bf") : Color(hex: "#f0f0f0").opacity(0.5))
            }

            Button(action: { audioService.prev() }) {
                Image(systemName: "backward.end.fill")
                    .font(.title3)
                    .foregroundColor(Color(hex: "#f0f0f0"))
            }

            Button(action: { audioService.togglePlayPause() }) {
                Group {
                    if audioService.buffering {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: Color(hex: "#080808")))
                    } else {
                        Image(systemName: audioService.isPlaying ? "pause.fill" : "play.fill")
                            .font(.title2)
                            .foregroundColor(Color(hex: "#080808"))
                    }
                }
                .frame(width: 68, height: 68)
                .background(Color(hex: "#2dd4bf"))
                .clipShape(Circle())
                .shadow(color: Color(hex: "#2dd4bf").opacity(0.4), radius: 16, y: 4)
            }

            Button(action: { audioService.next() }) {
                Image(systemName: "forward.end.fill")
                    .font(.title3)
                    .foregroundColor(Color(hex: "#f0f0f0"))
            }

            // Loop (off → all → one)
            Button(action: { audioService.loopMode = nextLoopMode(audioService.loopMode) }) {
                Image(systemName: audioService.loopMode == .one ? "repeat.1" : "repeat")
                    .font(.body)
                    .foregroundColor(audioService.loopMode != .off ? Color(hex: "#2dd4bf") : Color(hex: "#f0f0f0").opacity(0.5))
            }
        }
    }

    // MARK: - Version Switcher
    private var versionSwitcher: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(allVersions.sorted(by: { $0.versionNumber < $1.versionNumber })) { version in
                    Button(action: {
                        audioService.play(
                            version: version,
                            trackName: audioService.currentTrackName ?? "Unknown",
                            artworkUrl: audioService.currentArtworkUrl
                        )
                    }) {
                        Text("v\(version.versionNumber)")
                            .font(.caption2)
                            .fontWeight(.semibold)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .foregroundColor(
                                isCurrentVersion(version)
                                    ? Color(hex: "#080808")
                                    : Color(hex: "#f0f0f0")
                            )
                            .background(
                                isCurrentVersion(version)
                                    ? Color(hex: "#2dd4bf")
                                    : Color(hex: "#f0f0f0").opacity(0.08)
                            )
                            .clipShape(Capsule())
                    }
                }
            }
            .padding(.horizontal, 24)
        }
    }

    // MARK: - Helpers

    private var playbackProgress: CGFloat {
        guard audioService.duration > 0 else { return 0 }
        return CGFloat(audioService.currentTime / audioService.duration)
    }

    private func isCurrentVersion(_ version: Version) -> Bool {
        audioService.currentVersion?.id == version.id
    }

    private func formatTime(_ time: Double) -> String {
        let totalSeconds = Int(time)
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return String(format: "%d:%02d", minutes, seconds)
    }

    // Cycle the shared loop mode: off → all → one → off
    private func nextLoopMode(_ mode: LoopMode) -> LoopMode {
        switch mode {
        case .off: return .all
        case .all: return .one
        case .one: return .off
        }
    }

    // MARK: - Data Loading

    // Load all projects + their latest versions, then publish them as the shared queue
    // so next/prev/auto-advance (which live in AudioService) follow this order on every tab.
    private func loadAllTracks() async {
        isLoading = true
        do {
            let projects = try await SupabaseService.shared.fetchProjects()
            var items: [TrackItem] = []

            for project in projects {
                let versions = try await SupabaseService.shared.fetchVersions(projectId: project.id)
                if let latest = versions.max(by: { $0.versionNumber < $1.versionNumber }) {
                    items.append(TrackItem(
                        project: project,
                        latestVersion: latest,
                        versionCount: versions.count
                    ))
                }
            }

            trackList = items
            audioService.setQueue(items.map {
                QueueItem(
                    projectId: $0.project.id,
                    version: $0.latestVersion,
                    trackName: $0.project.title,
                    artworkUrl: $0.project.artworkUrl
                )
            })
        } catch {
            print("PlayerView: Failed to load tracks — \(error.localizedDescription)")
        }
        isLoading = false
    }

    // Load versions for the currently playing project (for version switcher)
    private func loadVersionsForCurrentProject(projectId: UUID) async {
        do {
            allVersions = try await SupabaseService.shared.fetchVersions(projectId: projectId)
        } catch {
            print("PlayerView: Failed to load versions — \(error.localizedDescription)")
        }
    }
}

// MARK: - QueueSheet
// "Up Next" — a searchable list of every track. Tapping one plays it and
// dismisses the sheet. This keeps browsing out of the main player surface.
struct QueueSheet: View {

    @EnvironmentObject var audioService: AudioService
    @Environment(\.dismiss) private var dismiss

    let trackList: [TrackItem]
    let isLoading: Bool
    let onSelect: (TrackItem) -> Void

    @State private var searchText = ""

    private var filteredTrackList: [TrackItem] {
        if searchText.isEmpty { return trackList }
        return trackList.filter {
            $0.project.title.localizedCaseInsensitiveContains(searchText) ||
            ($0.project.genre?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808").ignoresSafeArea()

                if isLoading {
                    ProgressView()
                        .tint(Color(hex: "#2dd4bf"))
                } else if trackList.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "music.note.list")
                            .font(.system(size: 36))
                            .foregroundColor(.gray.opacity(0.3))
                        Text("No tracks yet")
                            .font(.subheadline)
                            .foregroundColor(.gray)
                    }
                } else {
                    ScrollView {
                        // Search bar
                        HStack {
                            Image(systemName: "magnifyingglass")
                                .foregroundColor(.gray)
                            TextField("Search tracks...", text: $searchText)
                                .foregroundColor(Color(hex: "#f0f0f0"))
                            if !searchText.isEmpty {
                                Button(action: { searchText = "" }) {
                                    Image(systemName: "xmark.circle.fill")
                                        .foregroundColor(.gray)
                                }
                            }
                        }
                        .padding(8)
                        .background(Color(hex: "#111111"))
                        .cornerRadius(8)
                        .padding(.horizontal)
                        .padding(.top, 8)

                        LazyVStack(spacing: 2) {
                            ForEach(filteredTrackList) { item in
                                trackRow(item: item)
                            }
                        }
                        .padding(.top, 4)
                    }
                }
            }
            .navigationTitle("Up Next")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }
            }
        }
    }

    // MARK: - Track Row
    @ViewBuilder
    private func trackRow(item: TrackItem) -> some View {
        Button(action: { onSelect(item) }) {
            HStack(spacing: 12) {
                ZStack {
                    if let artworkUrl = item.project.artworkUrl,
                       let url = URL(string: artworkUrl) {
                        AsyncImage(url: url) { image in
                            image.resizable().aspectRatio(contentMode: .fill)
                        } placeholder: {
                            RoundedRectangle(cornerRadius: 8)
                                .fill(Color(hex: "#1a1a1a"))
                        }
                        .frame(width: 50, height: 50)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    } else {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(Color(hex: "#1a1a1a"))
                            .frame(width: 50, height: 50)
                            .overlay(
                                Image(systemName: "music.note")
                                    .foregroundColor(.gray.opacity(0.4))
                                    .font(.caption)
                            )
                    }

                    if isCurrentlyPlaying(item) {
                        Circle()
                            .fill(Color(hex: "#2dd4bf").opacity(0.85))
                            .frame(width: 28, height: 28)
                            .overlay(
                                Image(systemName: audioService.isPlaying ? "waveform" : "pause.fill")
                                    .font(.system(size: 10))
                                    .foregroundColor(.white)
                            )
                    }
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text(item.project.title)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(
                            isCurrentlyPlaying(item)
                                ? Color(hex: "#2dd4bf")
                                : Color(hex: "#f0f0f0")
                        )
                        .lineLimit(1)

                    HStack(spacing: 6) {
                        Text("v\(item.latestVersion.versionNumber)")
                        if let genre = item.project.genre {
                            Text(genre)
                        }
                        if let bpm = item.project.bpm {
                            Text("\(bpm) BPM")
                                .foregroundColor(.gray.opacity(0.6))
                        }
                    }
                    .font(.caption2)
                    .foregroundColor(.gray)
                }

                Spacer()

                StatusBadge(status: item.latestVersion.status)
            }
            .padding(.horizontal)
            .padding(.vertical, 10)
            .background(
                isCurrentlyPlaying(item)
                    ? Color(hex: "#2dd4bf").opacity(0.05)
                    : Color.clear
            )
        }
        .buttonStyle(.plain)
    }

    private func isCurrentlyPlaying(_ item: TrackItem) -> Bool {
        guard let current = audioService.currentVersion else { return false }
        return current.projectId == item.project.id
    }
}

// MARK: - TrackItem
// A helper struct that pairs a project with its latest version for the track list.
struct TrackItem: Identifiable {
    let project: Project
    let latestVersion: Version
    let versionCount: Int

    var id: UUID { project.id }
}
