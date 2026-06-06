import SwiftUI

// MARK: - PlayerView
// A focused "Now Playing" screen — nothing else competes for attention.
//   • When a track is loaded: large artwork, title/version/status, a seekable
//     waveform, transport controls, and a version switcher.
//   • When nothing is loaded: a simple empty state that opens the queue.
// Browsing all tracks lives in a dedicated "Up Next" queue sheet (toolbar
// button), so the player itself stays a single, uncluttered surface instead of
// a player stacked on top of a long scrolling list.

struct PlayerView: View {

    @EnvironmentObject var audioService: AudioService

    // All projects with their latest version. Powers prev/next and the queue sheet.
    @State private var trackList: [TrackItem] = []
    @State private var allVersions: [Version] = []
    @State private var isLoading = true

    // Shuffle & loop
    @State private var isShuffled = false
    @State private var loopMode = 0  // 0 = off, 1 = all, 2 = one

    // Queue sheet
    @State private var showQueue = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808")
                    .ignoresSafeArea()

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

    // MARK: - Now Playing Screen
    // Vertically balanced: artwork up top, info + transport anchored below.
    @ViewBuilder
    private func nowPlayingScreen(version: Version) -> some View {
        VStack(spacing: 0) {
            Spacer(minLength: 12)

            // Artwork — large, centered, with a soft shadow
            artworkImage
                .padding(.horizontal, 48)

            Spacer(minLength: 24)

            // Track title + version info
            VStack(spacing: 6) {
                Text(audioService.currentTrackName ?? "Unknown Track")
                    .font(.title2)
                    .fontWeight(.bold)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .lineLimit(1)

                HStack(spacing: 6) {
                    Text("v\(version.versionNumber)")
                        .fontWeight(.medium)
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
                    .padding(.top, 16)
            }

            Spacer(minLength: 24)

            // Seekable waveform + time
            VStack(spacing: 6) {
                waveformBar
                HStack {
                    Text(formatTime(audioService.currentTime))
                    Spacer()
                    Text("-\(formatTime(max(0, audioService.duration - audioService.currentTime)))")
                }
                .font(.caption2)
                .foregroundColor(.gray)
            }
            .padding(.horizontal, 28)

            // Transport controls
            playbackControls
                .padding(.top, 24)

            Spacer(minLength: 40)
        }
        // Reload versions when the playing project changes (for the switcher)
        .task(id: version.projectId) {
            await loadVersionsForCurrentProject(projectId: version.projectId)
        }
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
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .shadow(color: .black.opacity(0.5), radius: 24, y: 12)
            } else {
                artworkPlaceholder
                    .shadow(color: .black.opacity(0.5), radius: 24, y: 12)
            }
        }
    }

    private var artworkPlaceholder: some View {
        RoundedRectangle(cornerRadius: 16)
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

    // MARK: - Waveform / Progress Bar
    private var waveformBar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color(hex: "#222222"))

                RoundedRectangle(cornerRadius: 6)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color(hex: "#2dd4bf").opacity(0.8),
                                Color(hex: "#2dd4bf").opacity(0.4)
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(width: geo.size.width * playbackProgress)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let fraction = max(0, min(1, value.location.x / geo.size.width))
                        let newTime = Double(fraction) * audioService.duration
                        audioService.seek(to: newTime)
                    }
            )
        }
        .frame(height: 8)
    }

    // MARK: - Playback Controls
    private var playbackControls: some View {
        HStack(spacing: 36) {
            // Shuffle
            Button(action: { isShuffled.toggle() }) {
                Image(systemName: "shuffle")
                    .font(.body)
                    .foregroundColor(isShuffled ? Color(hex: "#2dd4bf") : Color(hex: "#f0f0f0").opacity(0.5))
            }

            Button(action: previousTrack) {
                Image(systemName: "backward.end.fill")
                    .font(.title3)
                    .foregroundColor(Color(hex: "#f0f0f0"))
            }

            Button(action: { audioService.togglePlayPause() }) {
                Image(systemName: audioService.isPlaying ? "pause.fill" : "play.fill")
                    .font(.title2)
                    .foregroundColor(Color(hex: "#080808"))
                    .frame(width: 64, height: 64)
                    .background(Color(hex: "#2dd4bf"))
                    .clipShape(Circle())
            }

            Button(action: nextTrack) {
                Image(systemName: "forward.end.fill")
                    .font(.title3)
                    .foregroundColor(Color(hex: "#f0f0f0"))
            }

            // Loop
            Button(action: { loopMode = (loopMode + 1) % 3 }) {
                Image(systemName: loopMode == 2 ? "repeat.1" : "repeat")
                    .font(.body)
                    .foregroundColor(loopMode > 0 ? Color(hex: "#2dd4bf") : Color(hex: "#f0f0f0").opacity(0.5))
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
                                    : Color(hex: "#222222")
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

    // Navigate to previous track in the queue
    private func previousTrack() {
        guard let current = audioService.currentVersion else { return }
        let list = isShuffled ? trackList.shuffled() : trackList
        if let index = list.firstIndex(where: { $0.project.id == current.projectId }), index > 0 {
            let prev = list[index - 1]
            audioService.play(version: prev.latestVersion, trackName: prev.project.title, artworkUrl: prev.project.artworkUrl)
        } else if loopMode == 1, let last = list.last {
            audioService.play(version: last.latestVersion, trackName: last.project.title, artworkUrl: last.project.artworkUrl)
        }
    }

    // Navigate to next track in the queue
    private func nextTrack() {
        guard let current = audioService.currentVersion else { return }

        // Loop one: restart the same track
        if loopMode == 2 {
            audioService.seek(to: 0)
            audioService.resume()
            return
        }

        let list = isShuffled ? trackList.shuffled() : trackList
        if let index = list.firstIndex(where: { $0.project.id == current.projectId }), index < list.count - 1 {
            let next = list[index + 1]
            audioService.play(version: next.latestVersion, trackName: next.project.title, artworkUrl: next.project.artworkUrl)
        } else if loopMode == 1, let first = list.first {
            audioService.play(version: first.latestVersion, trackName: first.project.title, artworkUrl: first.project.artworkUrl)
        }
    }

    // MARK: - Data Loading

    // Load all projects + their latest versions for the queue / prev-next
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
