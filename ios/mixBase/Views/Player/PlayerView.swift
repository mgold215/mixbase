import SwiftUI

// MARK: - PlayerView
// The full-screen player — the centerpiece of the app.
// Shows large artwork, track info, waveform/progress, playback controls,
// version switcher pills, and an A/B compare toggle.

struct PlayerView: View {

    // Access the shared audio service for all playback state
    @EnvironmentObject var audioService: AudioService

    // All versions for the current project (for version switching)
    @State private var allVersions: [Version] = []

    // A/B compare toggle state
    @State private var abCompareEnabled = false

    var body: some View {
        ZStack {
            // Dark background
            Color(hex: "#080808")
                .ignoresSafeArea()

            if let version = audioService.currentVersion {
                // Content when a track is loaded
                VStack(spacing: 0) {
                    Spacer(minLength: 20)

                    // MARK: - Large Artwork
                    artworkImage
                        .padding(.horizontal, 40)

                    Spacer(minLength: 20)

                    // MARK: - Track Info
                    VStack(spacing: 6) {
                        Text(audioService.currentTrackName ?? "Unknown Track")
                            .font(.title2)
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
                        .font(.subheadline)
                        .foregroundColor(Color(hex: "#2dd4bf"))
                    }
                    .padding(.horizontal)

                    Spacer(minLength: 16)

                    // MARK: - Waveform / Progress Bar
                    // A tappable rounded rectangle that shows playback progress
                    waveformBar
                        .padding(.horizontal, 24)

                    // MARK: - Time Display
                    // Elapsed time on the left, remaining time on the right
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
                    .padding(.top, 4)

                    Spacer(minLength: 16)

                    // MARK: - Playback Controls
                    playbackControls

                    Spacer(minLength: 16)

                    // MARK: - Version Switcher
                    // Horizontal row of pill buttons (v1, v2, v3...)
                    versionSwitcher

                    Spacer(minLength: 12)

                    // MARK: - A/B Compare Toggle
                    HStack {
                        Spacer()
                        Toggle(isOn: $abCompareEnabled) {
                            HStack(spacing: 6) {
                                Image(systemName: "arrow.left.arrow.right")
                                Text("A/B Compare")
                            }
                            .font(.subheadline)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                        }
                        .toggleStyle(SwitchToggleStyle(tint: Color(hex: "#2dd4bf")))
                        Spacer()
                    }
                    .padding(.horizontal, 24)

                    Spacer(minLength: 80) // Space for mini player / tab bar
                }
            } else {
                // Empty state when nothing is playing
                VStack(spacing: 16) {
                    Image(systemName: "play.circle")
                        .font(.system(size: 64))
                        .foregroundColor(.gray.opacity(0.3))
                    Text("No track loaded")
                        .font(.headline)
                        .foregroundColor(.gray)
                    Text("Select a version from a project to start playing")
                        .font(.subheadline)
                        .foregroundColor(.gray.opacity(0.6))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 40)
                }
            }
        }
        // Load all versions for the current project when the view appears
        .task(id: audioService.currentVersion?.projectId) {
            if let projectId = audioService.currentVersion?.projectId {
                await loadVersions(projectId: projectId)
            }
        }
    }

    // MARK: - Large Artwork Image
    // Fills ~60% of screen width, centered, with rounded corners
    private var artworkImage: some View {
        Group {
            if let artworkUrl = audioService.currentArtworkUrl,
               let url = URL(string: artworkUrl) {
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                } placeholder: {
                    // Gradient placeholder while loading
                    RoundedRectangle(cornerRadius: 16)
                        .fill(
                            LinearGradient(
                                colors: [Color(hex: "#1a1a1a"), Color(hex: "#111111")],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .overlay(
                            Image(systemName: "music.note")
                                .font(.system(size: 48))
                                .foregroundColor(.gray.opacity(0.3))
                        )
                }
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .shadow(color: .black.opacity(0.5), radius: 20, y: 10)
            } else {
                // No artwork — show gradient placeholder
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
                    .shadow(color: .black.opacity(0.5), radius: 20, y: 10)
            }
        }
    }

    // MARK: - Waveform / Progress Bar
    // A rounded rectangle with gradient fill showing playback progress.
    // Tappable to seek to a position.
    private var waveformBar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                // Background track
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color(hex: "#222222"))

                // Filled progress with gradient
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
            // Tap to seek
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        // Calculate the new time based on tap position
                        let fraction = max(0, min(1, value.location.x / geo.size.width))
                        let newTime = Double(fraction) * audioService.duration
                        audioService.seek(to: newTime)
                    }
            )
        }
        .frame(height: 28)
    }

    // MARK: - Playback Controls
    // Previous version, play/pause, next version
    private var playbackControls: some View {
        HStack(spacing: 40) {
            // Previous version button
            Button(action: previousVersion) {
                Image(systemName: "backward.end.fill")
                    .font(.title2)
                    .foregroundColor(Color(hex: "#f0f0f0"))
            }

            // Play / Pause button — large teal circle
            Button(action: { audioService.togglePlayPause() }) {
                Image(systemName: audioService.isPlaying ? "pause.fill" : "play.fill")
                    .font(.title2)
                    .foregroundColor(Color(hex: "#080808"))
                    .frame(width: 56, height: 56)
                    .background(Color(hex: "#2dd4bf"))
                    .clipShape(Circle())
            }

            // Next version button
            Button(action: nextVersion) {
                Image(systemName: "forward.end.fill")
                    .font(.title2)
                    .foregroundColor(Color(hex: "#f0f0f0"))
            }
        }
    }

    // MARK: - Version Switcher
    // Horizontal ScrollView of pill buttons for each version
    private var versionSwitcher: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(allVersions.sorted(by: { $0.versionNumber < $1.versionNumber })) { version in
                    Button(action: {
                        // Switch to this version
                        audioService.play(
                            version: version,
                            trackName: audioService.currentTrackName ?? "Unknown",
                            artworkUrl: audioService.currentArtworkUrl
                        )
                    }) {
                        Text("v\(version.versionNumber)")
                            .font(.caption)
                            .fontWeight(.semibold)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
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
                            .overlay(
                                Capsule()
                                    .stroke(
                                        isCurrentVersion(version)
                                            ? Color(hex: "#2dd4bf")
                                            : Color.clear,
                                        lineWidth: 1.5
                                    )
                            )
                    }
                }
            }
            .padding(.horizontal, 24)
        }
    }

    // MARK: - Helpers

    // Calculate playback progress as a fraction (0.0 to 1.0)
    private var playbackProgress: CGFloat {
        guard audioService.duration > 0 else { return 0 }
        return CGFloat(audioService.currentTime / audioService.duration)
    }

    // Check if a version is the currently playing one
    private func isCurrentVersion(_ version: Version) -> Bool {
        audioService.currentVersion?.id == version.id
    }

    // Format seconds into "M:SS" (e.g. 95.3 -> "1:35")
    private func formatTime(_ time: Double) -> String {
        let totalSeconds = Int(time)
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return String(format: "%d:%02d", minutes, seconds)
    }

    // Skip to the previous version in the list
    private func previousVersion() {
        guard let current = audioService.currentVersion else { return }
        let sorted = allVersions.sorted(by: { $0.versionNumber < $1.versionNumber })
        if let index = sorted.firstIndex(where: { $0.id == current.id }), index > 0 {
            let prev = sorted[index - 1]
            audioService.play(
                version: prev,
                trackName: audioService.currentTrackName ?? "Unknown",
                artworkUrl: audioService.currentArtworkUrl
            )
        }
    }

    // Skip to the next version in the list
    private func nextVersion() {
        guard let current = audioService.currentVersion else { return }
        let sorted = allVersions.sorted(by: { $0.versionNumber < $1.versionNumber })
        if let index = sorted.firstIndex(where: { $0.id == current.id }), index < sorted.count - 1 {
            let next = sorted[index + 1]
            audioService.play(
                version: next,
                trackName: audioService.currentTrackName ?? "Unknown",
                artworkUrl: audioService.currentArtworkUrl
            )
        }
    }

    // Load all versions for the given project
    private func loadVersions(projectId: UUID) async {
        do {
            allVersions = try await SupabaseService.shared.fetchVersions(projectId: projectId)
        } catch {
            print("PlayerView: Failed to load versions — \(error.localizedDescription)")
        }
    }
}
