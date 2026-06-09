import SwiftUI

// MARK: - MiniPlayerView
// A persistent mini player bar that sits above the tab bar.
// Shows artwork thumbnail, track name, version, and a play/pause button.
// Tapping the bar (not the button) triggers onTap to navigate to the full player.

struct MiniPlayerView: View {

    // Access the shared audio service for playback state
    @EnvironmentObject var audioService: AudioService

    // Callback when the user taps the bar area (navigates to Player tab)
    var onTap: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            // Artwork thumbnail (36x36, rounded corners)
            if let artworkUrl = audioService.currentArtworkUrl,
               let url = URL(string: artworkUrl) {
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } placeholder: {
                    // Gray placeholder with music note icon
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color(hex: "#222222"))
                        .overlay(
                            Image(systemName: "music.note")
                                .foregroundColor(.gray)
                                .font(.caption)
                        )
                }
                .frame(width: 36, height: 36)
                .clipShape(RoundedRectangle(cornerRadius: 6))
            } else {
                // No artwork — show placeholder
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color(hex: "#222222"))
                    .frame(width: 36, height: 36)
                    .overlay(
                        Image(systemName: "music.note")
                            .foregroundColor(.gray)
                            .font(.caption)
                    )
            }

            // Track name and version number
            VStack(alignment: .leading, spacing: 2) {
                Text(audioService.currentTrackName ?? "No Track")
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .lineLimit(1)

                if let version = audioService.currentVersion {
                    Text("v\(version.versionNumber)")
                        .font(.caption2)
                        .foregroundColor(Color(hex: "#f0f0f0").opacity(0.5))
                }
            }

            Spacer()

            // Transport: prev / play-pause / next — drives the shared queue so skipping
            // works from any tab, not just the player screen.
            HStack(spacing: 18) {
                Button(action: { audioService.prev() }) {
                    Image(systemName: "backward.fill")
                        .font(.subheadline)
                        .foregroundColor(Color(hex: "#f0f0f0").opacity(0.7))
                }

                Button(action: { audioService.togglePlayPause() }) {
                    if audioService.buffering {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: Color(hex: "#2dd4bf")))
                            .frame(width: 22, height: 22)
                    } else {
                        Image(systemName: audioService.isPlaying ? "pause.fill" : "play.fill")
                            .font(.title3)
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }
                }

                Button(action: { audioService.next() }) {
                    Image(systemName: "forward.fill")
                        .font(.subheadline)
                        .foregroundColor(Color(hex: "#f0f0f0").opacity(0.7))
                }
            }
            .padding(.trailing, 4)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        // Dark background with a subtle top border line
        .background(
            VStack(spacing: 0) {
                Rectangle()
                    .fill(Color(hex: "#2dd4bf").opacity(0.15))
                    .frame(height: 0.5) // Thin top border
                Rectangle()
                    .fill(Color(hex: "#161616"))
            }
        )
        // Tapping the bar (not the button) navigates to full player
        .contentShape(Rectangle())
        .onTapGesture {
            onTap()
        }
    }
}
