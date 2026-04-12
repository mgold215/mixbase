import SwiftUI

// MARK: - PlayerView
// The Player tab. Two sections:
// 1. If a track is playing, show the full player at the top (artwork, controls, version switcher)
// 2. Below (or if nothing is playing), show a browsable list of ALL tracks across all projects.
//    Each row shows the project name, latest version, artwork, and a play button.
//    You can tap to play, or long-press to edit/arrange.

struct PlayerView: View {

    @EnvironmentObject var audioService: AudioService

    // All projects with their versions, loaded from Supabase
    @State private var trackList: [TrackItem] = []
    @State private var allVersions: [Version] = []
    @State private var isLoading = true

    // A/B compare toggle
    @State private var abCompareEnabled = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808")
                    .ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 0) {
                        // MARK: - Now Playing (full player)
                        // Only shows when a track is actively loaded
                        if let version = audioService.currentVersion {
                            nowPlayingSection(version: version)
                                .padding(.bottom, 16)

                            // Divider between player and track list
                            Rectangle()
                                .fill(Color(hex: "#1a1a1a"))
                                .frame(height: 1)
                                .padding(.horizontal)
                        }

                        // MARK: - All Tracks list
                        trackListSection
                    }
                    .padding(.bottom, 80)
                }
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.large)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .task {
                await loadAllTracks()
            }
        }
    }

    // MARK: - Now Playing Section
    // Compact but full-featured player: artwork, info, progress, controls, version pills
    @ViewBuilder
    private func nowPlayingSection(version: Version) -> some View {
        VStack(spacing: 12) {
            // Artwork — large, centered
            artworkImage
                .padding(.horizontal, 60)
                .padding(.top, 8)

            // Track title + version info
            VStack(spacing: 4) {
                Text(audioService.currentTrackName ?? "Unknown Track")
                    .font(.title3)
                    .fontWeight(.bold)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .lineLimit(1)

                HStack(spacing: 6) {
                    Text("v\(version.versionNumber)")
                        .fontWeight(.medium)
                    if let label = version.label {
                        Text("- \(label)")
                    }
                    StatusBadge(status: version.status)
                }
                .font(.caption)
                .foregroundColor(Color(hex: "#2dd4bf"))
            }

            // Progress bar (tappable to seek)
            waveformBar
                .padding(.horizontal, 24)

            // Time display
            HStack {
                Text(formatTime(audioService.currentTime))
                    .font(.caption2)
                    .foregroundColor(.gray)
                Spacer()
                Text("-\(formatTime(max(0, audioService.duration - audioService.currentTime)))")
                    .font(.caption2)
                    .foregroundColor(.gray)
            }
            .padding(.horizontal, 24)

            // Playback controls
            playbackControls

            // Version switcher pills
            if !allVersions.isEmpty {
                versionSwitcher
            }
        }
        // Reload versions when the playing project changes
        .task(id: version.projectId) {
            await loadVersionsForCurrentProject(projectId: version.projectId)
        }
    }

    // MARK: - Track List Section
    // Browsable list of ALL projects with their latest version.
    // Tap a row to play the latest version. Tap the project name to go to detail.
    private var trackListSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Section header
            HStack {
                Text("All Tracks")
                    .font(.headline)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                Spacer()
                Text("\(trackList.count) projects")
                    .font(.caption)
                    .foregroundColor(.gray)
            }
            .padding(.horizontal)
            .padding(.top, 16)
            .padding(.bottom, 12)

            if isLoading {
                ProgressView()
                    .tint(Color(hex: "#2dd4bf"))
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
            } else if trackList.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "music.note.list")
                        .font(.system(size: 36))
                        .foregroundColor(.gray.opacity(0.3))
                    Text("No tracks yet")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 40)
            } else {
                // List of tracks
                LazyVStack(spacing: 2) {
                    ForEach(trackList) { item in
                        trackRow(item: item)
                    }
                }
            }
        }
    }

    // MARK: - Track Row
    // A single row: artwork thumbnail, project title, version info, play button
    @ViewBuilder
    private func trackRow(item: TrackItem) -> some View {
        HStack(spacing: 12) {
            // Play button overlaid on artwork thumbnail
            Button(action: {
                audioService.play(
                    version: item.latestVersion,
                    trackName: item.project.title,
                    artworkUrl: item.project.artworkUrl
                )
            }) {
                ZStack {
                    // Artwork thumbnail
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

                    // Play icon overlay (shows when this track is NOT currently playing)
                    if !isCurrentlyPlaying(item) {
                        Circle()
                            .fill(Color.black.opacity(0.5))
                            .frame(width: 28, height: 28)
                            .overlay(
                                Image(systemName: "play.fill")
                                    .font(.system(size: 10))
                                    .foregroundColor(.white)
                            )
                    } else {
                        // Equalizer-style indicator for currently playing track
                        Circle()
                            .fill(Color(hex: "#2dd4bf").opacity(0.8))
                            .frame(width: 28, height: 28)
                            .overlay(
                                Image(systemName: audioService.isPlaying ? "waveform" : "pause.fill")
                                    .font(.system(size: 10))
                                    .foregroundColor(.white)
                            )
                    }
                }
            }

            // Track info
            NavigationLink(destination: ProjectDetailView(projectId: item.project.id)) {
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
                            .font(.caption2)
                            .foregroundColor(.gray)

                        if let genre = item.project.genre {
                            Text(genre)
                                .font(.caption2)
                                .foregroundColor(.gray)
                        }

                        if let bpm = item.project.bpm {
                            Text("\(bpm) BPM")
                                .font(.caption2)
                                .foregroundColor(.gray.opacity(0.6))
                        }
                    }
                }

                Spacer()
            }
            .buttonStyle(.plain)

            // Version count + status badge
            VStack(alignment: .trailing, spacing: 4) {
                StatusBadge(status: item.latestVersion.status)
                Text("\(item.versionCount) ver\(item.versionCount != 1 ? "s" : "")")
                    .font(.caption2)
                    .foregroundColor(.gray.opacity(0.5))
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(
            isCurrentlyPlaying(item)
                ? Color(hex: "#2dd4bf").opacity(0.05)
                : Color.clear
        )
    }

    // MARK: - Artwork Image (for now playing)
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
                .shadow(color: .black.opacity(0.5), radius: 20, y: 10)
            } else {
                artworkPlaceholder
                    .shadow(color: .black.opacity(0.5), radius: 20, y: 10)
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
        .frame(height: 24)
    }

    // MARK: - Playback Controls
    private var playbackControls: some View {
        HStack(spacing: 36) {
            Button(action: previousVersion) {
                Image(systemName: "backward.end.fill")
                    .font(.title3)
                    .foregroundColor(Color(hex: "#f0f0f0"))
            }

            Button(action: { audioService.togglePlayPause() }) {
                Image(systemName: audioService.isPlaying ? "pause.fill" : "play.fill")
                    .font(.title3)
                    .foregroundColor(Color(hex: "#080808"))
                    .frame(width: 52, height: 52)
                    .background(Color(hex: "#2dd4bf"))
                    .clipShape(Circle())
            }

            Button(action: nextVersion) {
                Image(systemName: "forward.end.fill")
                    .font(.title3)
                    .foregroundColor(Color(hex: "#f0f0f0"))
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

    private func isCurrentlyPlaying(_ item: TrackItem) -> Bool {
        guard let current = audioService.currentVersion else { return false }
        return current.projectId == item.project.id
    }

    private func formatTime(_ time: Double) -> String {
        let totalSeconds = Int(time)
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return String(format: "%d:%02d", minutes, seconds)
    }

    private func previousVersion() {
        guard let current = audioService.currentVersion else { return }
        let sorted = allVersions.sorted(by: { $0.versionNumber < $1.versionNumber })
        if let index = sorted.firstIndex(where: { $0.id == current.id }), index > 0 {
            audioService.play(
                version: sorted[index - 1],
                trackName: audioService.currentTrackName ?? "Unknown",
                artworkUrl: audioService.currentArtworkUrl
            )
        }
    }

    private func nextVersion() {
        guard let current = audioService.currentVersion else { return }
        let sorted = allVersions.sorted(by: { $0.versionNumber < $1.versionNumber })
        if let index = sorted.firstIndex(where: { $0.id == current.id }), index < sorted.count - 1 {
            audioService.play(
                version: sorted[index + 1],
                trackName: audioService.currentTrackName ?? "Unknown",
                artworkUrl: audioService.currentArtworkUrl
            )
        }
    }

    // MARK: - Data Loading

    // Load all projects + their latest versions for the track list
    private func loadAllTracks() async {
        isLoading = true
        do {
            let projects = try await SupabaseService.shared.fetchProjects()
            var items: [TrackItem] = []

            // For each project, fetch its versions and pick the latest
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

// MARK: - TrackItem
// A helper struct that pairs a project with its latest version for the track list.
struct TrackItem: Identifiable {
    let project: Project
    let latestVersion: Version
    let versionCount: Int

    var id: UUID { project.id }
}
