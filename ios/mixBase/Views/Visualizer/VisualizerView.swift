import SwiftUI
import AVKit

// MARK: - VisualizerView
// Spotify-Canvas-style visualizers for a project, matching the web Visualizer
// tab: a pinned looping video up top, a generator that turns the project's
// artwork into motion via Runway (server-side, tier-gated), and the user's
// saved library where any video can be pinned to this project or deleted.

struct VisualizerView: View {

    let projectId: UUID
    let projectTitle: String
    let artworkUrl: String?

    // The currently pinned visualizer (project.visualizer_url)
    @State var pinnedUrl: String?

    // Lets the presenting screen update its copy of the pin immediately
    var onPinChanged: ((String?) -> Void)? = nil

    // Generator state
    @State private var models: [RunwayModel] = []
    @State private var selectedModelId = "gen4_turbo"
    @State private var selectedDuration = 5
    @State private var selectedRatio = "720:1280"
    @State private var motionPrompt = ""
    @State private var isGenerating = false

    // Free generator state (server-side ffmpeg render — no AI credits).
    // Options are the static contract of /api/visualizer/free.
    @State private var freeFormat = "canvas"
    @State private var freeEffect = "drift"
    @State private var freeBpm = "122"
    @State private var isFreeGenerating = false

    private let freeFormats: [(id: String, label: String)] = [
        ("canvas", "9:16 Canvas"), ("square", "1:1 Square"), ("youtube", "16:9 YouTube"),
    ]
    private let freeEffects: [(id: String, label: String)] = [
        ("drift", "Cinematic Drift"), ("pulse", "Deep Pulse"), ("orbit", "Orbit"),
    ]

    // Library state
    @State private var library: [Visualizer] = []
    @State private var isLoadingLibrary = true
    @State private var pinningUrl: String?    // url currently being pinned (spinner)

    // Save-to-Photos state: the url currently downloading (spinner) and the
    // last one that landed in Photos (brief checkmark so the tap visibly worked).
    @State private var savingToPhotosUrl: String?
    @State private var savedToPhotosUrl: String?

    @State private var errorMessage: String?

