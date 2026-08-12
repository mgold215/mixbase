import SwiftUI
import AVKit

// MARK: - VisualizerView
// Spotify-Canvas-style visualizers for a project, matching the web Visualizer
// tab: a pinned looping video up top and the user's saved library where any
// video can be pinned to this project or deleted. Generation happens on the
// web only — the iOS app deliberately has no generation UI (App Store
// Guideline 3.1.1: video generation is a paid capability, and the app must
// not expose functionality that is purchased outside Apple's IAP).

struct VisualizerView: View {

    let projectId: UUID
    let projectTitle: String
    // Kept for call-site compatibility; no longer used now that the in-app
    // generator is gone.
    let artworkUrl: String?

    // The currently pinned visualizer (project.visualizer_url)
    @State var pinnedUrl: String?

    // Lets the presenting screen update its copy of the pin immediately
    var onPinChanged: ((String?) -> Void)? = nil

    // Library state
    @State private var library: [Visualizer] = []
    @State private var isLoadingLibrary = true
    @State private var pinningUrl: String?    // url currently being pinned (spinner)

    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            Color(hex: "#080808")
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    // MARK: - Pinned Visualizer
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Pinned Visualizer")
                            .font(.headline)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                            .padding(.horizontal)

                        if let pinnedUrl, let url = URL(string: pinnedUrl) {
                            LoopingVideoPlayer(url: url)
                                .frame(height: 320)
                                .clipShape(RoundedRectangle(cornerRadius: 16))
                                .padding(.horizontal)

                            Button(action: { Task { await pin(nil) } }) {
                                HStack(spacing: 4) {
                                    Image(systemName: "pin.slash")
                                    Text("Unpin")
                                }
                                .font(.caption)
                                .fontWeight(.medium)
                                .foregroundColor(.gray)
                            }
                            .padding(.horizontal)
                        } else {
                            Text("No visualizer pinned yet — pin one from your library below.")
                                .font(.subheadline)
                                .foregroundColor(.gray)
                                .padding(.horizontal)
                        }
                    }

                    // Pin/delete errors surface here (the only remaining actions)
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundColor(.red)
                            .padding(.horizontal)
                    }

                    // MARK: - Library
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Your Videos")
                            .font(.headline)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                            .padding(.horizontal)

                        if isLoadingLibrary {
                            HStack {
                                Spacer()
                                ProgressView().tint(Color(hex: "#2dd4bf"))
                                Spacer()
                            }
                            .padding(.vertical, 16)
                        } else if library.isEmpty {
                            Text("Nothing here yet — your generated visualizers and finished renders will show up here.")
                                .font(.subheadline)
                                .foregroundColor(.gray)
                                .padding(.horizontal)
                        } else {
                            ForEach(library) { visualizer in
                                libraryRow(visualizer)
                            }
                        }
                    }

                    Spacer(minLength: 80)
                }
                .padding(.top, 16)
            }
        }
        .navigationTitle("Visualizer")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .task {
            await loadLibrary()
        }
    }

    // MARK: - Library Row
    @ViewBuilder
    private func libraryRow(_ visualizer: Visualizer) -> some View {
        let isPinned = visualizer.videoUrl == pinnedUrl
        HStack(spacing: 12) {
            // Source artwork as the thumbnail (the video's first frame is it anyway)
            if let source = visualizer.sourceImageUrl, let url = URL(string: source) {
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
                        Image(systemName: "play.rectangle")
                            .foregroundColor(.gray.opacity(0.5))
                    )
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(visualizer.title ?? "Visualizer")
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .lineLimit(1)
                Text(visualizer.createdAt, style: .date)
                    .font(.caption2)
                    .foregroundColor(.gray)
            }

            Spacer()

            // Pin / pinned indicator
            if pinningUrl == visualizer.videoUrl {
                ProgressView().tint(Color(hex: "#2dd4bf"))
            } else if isPinned {
                HStack(spacing: 3) {
                    Image(systemName: "pin.fill")
                    Text("Pinned")
                }
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(Color(hex: "#2dd4bf"))
            } else {
                Button(action: { Task { await pin(visualizer.videoUrl) } }) {
                    Text("Pin")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundColor(Color(hex: "#080808"))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .background(Color(hex: "#2dd4bf"))
                        .clipShape(Capsule())
                }
            }

            // Delete
            Button(action: { Task { await delete(visualizer) } }) {
                Image(systemName: "trash")
                    .font(.caption)
                    .foregroundColor(.gray)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 6)
    }

    // MARK: - Actions

    private func loadLibrary() async {
        isLoadingLibrary = true
        do {
            library = try await MixbaseAPI.shared.fetchVisualizers()
        } catch {
            print("VisualizerView: failed to load library — \(error.localizedDescription)")
        }
        isLoadingLibrary = false
    }

    private func pin(_ url: String?) async {
        pinningUrl = url
        do {
            try await MixbaseAPI.shared.pinVisualizer(projectId: projectId, videoUrl: url)
            pinnedUrl = url
            onPinChanged?(url)
        } catch {
            errorMessage = error.localizedDescription
        }
        pinningUrl = nil
    }

    private func delete(_ visualizer: Visualizer) async {
        do {
            try await MixbaseAPI.shared.deleteVisualizer(id: visualizer.id)
            library.removeAll { $0.id == visualizer.id }
            // Server also un-pins deleted videos from projects
            if pinnedUrl == visualizer.videoUrl {
                pinnedUrl = nil
                onPinChanged?(nil)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - LoopingVideoPlayer
// A muted, seamlessly looping, fill-cropped video view — how visualizers render
// everywhere in the product. AVPlayerLooper handles gapless restarts.

struct LoopingVideoPlayer: UIViewRepresentable {

    let url: URL

    func makeUIView(context: Context) -> LoopingPlayerUIView {
        LoopingPlayerUIView(url: url)
    }

    func updateUIView(_ uiView: LoopingPlayerUIView, context: Context) {
        uiView.update(url: url)
    }

    static func dismantleUIView(_ uiView: LoopingPlayerUIView, coordinator: ()) {
        uiView.stop()
    }
}

final class LoopingPlayerUIView: UIView {

    private var player: AVQueuePlayer?
    private var looper: AVPlayerLooper?
    private var currentUrl: URL?

    override static var layerClass: AnyClass { AVPlayerLayer.self }

    private var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }

    init(url: URL) {
        super.init(frame: .zero)
        playerLayer.videoGravity = .resizeAspectFill
        update(url: url)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(url: URL) {
        guard url != currentUrl else { return }
        currentUrl = url

        let item = AVPlayerItem(url: url)
        let queuePlayer = AVQueuePlayer()
        queuePlayer.isMuted = true  // visualizers are silent; the mix plays via AudioService
        looper = AVPlayerLooper(player: queuePlayer, templateItem: item)
        playerLayer.player = queuePlayer
        player = queuePlayer
        queuePlayer.play()
    }

    func stop() {
        player?.pause()
        looper = nil
        player = nil
        playerLayer.player = nil
    }
}
