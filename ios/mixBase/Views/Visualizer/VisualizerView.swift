import SwiftUI
import AVKit
#if os(macOS)
import AppKit
#endif

// MARK: - VisualizerView
// Spotify-Canvas-style visualizers for a project: a pinned looping video up
// top, the FREE server-side generator (ffmpeg render — included with every
// account, no AI credits), and the user's saved library where any video can
// be pinned to this project or deleted. The paid Runway generation is
// deliberately web-only (App Store Guideline 3.1.1: the app must not expose
// functionality that is purchased outside Apple's IAP).

struct VisualizerView: View {

    let projectId: UUID
    let projectTitle: String
    // Source image for the free generator.
    let artworkUrl: String?

    // The currently pinned visualizer (project.visualizer_url)
    @State var pinnedUrl: String?

    // Lets the presenting screen update its copy of the pin immediately
    var onPinChanged: ((String?) -> Void)? = nil

    // Free generator state (server-side render of the web generator's own
    // effect engine — no AI credits). The effect list is refreshed from
    // GET /api/visualizer/free; this built-in copy mirrors the web's
    // (src/lib/free-effects.ts) so the picker is complete even offline.
    @State private var freeFormat = "canvas"
    @State private var freeEffect = "kenburns"
    @State private var freeBpm = "122"
    @State private var isFreeGenerating = false
    @State private var freeEffects: [MixbaseAPI.FreeEffectOption] = VisualizerView.builtInFreeEffects

    private let freeFormats: [(id: String, label: String)] = [
        ("canvas", "9:16 Canvas"), ("square", "1:1 Square"), ("youtube", "16:9 YouTube"), ("story", "9:16 Story"),
    ]

    private static let builtInFreeEffects: [MixbaseAPI.FreeEffectOption] = [
        .init(id: "kenburns", label: "Cinematic Drift", description: "Slow weightless zoom & pan", beatSynced: false),
        .init(id: "drone", label: "Drone Shot", description: "Circles the art, zooming in & out", beatSynced: false),
        .init(id: "parallax", label: "Depth Float", description: "Art floats over blurred depth", beatSynced: false),
        .init(id: "dust", label: "Dust & Glow", description: "Floating particles, warm light", beatSynced: false),
        .init(id: "pulse", label: "Deep Pulse", description: "Breathes on the beat", beatSynced: true),
        .init(id: "strobe", label: "Club Strobe", description: "Beat punch, downbeat flash", beatSynced: true),
        .init(id: "zoomblur", label: "Warp Zoom", description: "Radial warp bursts on the beat", beatSynced: true),
        .init(id: "liquid", label: "Liquid", description: "Slow underwater ripple", beatSynced: false),
        .init(id: "orbit", label: "Orbit", description: "Weightless sway & rotation", beatSynced: false),
        .init(id: "kaleido", label: "Kaleidoscope", description: "Mirrored prism, slow spin", beatSynced: false),
        .init(id: "vhs", label: "VHS", description: "Tape fuzz, tracking roll", beatSynced: false),
        .init(id: "glitch", label: "Glitch", description: "RGB-split digital bursts", beatSynced: true),
    ]

    private var selectedFreeEffect: MixbaseAPI.FreeEffectOption? {
        freeEffects.first { $0.id == freeEffect }
    }

    // Library state
    @State private var library: [Visualizer] = []
    @State private var isLoadingLibrary = true
    @State private var pinningUrl: String?    // url currently being pinned (spinner)

    // Save-to-Photos state: the url currently downloading (spinner) and the
    // last one that landed in Photos (brief checkmark so the tap visibly worked).
    @State private var savingToPhotosUrl: String?
    @State private var savedToPhotosUrl: String?

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