    private var selectedModel: RunwayModel? {
        models.first(where: { $0.id == selectedModelId })
    }

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
                            Text("No visualizer pinned yet — generate one from your artwork below, or pin one from your library.")
                                .font(.subheadline)
                                .foregroundColor(.gray)
                                .padding(.horizontal)
                        }
                    }

                    // MARK: - Generator
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Generate from Artwork")
                            .font(.headline)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                            .padding(.horizontal)

                        if let artworkUrl, let url = URL(string: artworkUrl) {
                            HStack(spacing: 12) {
                                AsyncImage(url: url) { image in
                                    image.resizable().aspectRatio(contentMode: .fill)
                                } placeholder: {
                                    RoundedRectangle(cornerRadius: 8).fill(Color(hex: "#1a1a1a"))
                                }
                                .frame(width: 64, height: 64)
                                .clipShape(RoundedRectangle(cornerRadius: 8))

                                Text("The current project artwork becomes a seamless motion loop.")
                                    .font(.caption)
                                    .foregroundColor(.gray)
                            }
                            .padding(.horizontal)

                            // Model picker
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(models) { model in
                                        chip(model.label, selected: selectedModelId == model.id) {
                                            selectedModelId = model.id
                                            // Snap duration/ratio to values this model supports
                                            if !model.durations.contains(selectedDuration) {
                                                selectedDuration = model.durations.first ?? 5
                                            }
                                            if !model.ratios.contains(where: { $0.value == selectedRatio }) {
                                                selectedRatio = model.ratios.first?.value ?? "720:1280"
                                            }
                                        }
                                    }
                                }
                                .padding(.horizontal)
                            }

                            // Duration picker
                            if let model = selectedModel, model.durations.count > 1 {
                                ScrollView(.horizontal, showsIndicators: false) {
                                    HStack(spacing: 8) {
                                        ForEach(model.durations, id: \.self) { duration in
                                            chip("\(duration)s", selected: selectedDuration == duration) {
                                                selectedDuration = duration
                                            }
                                        }
                                    }
                                    .padding(.horizontal)
                                }
                            }

                            // Ratio picker
                            if let model = selectedModel {
                                ScrollView(.horizontal, showsIndicators: false) {
                                    HStack(spacing: 8) {
                                        ForEach(model.ratios, id: \.value) { ratio in
                                            chip(ratio.label, selected: selectedRatio == ratio.value) {
                                                selectedRatio = ratio.value
                                            }
                                        }
                                    }
                                    .padding(.horizontal)
                                }
                            }

                            // Optional motion prompt
                            TextField("Motion (optional) — e.g. slow dolly-in, drifting smoke", text: $motionPrompt, axis: .vertical)
                                .font(.caption)
                                .foregroundColor(Color(hex: "#f0f0f0"))
                                .padding(10)
                                .background(Color(hex: "#161616"))
                                .cornerRadius(8)
                                .lineLimit(2...4)
                                .padding(.horizontal)

                            // Generate button
                            Button(action: generate) {
                                HStack {
                                    if isGenerating {
                                        ProgressView().tint(Color(hex: "#080808"))
                                        Text("Generating — takes a few minutes...")
                                    } else {
                                        Image(systemName: "sparkles.tv")
                                        Text("Generate Visualizer")
                                    }
                                }
                                .font(.headline)
                                .foregroundColor(Color(hex: "#080808"))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(isGenerating ? Color.gray.opacity(0.4) : Color(hex: "#2dd4bf"))
                                .cornerRadius(12)
                            }
                            .disabled(isGenerating)
                            .padding(.horizontal)
                        } else {
                            Text("Add artwork to this project first — the visualizer animates your cover art.")
                                .font(.subheadline)
                                .foregroundColor(.gray)
                                .padding(.horizontal)
                        }

                        if let errorMessage {
                            Text(errorMessage)
                                .font(.caption)
                                .foregroundColor(.red)
                                .padding(.horizontal)
                        }
                    }

                    // MARK: - Free Generator
                    // Server-side ffmpeg render of the artwork into a seamless
                    // loop — the iOS counterpart of the web's free generator
                    // (which records a browser canvas this platform doesn't have).
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

                            // BPM — only the beat-synced effect uses it
                            if freeEffect == "pulse" {
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
                            .disabled(isFreeGenerating || isGenerating)
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
            await loadModels()
            await loadLibrary()
        }
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
                    if labeled { Text("Save to Photos") }
                }
                .font(.caption)
                .fontWeight(.medium)
                .foregroundColor(labeled ? Color(hex: "#2dd4bf") : .gray)
            }
            .disabled(savingToPhotosUrl != nil)
        }
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

    // MARK: - Actions

    private func loadModels() async {
        do {
            let fetched = try await MixbaseAPI.shared.fetchRunwayModels()
            if !fetched.isEmpty {
                models = fetched
                if !fetched.contains(where: { $0.id == selectedModelId }) {
                    selectedModelId = fetched[0].id
                }
                if let model = models.first(where: { $0.id == selectedModelId }) {
                    selectedDuration = model.durations.first ?? 5
                    selectedRatio = model.ratios.first?.value ?? "720:1280"
                }
            }
        } catch {
            // Fall back to the workhorse default so generation still works
            models = [RunwayModel(
                id: "gen4_turbo",
                label: "Gen-4 Turbo",
                durations: [5, 10],
                ratios: [
                    RunwayRatio(value: "720:1280", label: "9:16 portrait"),
                    RunwayRatio(value: "1280:720", label: "16:9 landscape"),
                    RunwayRatio(value: "960:960", label: "1:1 square"),
                ]
            )]
        }
    }

    private func loadLibrary() async {
        isLoadingLibrary = true
        do {
            library = try await MixbaseAPI.shared.fetchVisualizers()
        } catch {
            print("VisualizerView: failed to load library — \(error.localizedDescription)")
        }
        isLoadingLibrary = false
    }

    private func generate() {
        guard let artworkUrl else { return }
        isGenerating = true
        errorMessage = nil

        Task {
            do {
                let result = try await MixbaseAPI.shared.generateVisualizer(
                    projectId: projectId,
                    imageUrl: artworkUrl,
                    model: selectedModelId,
                    duration: selectedDuration,
                    ratio: selectedRatio,
                    prompt: motionPrompt
                )
                // Pin the fresh video so the payoff is immediate, then refresh
                // the library so it appears there too.
                if result.saved {
                    await pin(result.videoUrl)
                    await loadLibrary()
                } else {
                    // Persistence failed server-side; the URL is a transient
                    // Runway link. Still show it, but don't pin a URL that expires.
                    pinnedUrl = result.videoUrl
                }
            } catch {
                errorMessage = error.localizedDescription
            }
            isGenerating = false
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
                    bpm: freeEffect == "pulse" ? Int(freeBpm) : nil
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
