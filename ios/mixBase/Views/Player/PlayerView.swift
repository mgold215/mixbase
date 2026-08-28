import SwiftUI
import AVKit

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
// the artwork: title/version, a waveform scrubber, and transport controls. Share
// and the editable "Up Next" queue live in the nav bar so the surface stays clean.
struct PlayerView: View {

    @EnvironmentObject var audioService: AudioService

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
                    // Nothing playing yet: land straight on the track list —
                    // no extra "Open Queue" tap needed.
                    trackListScreen
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
                // Share the current track's private listening link — only when
                // the track actually has one. No marketing-site fallback: the
                // homepage shows subscription pricing, which the app must not
                // route users to (Guideline 3.1.1).
                ToolbarItem(placement: .navigationBarTrailing) {
                    if let shareURL {
                        ShareLink(item: shareURL) {
                            Image(systemName: "square.and.arrow.up")
                                .foregroundColor(Color(hex: "#2dd4bf"))
                        }
                    }
                }
                // Open the editable "Up Next" queue.
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: { showQueue = true }) {
                        Image(systemName: "list.bullet")
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }
                }
            }
            .task {
                await seedQueueIfNeeded()
            }
            .sheet(isPresented: $showQueue) {
                QueueSheet(isLoading: isLoading)
            }
        }
    }

    // MARK: - Ambient Backdrop
    // Blurred, over-scaled artwork behind everything, faded into black. The screen
    // takes on the colour of whatever is playing, like Apple Music / Spotify.
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
            Spacer(minLength: 16)

            // Artwork — large, centered, with a soft teal glow
            artworkImage
                .padding(.horizontal, 44)

            Spacer(minLength: 30)

            // Track title — tap to open the song's project page (playback keeps
            // going; AudioService is global). The full-queue Menu that used to
            // live here scrolled unusably with a long catalogue — song picking
            // stays in the Up Next sheet and the track list instead.
            VStack(spacing: 8) {
                NavigationLink(destination: ProjectDetailView(projectId: version.projectId)) {
                    HStack(spacing: 6) {
                        Text(audioService.currentTrackName ?? "Unknown Track")
                            .font(.title2)
                            .fontWeight(.bold)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                            .lineLimit(1)
                        Image(systemName: "chevron.right")
                            .font(.caption)
                            .fontWeight(.semibold)
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }
                }
                .buttonStyle(.plain)

                // Version + status. Switching versions is tucked into a small
                // menu instead of a row of pills for every version.
                HStack(spacing: 6) {
                    if allVersions.count > 1 {
                        Menu {
                            ForEach(allVersions.sorted(by: { $0.versionNumber > $1.versionNumber })) { v in
                                Button(action: {
                                    // Same project, different mix — keep its visualizer looping.
                                    audioService.play(
                                        version: v,
                                        trackName: audioService.currentTrackName ?? "Unknown",
                                        artworkUrl: audioService.currentArtworkUrl,
                                        visualizerUrl: audioService.currentVisualizerUrl
                                    )
                                }) {
                                    if isCurrentVersion(v) {
                                        Label(versionMenuTitle(v), systemImage: "checkmark")
                                    } else {
                                        Text(versionMenuTitle(v))
                                    }
                                }
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Text("v\(version.versionNumber)")
                                    .fontWeight(.semibold)
                                if let label = version.label, !label.isEmpty {
                                    Text("· \(label)")
                                }
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(.system(size: 9))
                            }
                        }
                    } else {
                        Text("v\(version.versionNumber)")
                            .fontWeight(.semibold)
                        if let label = version.label, !label.isEmpty {
                            Text("· \(label)")
                        }
                    }
                    StatusBadge(status: version.status)
                }
                .font(.caption)
                .foregroundColor(Color(hex: "#2dd4bf"))
            }
            .padding(.horizontal, 24)

            Spacer(minLength: 28)

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
                .padding(.top, 26)

            Spacer(minLength: 44)
        }
        // Reload versions when the playing project changes (for the switcher)
        .task(id: version.projectId) {
            await loadVersionsForCurrentProject(projectId: version.projectId)
        }
    }

    // The private listening link for the current version, matching the web app's
    // /share/<token> route. Nil when the track has no token — the share button
    // hides rather than falling back to the marketing site (Guideline 3.1.1).
    private var shareURL: URL? {
        guard let token = audioService.currentVersion?.shareToken, !token.isEmpty else { return nil }
        return URL(string: "https://mixbase.app/share/\(token)")
    }

    // MARK: - Track List (nothing playing)
    // All tracks, one row per song (latest version), ready to tap-and-play.
    private var trackListScreen: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 4) {
                Text("Your Tracks")
                    .font(.headline)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .padding(.horizontal)
                    .padding(.top, 12)
                    .padding(.bottom, 6)

                if isLoading && audioService.queue.isEmpty {
                    HStack { Spacer(); ProgressView().tint(Color(hex: "#2dd4bf")); Spacer() }
                        .padding(.vertical, 40)
                } else if audioService.queue.isEmpty {
                    Text("No tracks yet — upload a mix from Projects.")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                        .padding(.horizontal)
                        .padding(.vertical, 24)
                } else {
                    ForEach(audioService.queue) { item in
                        trackListRow(item)
                    }
                }

                Spacer(minLength: 100)
            }
        }
    }

    @ViewBuilder
    private func trackListRow(_ item: QueueItem) -> some View {
        Button(action: { audioService.play(item: item) }) {
            HStack(spacing: 12) {
                if let artworkUrl = item.artworkUrl, let url = URL(string: artworkUrl) {
                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        RoundedRectangle(cornerRadius: 8).fill(Color(hex: "#1a1a1a"))
                    }
                    .frame(width: 48, height: 48)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                } else {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color(hex: "#1a1a1a"))
                        .frame(width: 48, height: 48)
                        .overlay(
                            Image(systemName: "music.note")
                                .font(.caption)
                                .foregroundColor(.gray.opacity(0.4))
                        )
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text(item.trackName)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(Color(hex: "#f0f0f0"))
                        .lineLimit(1)
                    Text("v\(item.version.versionNumber)\(item.version.label.map { " · \($0)" } ?? "")")
                        .font(.caption2)
                        .foregroundColor(.gray)
                        .lineLimit(1)
                }

                Spacer()

                Image(systemName: "play.circle.fill")
                    .font(.title3)
                    .foregroundColor(Color(hex: "#2dd4bf"))
            }
            .padding(.horizontal)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
                .overlay(visualizerOverlay)
                .clipShape(RoundedRectangle(cornerRadius: 20))
                .shadow(color: Color(hex: "#2dd4bf").opacity(0.25), radius: 30, y: 10)
                .shadow(color: .black.opacity(0.6), radius: 24, y: 16)
            } else {
                artworkPlaceholder
                    .overlay(visualizerOverlay)
                    .clipShape(RoundedRectangle(cornerRadius: 20))
                    .shadow(color: .black.opacity(0.5), radius: 24, y: 12)
            }
        }
    }

    // The project's pinned visualizer, looping over the artwork while the track
    // plays and freezing on pause — mirroring the web player and share page. The
    // artwork stays underneath as the instant frame while the video buffers.
    @ViewBuilder
    private var visualizerOverlay: some View {
        if let viz = audioService.currentVisualizerUrl, let url = URL(string: viz) {
            VisualizerVideoView(url: url, isPlaying: audioService.isPlaying)
                .allowsHitTesting(false)
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

    // MARK: - Helpers

    // Menu row title for a version, e.g. "v4 · Club Mix"
    private func versionMenuTitle(_ version: Version) -> String {
        if let label = version.label, !label.isEmpty {
            return "v\(version.versionNumber) · \(label)"
        }
        return "v\(version.versionNumber)"
    }

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

    // Seed the shared queue with every project's latest version — but only if the
    // queue is empty, so we never clobber a queue the user has reordered or trimmed
    // when they revisit the Player.
    private func seedQueueIfNeeded() async {
        isLoading = true
        defer { isLoading = false }
        guard audioService.queue.isEmpty else { return }
        do {
            let projects = try await SupabaseService.shared.fetchProjects()
            var items: [QueueItem] = []
            for project in projects {
                let versions = try await SupabaseService.shared.fetchVersions(projectId: project.id)
                if let latest = versions.max(by: { $0.versionNumber < $1.versionNumber }) {
                    items.append(QueueItem(
                        projectId: project.id,
                        version: latest,
                        trackName: project.title,
                        artworkUrl: project.artworkUrl,
                        visualizerUrl: project.visualizerUrl
                    ))
                }
            }
            if audioService.queue.isEmpty { audioService.setQueue(items) }
        } catch {
            print("PlayerView: Failed to seed queue — \(error.localizedDescription)")
        }
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
// "Up Next" — the real, editable playback queue. Drag rows to reorder, swipe to
// remove, tap to jump straight to a track. Edits write through to AudioService,
// so next/prev and auto-advance immediately follow the queue you curate.
struct QueueSheet: View {

    @EnvironmentObject var audioService: AudioService
    @Environment(\.dismiss) private var dismiss

    let isLoading: Bool

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808").ignoresSafeArea()

                if isLoading && audioService.queue.isEmpty {
                    ProgressView()
                        .tint(Color(hex: "#2dd4bf"))
                } else if audioService.queue.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "music.note.list")
                            .font(.system(size: 36))
                            .foregroundColor(.gray.opacity(0.3))
                        Text("Queue is empty")
                            .font(.subheadline)
                            .foregroundColor(.gray)
                    }
                } else {
                    List {
                        Section {
                            ForEach(audioService.queue) { item in
                                queueRow(item: item)
                                    .listRowBackground(Color.clear)
                                    .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                                    .listRowSeparatorTint(Color(hex: "#f0f0f0").opacity(0.06))
                            }
                            .onMove { offsets, dest in
                                audioService.moveQueueItems(fromOffsets: offsets, toOffset: dest)
                            }
                            .onDelete { offsets in
                                audioService.removeQueueItems(atOffsets: offsets)
                            }
                        } header: {
                            Text("\(audioService.queue.count) tracks · drag to reorder, swipe to remove")
                                .font(.caption2)
                                .foregroundColor(.gray)
                                .textCase(nil)
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                }
            }
            .navigationTitle("Queue")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    EditButton()
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }
            }
        }
    }

    // MARK: - Queue Row
    @ViewBuilder
    private func queueRow(item: QueueItem) -> some View {
        // Choosing a song starts it and closes the queue, revealing Now Playing.
        Button(action: {
            audioService.play(item: item)
            dismiss()
        }) {
            HStack(spacing: 12) {
                ZStack {
                    if let artworkUrl = item.artworkUrl,
                       let url = URL(string: artworkUrl) {
                        AsyncImage(url: url) { image in
                            image.resizable().aspectRatio(contentMode: .fill)
                        } placeholder: {
                            RoundedRectangle(cornerRadius: 8)
                                .fill(Color(hex: "#1a1a1a"))
                        }
                        .frame(width: 48, height: 48)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    } else {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(Color(hex: "#1a1a1a"))
                            .frame(width: 48, height: 48)
                            .overlay(
                                Image(systemName: "music.note")
                                    .foregroundColor(.gray.opacity(0.4))
                                    .font(.caption)
                            )
                    }

                    if isCurrentlyPlaying(item) {
                        Circle()
                            .fill(Color(hex: "#2dd4bf").opacity(0.85))
                            .frame(width: 26, height: 26)
                            .overlay(
                                Image(systemName: audioService.isPlaying ? "waveform" : "pause.fill")
                                    .font(.system(size: 10))
                                    .foregroundColor(.white)
                            )
                    }
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text(item.trackName)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(
                            isCurrentlyPlaying(item)
                                ? Color(hex: "#2dd4bf")
                                : Color(hex: "#f0f0f0")
                        )
                        .lineLimit(1)

                    Text("v\(item.version.versionNumber)\(item.version.label.map { " · \($0)" } ?? "")")
                        .font(.caption2)
                        .foregroundColor(.gray)
                        .lineLimit(1)
                }

                Spacer()

                StatusBadge(status: item.version.status)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func isCurrentlyPlaying(_ item: QueueItem) -> Bool {
        guard let current = audioService.currentVersion else { return false }
        return current.projectId == item.projectId
    }
}