                            HStack(spacing: 16) {
                                Button(action: { Task { await pin(nil) } }) {
                                    HStack(spacing: 4) {
                                        Image(systemName: "pin.slash")
                                        Text("Unpin")
                                    }
                                    .font(.caption)
                                    .fontWeight(.medium)
                                    .foregroundColor(.gray)
                                }

                                saveToPhotosButton(url: pinnedUrl, labeled: true)
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

                    // MARK: - Free Generator
                    // Server-side render of the artwork into a seamless loop by
                    // the web generator's own effect engine — the web records a
                    // browser canvas, which this platform doesn't have.
                    if let artworkUrl, !artworkUrl.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Free Generator")
                                .font(.headline)
                                .foregroundColor(Color(hex: "#f0f0f0"))
                                .padding(.horizontal)

                            Text("Animates your artwork into a seamless loop — free, no AI credits.")
                                .font(.caption)
                                .foregroundColor(.gray)
                                .padding(.horizontal)

                            // Format picker
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(freeFormats, id: \.id) { format in
                                        chip(format.label, selected: freeFormat == format.id) {
                                            freeFormat = format.id
                                        }
                                    }
                                }
                                .padding(.horizontal)
                            }

                            // Effect picker
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(freeEffects, id: \.id) { effect in
                                        chip(effect.label, selected: freeEffect == effect.id) {
                                            freeEffect = effect.id
                                        }
                                    }
                                }
                                .padding(.horizontal)
                            }

                            if let selected = selectedFreeEffect {
                                Text(selected.description)
                                    .font(.caption)
                                    .foregroundColor(.gray)
                                    .padding(.horizontal)
                            }

                            // BPM — only beat-synced effects use it
                            if selectedFreeEffect?.beatSynced == true {
                                HStack(spacing: 8) {
                                    Text("Track BPM")
                                        .font(.caption)
                                        .foregroundColor(.gray)
                                    TextField("122", text: $freeBpm)
                                        .keyboardType(.numberPad)
                                        .font(.caption)
                                        .foregroundColor(Color(hex: "#f0f0f0"))
                                        .padding(8)
                                        .frame(width: 72)
                                        .background(Color(hex: "#161616"))
                                        .cornerRadius(8)
                                }
                                .padding(.horizontal)
                            }

                            Button(action: generateFree) {
                                HStack {
                                    if isFreeGenerating {
                                        ProgressView().tint(Color(hex: "#080808"))
                                        Text("Rendering…")
                                    } else {
                                        Image(systemName: "film")
                                        Text("Generate Free Visualizer")
                                    }
                                }
                                .font(.headline)
                                .foregroundColor(Color(hex: "#080808"))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(isFreeGenerating ? Color.gray.opacity(0.4) : Color(hex: "#2dd4bf"))
                                .cornerRadius(12)
                            }
                            .disabled(isFreeGenerating)
                            .padding(.horizontal)
                        }
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
        .task {
            await loadFreeEffects()
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

            // Download to Photos
            saveToPhotosButton(url: visualizer.videoUrl, labeled: false)

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

    // MARK: - Save to Photos
    // Shared by the pinned section (labeled) and library rows (icon-only).
    // Three states per url: downloading (spinner), just saved (checkmark), idle.
    @ViewBuilder
    private func saveToPhotosButton(url: String, labeled: Bool) -> some View {
        if savingToPhotosUrl == url {
            ProgressView().tint(Color(hex: "#2dd4bf"))
        } else if savedToPhotosUrl == url {
            HStack(spacing: 4) {
                Image(systemName: "checkmark")
                if labeled { Text("Saved") }
            }
            .font(.caption)
            .fontWeight(.semibold)
            .foregroundColor(Color(hex: "#2dd4bf"))
        } else {
            Button(action: { Task { await saveToPhotos(url) } }) {
                HStack(spacing: 4) {
                    Image(systemName: "square.and.arrow.down")
                    if labeled { Text(saveButtonLabel) }
                }
                .font(.caption)
                .fontWeight(.medium)
                .foregroundColor(labeled ? Color(hex: "#2dd4bf") : .gray)
            }
            .disabled(savingToPhotosUrl != nil)
        }
    }

    /// iOS saves into the Photos library; macOS downloads into ~/Downloads.
    private var saveButtonLabel: String {
        #if os(iOS)
        "Save to Photos"
        #else
        "Save to Downloads"
        #endif
    }

    private func saveToPhotos(_ url: String) async {
        savingToPhotosUrl = url
        errorMessage = nil
        do {
            try await PhotoLibrarySaver.saveVideo(from: url)
            savedToPhotosUrl = url
            // Let the checkmark breathe, then return to the download icon.
            Task {
                try? await Task.sleep(for: .seconds(2.5))
                if savedToPhotosUrl == url { savedToPhotosUrl = nil }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        savingToPhotosUrl = nil
    }

    // MARK: - Chip
    private func chip(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.caption)
                .fontWeight(.medium)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .foregroundColor(selected ? Color(hex: "#080808") : Color(hex: "#f0f0f0"))
                .background(selected ? Color(hex: "#2dd4bf") : Color(hex: "#222222"))
                .clipShape(Capsule())
        }
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

    // Keep the built-in list when the fetch fails or comes back empty — the
    // picker must never go blank.
    private func loadFreeEffects() async {
        do {
            let effects = try await MixbaseAPI.shared.fetchFreeVisualizerEffects()
            guard !effects.isEmpty else { return }
            freeEffects = effects
            if !effects.contains(where: { $0.id == freeEffect }) {
                freeEffect = effects[0].id
            }
        } catch {
            print("VisualizerView: failed to load free effects — \(error.localizedDescription)")
        }
    }

    private func generateFree() {
        guard let artworkUrl else { return }
        isFreeGenerating = true
        errorMessage = nil

        Task {
            do {
                let url = try await MixbaseAPI.shared.generateFreeVisualizer(
                    projectId: projectId,
                    imageUrl: artworkUrl,
                    format: freeFormat,
                    effect: freeEffect,
                    bpm: selectedFreeEffect?.beatSynced == true ? Int(freeBpm) : nil
                )
                // Free renders always persist server-side — pin for instant
                // payoff and refresh the library so it appears there too.
                await pin(url)
                await loadLibrary()
            } catch {
                errorMessage = error.localizedDescription
            }
            isFreeGenerating = false
        }
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

#if os(iOS)
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
#else
struct LoopingVideoPlayer: NSViewRepresentable {

    let url: URL

    func makeNSView(context: Context) -> LoopingPlayerNSView {
        LoopingPlayerNSView(url: url)
    }

    func updateNSView(_ nsView: LoopingPlayerNSView, context: Context) {
        nsView.update(url: url)
    }

    static func dismantleNSView(_ nsView: LoopingPlayerNSView, coordinator: ()) {
        nsView.stop()
    }
}

// macOS twin of LoopingPlayerUIView below: NSView backed by an AVPlayerLayer,
// always-on gapless loop for library previews.
final class LoopingPlayerNSView: NSView {

    private var player: AVQueuePlayer?
    private var looper: AVPlayerLooper?
    private var currentUrl: URL?

    private var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }

    override func makeBackingLayer() -> CALayer { AVPlayerLayer() }

    init(url: URL) {
        super.init(frame: .zero)
        wantsLayer = true
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
#endif

#if os(iOS)
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
#endif
