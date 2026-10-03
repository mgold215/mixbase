import SwiftUI
import AVKit
#if os(macOS)
import AppKit
#endif

// MARK: - VisualizerView
// Visualizers for a project: the pinned loops up top (the vertical,
// Spotify-Canvas-style loop the player shows, plus an optional 16:9 one), the
// FREE server-side generator (the web's own effect engine — no AI), finished
// YouTube/Shorts renders (every account; no AI, no allowance), and the saved
// library where any video can be pinned to this project or deleted.
//
// Owner-only extras — the moving cover and AI video — appear only when
// AuthService.ownerTools is true. The server refuses those routes for every
// other account regardless; this only decides what is shown. Nothing on this
// screen is ever sold (there are no paid plans anywhere).

struct VisualizerView: View {

    let projectId: UUID
    let projectTitle: String
    // Source image for the generators — the clean artwork, never the
    // lettered (finalized) cover.
    let artworkUrl: String?

    // The project's pins: visualizer_url (vertical — the player loop and the
    // Shorts source) and visualizer_wide_url (16:9 — the YouTube source).
    @State var pinnedUrl: String?
    @State private var pinnedWideUrl: String?

    // Lets the presenting screen update its copy of the pins immediately
    var onPinChanged: ((String?) -> Void)? = nil
    var onWidePinChanged: ((String?) -> Void)? = nil

    @ObservedObject private var authService = AuthService.shared

    init(
        projectId: UUID,
        projectTitle: String,
        artworkUrl: String?,
        pinnedUrl: String?,
        pinnedWideUrl: String? = nil,
        onPinChanged: ((String?) -> Void)? = nil,
        onWidePinChanged: ((String?) -> Void)? = nil
    ) {
        self.projectId = projectId
        self.projectTitle = projectTitle
        self.artworkUrl = artworkUrl
        self._pinnedUrl = State(initialValue: pinnedUrl)
        self._pinnedWideUrl = State(initialValue: pinnedWideUrl)
        self.onPinChanged = onPinChanged
        self.onWidePinChanged = onWidePinChanged
    }

    // Free generator state (server-side render of the web generator's own
    // effect engine — no AI). The effect list is refreshed from
    // GET /api/visualizer/free; this built-in copy mirrors the web's
    // (src/lib/free-effects.ts) so the picker is complete even offline.
    @State private var freeFormat = "canvas"
    @State private var freeEffect = "kenburns"
    @State private var freeBpm = "122"
    @State private var isFreeGenerating = false
    @State private var freeEffects: [MixbaseAPI.FreeEffectOption] = VisualizerView.builtInFreeEffects

    // Also the moving cover's formats (both render FREE_FORMATS server-side).
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

    // Moving cover (owner-only): the Cassette Studio cover animated, no AI.
    @State private var motionAvailability: MixbaseAPI.MotionAvailability?
    @State private var isLoadingMotion = false
    @State private var motionFormat = "canvas"
    @State private var isRenderingMotion = false
    @State private var motionError: String?

    // AI video (owner-only).
    @State private var aiModels: [MixbaseAPI.AIVideoModel] = []
    @State private var isLoadingAIModels = false
    @State private var aiModelId = ""
    @State private var aiDuration = 0
    @State private var aiRatio = ""
    @State private var aiPrompt = ""
    @State private var isGeneratingAI = false
    @State private var aiError: String?
    // Set when a clip came back but could not be persisted: the provider's
    // temporary link (expires within hours, can't be pinned).
    @State private var aiTemporaryUrl: String?

    // Finished renders (every account).
    @State private var finishFormat = "youtube"
    @State private var finishClipSeconds = 30
    @State private var finishStartMode = "hook"
    @State private var finishColor = "#FFFFFF"
    @State private var finishJob: MixbaseAPI.FinishedVideoJob?
    @State private var isStartingFinish = false
    @State private var finishError: String?
    @State private var latestFinished: MixbaseAPI.LatestFinishedVideos?
    @State private var finishPollTask: Task<Void, Never>?

    private let finishFormats: [(id: String, label: String)] = [
        ("youtube", "YouTube 16:9"), ("shorts", "Shorts 9:16"),
    ]
    private let finishClipLengths: [Int] = [15, 30, 60]
    private let finishStartModes: [(id: String, label: String)] = [
        ("start", "Intro"), ("hook", "Hook"), ("middle", "Middle"),
    ]

    // Library state
    @State private var library: [Visualizer] = []
    @State private var isLoadingLibrary = true
    @State private var pinningUrl: String?    // url currently being pinned (spinner)
    // Bumped on every pin/unpin so a slower on-appear refresh of the pins
    // never overwrites a change the user just made.
    @State private var pinEdits = 0

    // Save-to-Photos state: the url currently downloading (spinner) and the
    // last one that landed in Photos (brief checkmark so the tap visibly worked).
    @State private var savingToPhotosUrl: String?
    @State private var savedToPhotosUrl: String?

    @State private var errorMessage: String?

    private var finishBusy: Bool {
        isStartingFinish || finishJob != nil
    }

    var body: some View {
        ZStack {
            Color(hex: "#080808")
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    // MARK: - Pinned Visualizers
                    pinnedSection

                    // Pin/delete errors surface here
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
                        freeGeneratorSection
                    }

                    // MARK: - Owner-only tools
                    if authService.ownerTools {
                        movingCoverSection
                        aiVideoSection
                    }

                    // MARK: - Finished Video (every account)
                    finishedSection

                    // MARK: - Library
                    librarySection

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
        .task {
            await refreshPins()
        }
        .task {
            await loadLatestFinished()
        }
        .task(id: authService.ownerTools) {
            await loadOwnerTools()
        }
        .onAppear {
            // Back on screen with this project's render still in flight —
            // after a tab switch (view kept alive) or after leaving and
            // reopening the screen (fresh view): pick the polling up again.
            resumeFinishIfNeeded()
        }
        .onDisappear {
            // Stop polling while off screen. The render itself keeps going
            // server-side, and FinishedRenderJobs remembers it, so coming
            // back resumes the progress.
            finishPollTask?.cancel()
            finishPollTask = nil
        }
    }

    // MARK: - Pinned section
    @ViewBuilder
    private var pinnedSection: some View {
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
                    Button(action: { Task { await pin(nil, wide: false) } }) {
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
            } else if pinnedWideUrl == nil {
                Text("No visualizer pinned yet — pin one from your library below.")
                    .font(.subheadline)
                    .foregroundColor(.gray)
                    .padding(.horizontal)
            }

            if let pinnedWideUrl, let url = URL(string: pinnedWideUrl) {
                Text("16:9 loop · used for YouTube renders")
                    .font(.caption)
                    .fontWeight(.semibold)
                    .foregroundColor(.gray)
                    .padding(.horizontal)
                    .padding(.top, 6)

                LoopingVideoPlayer(url: url)
                    .aspectRatio(16.0 / 9.0, contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .padding(.horizontal)

                HStack(spacing: 16) {
                    Button(action: { Task { await pin(nil, wide: true) } }) {
                        HStack(spacing: 4) {
                            Image(systemName: "pin.slash")
                            Text("Unpin")
                        }
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundColor(.gray)
                    }

                    saveToPhotosButton(url: pinnedWideUrl, labeled: true)
                }
                .padding(.horizontal)
            }
        }
    }

    // MARK: - Free generator section
    @ViewBuilder
    private var freeGeneratorSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("Free Generator", subtitle: "Animates your artwork into a seamless loop. No AI involved.")

            // Format picker
            formatPicker(freeFormats, selection: $freeFormat)

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
                primaryButtonLabel(
                    busy: isFreeGenerating,
                    busyText: "Rendering…",
                    icon: "film",
                    text: "Generate Free Visualizer",
                    enabled: !isFreeGenerating
                )
            }
            .disabled(isFreeGenerating)
            .padding(.horizontal)
        }
    }

    // MARK: - Moving cover section (owner-only)
    @ViewBuilder
    private var movingCoverSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("Moving Cover", subtitle: "Your Cassette Studio cover as a loop: the reels turn, the camera drifts. No AI.")

            if let availability = motionAvailability {
                if availability.available {
                    formatPicker(freeFormats, selection: $motionFormat)

                    Button(action: renderMotion) {
                        primaryButtonLabel(
                            busy: isRenderingMotion,
                            busyText: "Rendering…",
                            icon: "play.rectangle",
                            text: "Make it move",
                            enabled: !isRenderingMotion
                        )
                    }
                    .disabled(isRenderingMotion)
                    .padding(.horizontal)
                } else {
                    Text(availability.reason ?? "Make a cover in Cassette Studio first.")
                        .font(.caption)
                        .foregroundColor(.gray)
                        .padding(.horizontal)
                }
            } else if isLoadingMotion {
                HStack {
                    ProgressView().tint(Color(hex: "#2dd4bf"))
                    Spacer()
                }
                .padding(.horizontal)
            }

            if let motionError {
                Text(motionError)
                    .font(.caption)
                    .foregroundColor(.red)
                    .padding(.horizontal)
            }
        }
    }

    // MARK: - AI video section (owner-only)
    @ViewBuilder
    private var aiVideoSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("AI Video", subtitle: "Turns your artwork into a short AI-animated clip.")

            if artworkUrl?.isEmpty == false {
                if aiModels.isEmpty {
                    if isLoadingAIModels {
                        HStack {
                            ProgressView().tint(Color(hex: "#2dd4bf"))
                            Spacer()
                        }
                        .padding(.horizontal)
                    }
                } else {
                    // Model
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(aiModels) { model in
                                chip(model.label, selected: aiModelId == model.id) {
                                    selectAIModel(model)
                                }
                            }
                        }
                        .padding(.horizontal)
                    }

                    if let model = selectedAIModel {
                        // Duration
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(model.durations, id: \.self) { seconds in
                                    chip("\(seconds)s", selected: aiDuration == seconds) {
                                        aiDuration = seconds
                                    }
                                }
                            }
                            .padding(.horizontal)
                        }

                        // Aspect ratio
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(model.ratios, id: \.value) { ratio in
                                    chip(ratio.label, selected: aiRatio == ratio.value) {
                                        aiRatio = ratio.value
                                    }
                                }
                            }
                            .padding(.horizontal)
                        }
                    }

                    TextField("Motion (optional), e.g. slow push-in, rain falling", text: $aiPrompt, axis: .vertical)
                        .font(.subheadline)
                        .foregroundColor(Color(hex: "#f0f0f0"))
                        .lineLimit(2...5)
                        .padding(10)
                        .background(Color(hex: "#161616"))
                        .cornerRadius(10)
                        .padding(.horizontal)
                        .onChange(of: aiPrompt) { _, newValue in
                            if newValue.count > 1000 {
                                aiPrompt = String(newValue.prefix(1000))
                            }
                        }

                    Button(action: generateAI) {
                        primaryButtonLabel(
                            busy: isGeneratingAI,
                            busyText: "Generating… (up to 5 min)",
                            icon: "sparkles",
                            text: "Generate AI video",
                            enabled: !isGeneratingAI && selectedAIModel != nil
                        )
                    }
                    .disabled(isGeneratingAI || selectedAIModel == nil)
                    .padding(.horizontal)
                }

                if let aiTemporaryUrl, let url = URL(string: aiTemporaryUrl) {
                    Text("Generated, but it couldn't be saved to your library. This link is temporary and can't be pinned. Save it now to keep it.")
                        .font(.caption)
                        .foregroundColor(.gray)
                        .padding(.horizontal)

                    LoopingVideoPlayer(url: url)
                        .frame(height: 240)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        .padding(.horizontal)

                    saveToPhotosButton(url: aiTemporaryUrl, labeled: true)
                        .padding(.horizontal)
                }
            } else {
                Text("Add artwork to this project first.")
                    .font(.caption)
                    .foregroundColor(.gray)
                    .padding(.horizontal)
            }

            if let aiError {
                Text(aiError)
                    .font(.caption)
                    .foregroundColor(.red)
                    .padding(.horizontal)
            }
        }
    }

    // MARK: - Finished video section (every account)
    @ViewBuilder
    private var finishedSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("Finished Video", subtitle: "Your pinned loop, your latest mix and your title, rendered for YouTube or Shorts.")

            if pinnedUrl == nil && pinnedWideUrl == nil {
                Text("Pin a visualizer above first.")
                    .font(.caption)
                    .foregroundColor(.gray)
                    .padding(.horizontal)
            } else {
                formatPicker(finishFormats, selection: $finishFormat)

                if finishFormat == "shorts" {
                    HStack(spacing: 8) {
                        Text("Length")
                            .font(.caption)
                            .foregroundColor(.gray)
                            .frame(width: 52, alignment: .leading)
                        ForEach(finishClipLengths, id: \.self) { seconds in
                            chip("\(seconds)s", selected: finishClipSeconds == seconds) {
                                finishClipSeconds = seconds
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal)

                    HStack(spacing: 8) {
                        Text("Start")
                            .font(.caption)
                            .foregroundColor(.gray)
                            .frame(width: 52, alignment: .leading)
                        ForEach(finishStartModes, id: \.id) { mode in
                            chip(mode.label, selected: finishStartMode == mode.id) {
                                finishStartMode = mode.id
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal)
                }

                Text("Text colour")
                    .font(.caption)
                    .foregroundColor(.gray)
                    .padding(.horizontal)

                finishColorPicker

                if let job = finishJob {
                    VStack(alignment: .leading, spacing: 6) {
                        ProgressView(value: min(max(job.progress ?? 0, 0), 100), total: 100)
                            .tint(Color(hex: "#2dd4bf"))
                        Text(Self.finishProgressText(job))
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                    .padding(.horizontal)
                }

                Button(action: startFinish) {
                    primaryButtonLabel(
                        busy: finishBusy,
                        busyText: "Rendering…",
                        icon: "film",
                        text: finishFormat == "shorts" ? "Render Short" : "Render YouTube video",
                        enabled: !finishBusy
                    )
                }
                .disabled(finishBusy)
                .padding(.horizontal)
            }

            if let finishError {
                Text(finishError)
                    .font(.caption)
                    .foregroundColor(.red)
                    .padding(.horizontal)
            }

            if let latest = latestFinished {
                finishedRow(latest.youtube, label: "YouTube", wide: true)
                finishedRow(latest.shorts, label: "Short", wide: false)
            }
        }
    }

    private var finishColorPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(CoverTextColors.all) { option in
                    Button(action: { finishColor = option.value }) {
                        Circle()
                            .fill(Color(hex: option.value))
                            .frame(width: 28, height: 28)
                            .overlay(
                                Circle()
                                    .stroke(
                                        finishColor == option.value ? Color(hex: "#2dd4bf") : Color(hex: "#333333"),
                                        lineWidth: finishColor == option.value ? 3 : 1
                                    )
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text(option.label))
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 2)
        }
    }

    @ViewBuilder
    private func finishedRow(_ video: Visualizer?, label: String, wide: Bool) -> some View {
        if let video, let url = URL(string: video.videoUrl) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Latest \(label)")
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundColor(Color(hex: "#f0f0f0"))
                    Spacer()
                    Text(video.createdAt, style: .date)
                        .font(.caption2)
                        .foregroundColor(.gray)
                }

                if wide {
                    LoopingVideoPlayer(url: url)
                        .aspectRatio(16.0 / 9.0, contentMode: .fit)
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                } else {
                    LoopingVideoPlayer(url: url)
                        .frame(width: 180, height: 320)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }

                saveToPhotosButton(url: video.videoUrl, labeled: true)
            }
            .padding(.horizontal)
        }
    }

    // MARK: - Library section
    @ViewBuilder
    private var librarySection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Your Videos")
                .font(.headline)
                .foregroundColor(Color(hex: "#f0f0f0"))
                .padding(.horizontal)

            if isLoadingLibrary && library.isEmpty {
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
    }

    // MARK: - Library Row
    @ViewBuilder
    private func libraryRow(_ visualizer: Visualizer) -> some View {
        let isPinned = visualizer.videoUrl == pinnedUrl
        let isPinnedWide = visualizer.videoUrl == pinnedWideUrl
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
            } else if isPinned || isPinnedWide {
                HStack(spacing: 3) {
                    Image(systemName: "pin.fill")
                    Text(isPinnedWide && !isPinned ? "Pinned 16:9" : "Pinned")
                }
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(Color(hex: "#2dd4bf"))
            } else {
                Button(action: { Task { await pin(visualizer.videoUrl, wide: Self.isWide(visualizer)) } }) {
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

    /// Library rows carry no dimensions, so infer the pin slot from what made
    /// the video: finished YouTube renders and anything rendered in the
    /// YouTube format ("YouTube · Cinematic Drift", "Moving cover · YouTube")
    /// are 16:9 and pin wide; everything else pins vertical.
    private static func isWide(_ visualizer: Visualizer) -> Bool {
        if visualizer.kind == "youtube" { return true }
        if visualizer.kind == "shorts" { return false }
        return (visualizer.title ?? "").localizedCaseInsensitiveContains("youtube")
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

    // MARK: - Building blocks

    private func sectionHeader(_ title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.headline)
                .foregroundColor(Color(hex: "#f0f0f0"))
            Text(subtitle)
                .font(.caption)
                .foregroundColor(.gray)
        }
        .padding(.horizontal)
    }

    private func formatPicker(_ options: [(id: String, label: String)], selection: Binding<String>) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(options, id: \.id) { option in
                    chip(option.label, selected: selection.wrappedValue == option.id) {
                        selection.wrappedValue = option.id
                    }
                }
            }
            .padding(.horizontal)
        }
    }

    private func primaryButtonLabel(busy: Bool, busyText: String, icon: String, text: String, enabled: Bool) -> some View {
        HStack {
            if busy {
                ProgressView().tint(Color(hex: "#080808"))
                Text(busyText)
            } else {
                Image(systemName: icon)
                Text(text)
            }
        }
        .font(.headline)
        .foregroundColor(Color(hex: "#080808"))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .background(enabled ? Color(hex: "#2dd4bf") : Color.gray.opacity(0.4))
        .cornerRadius(12)
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

    /// Re-read both pins from the project row. The Media library opens this
    /// screen without knowing them, and the presenter's copy can be stale.
    private func refreshPins() async {
        let editsBefore = pinEdits
        let project: Project
        do {
            project = try await SupabaseService.shared.fetchProject(id: projectId)
        } catch {
            print("VisualizerView: failed to refresh pins — \(error.localizedDescription)")
            return
        }
        // A pin/unpin landed while this was in flight — it is newer.
        guard pinEdits == editsBefore else { return }
        if project.visualizerUrl != pinnedUrl {
            pinnedUrl = project.visualizerUrl
            onPinChanged?(project.visualizerUrl)
        }
        if project.visualizerWideUrl != pinnedWideUrl {
            pinnedWideUrl = project.visualizerWideUrl
            onWidePinChanged?(project.visualizerWideUrl)
        }
    }

    private func generateFree() {
        guard let artworkUrl else { return }
        let format = freeFormat
        isFreeGenerating = true
        errorMessage = nil

        Task {
            do {
                let url = try await MixbaseAPI.shared.generateFreeVisualizer(
                    projectId: projectId,
                    imageUrl: artworkUrl,
                    format: format,
                    effect: freeEffect,
                    bpm: selectedFreeEffect?.beatSynced == true ? Int(freeBpm) : nil
                )
                // Free renders always persist server-side — pin for instant
                // payoff (16:9 into the wide slot) and refresh the library so
                // it appears there too.
                await pin(url, wide: format == "youtube")
                await loadLibrary()
            } catch {
                errorMessage = error.localizedDescription
            }
            isFreeGenerating = false
        }
    }

    // MARK: Owner tools

    private func loadOwnerTools() async {
        guard authService.ownerTools else { return }
        await loadMotionAvailability()
        await loadAIModels()
    }

    private func loadMotionAvailability() async {
        isLoadingMotion = true
        motionError = nil
        do {
            motionAvailability = try await MixbaseAPI.shared.cassetteMotionAvailability(projectId: projectId)
        } catch {
            motionAvailability = nil
            motionError = error.localizedDescription
        }
        isLoadingMotion = false
    }

    private func renderMotion() {
        let format = motionFormat
        isRenderingMotion = true
        motionError = nil
        errorMessage = nil

        Task {
            do {
                let url = try await MixbaseAPI.shared.renderCassetteMotion(projectId: projectId, format: format)
                await pin(url, wide: format == "youtube")
                await loadLibrary()
            } catch {
                motionError = error.localizedDescription
            }
            isRenderingMotion = false
        }
    }

    private func loadAIModels() async {
        isLoadingAIModels = true
        do {
            let models = try await MixbaseAPI.shared.fetchAIVideoModels()
            aiModels = models
            if let first = models.first, !models.contains(where: { $0.id == aiModelId }) {
                selectAIModel(first)
            }
        } catch {
            aiError = error.localizedDescription
        }
        isLoadingAIModels = false
    }

    private var selectedAIModel: MixbaseAPI.AIVideoModel? {
        aiModels.first { $0.id == aiModelId }
    }

    /// Select a model and keep duration/ratio valid for it (portrait 9:16 by
    /// default, like the server).
    private func selectAIModel(_ model: MixbaseAPI.AIVideoModel) {
        aiModelId = model.id
        if !model.durations.contains(aiDuration) {
            aiDuration = model.durations.first ?? 5
        }
        if !model.ratios.contains(where: { $0.value == aiRatio }) {
            aiRatio = model.ratios.first(where: { $0.value == "720:1280" })?.value
                ?? model.ratios.first?.value
                ?? ""
        }
    }

    private func generateAI() {
        guard let imageUrl = artworkUrl, !imageUrl.isEmpty, let model = selectedAIModel else { return }
        let duration = aiDuration
        let ratio = aiRatio
        let prompt = aiPrompt
        let wide = model.ratios.first(where: { $0.value == ratio })?.isLandscape ?? false
        isGeneratingAI = true
        aiError = nil
        aiTemporaryUrl = nil
        errorMessage = nil

        Task {
            do {
                let result = try await MixbaseAPI.shared.generateAIVideo(
                    projectId: projectId,
                    imageUrl: imageUrl,
                    model: model.id,
                    duration: duration,
                    ratio: ratio,
                    promptText: prompt
                )
                if result.saved {
                    // Landscape ratios pin into the 16:9 slot.
                    await pin(result.videoUrl, wide: wide)
                } else {
                    aiTemporaryUrl = result.videoUrl
                }
                await loadLibrary()
            } catch {
                if error is URLError {
                    // A dropped connection or timeout doesn't mean the render
                    // failed — the server may still save it.
                    aiError = "Lost the connection while generating. If it finished, it will appear in Your Videos below."
                } else {
                    aiError = error.localizedDescription
                }
                await loadLibrary()
            }
            isGeneratingAI = false
        }
    }

    // MARK: Finished renders

    private func loadLatestFinished() async {
        do {
            latestFinished = try await MixbaseAPI.shared.latestFinishedVideos(projectId: projectId)
        } catch {
            print("VisualizerView: failed to load finished videos — \(error.localizedDescription)")
        }
    }

    private func startFinish() {
        let format = finishFormat
        let color = finishColor
        let clipSeconds = finishClipSeconds
        let startMode = finishStartMode
        isStartingFinish = true
        finishError = nil

        Task {
            do {
                let result = try await MixbaseAPI.shared.startFinishedVideo(
                    projectId: projectId,
                    format: format,
                    color: color,
                    clipSeconds: format == "shorts" ? clipSeconds : nil,
                    startMode: format == "shorts" ? startMode : nil
                )
                isStartingFinish = false
                switch result {
                case .started(let job):
                    await handleFinishJob(job, format: format)
                case .alreadyRunning(let jobId, let message):
                    // The server allows one render per ACCOUNT, so the running
                    // job may be another song or the other format. Re-attach
                    // only when it is the render this app recorded for THIS
                    // project; otherwise say so and leave the screen idle —
                    // never pass someone else's job off as this request.
                    if let jobId,
                       let entry = FinishedRenderJobs.shared.entry(for: projectId, userId: authService.userId),
                       entry.jobId == jobId {
                        resumeFinish(entry)
                        if entry.format != format {
                            finishError = Self.shortError(message) ?? message
                        }
                    } else {
                        finishError = Self.shortError(message) ?? "A render is already running — wait for it to finish"
                    }
                }
            } catch {
                isStartingFinish = false
                finishError = Self.shortError(error.localizedDescription) ?? "Could not start the render. Please try again."
            }
        }
    }

    private func handleFinishJob(_ job: MixbaseAPI.FinishedVideoJob, format: String) async {
        if job.status == "done" {
            FinishedRenderJobs.shared.clear(projectId: projectId, jobId: job.jobId)
            finishJob = nil
            await loadLibrary()
            await loadLatestFinished()
        } else if job.status == "error" {
            FinishedRenderJobs.shared.clear(projectId: projectId, jobId: job.jobId)
            finishJob = nil
            finishError = Self.shortError(job.error) ?? "The render failed. Please try again."
        } else {
            // Remember it outside this view, so leaving the screen and coming
            // back shows the live progress instead of an idle Render button.
            if let userId = authService.userId {
                FinishedRenderJobs.shared.record(
                    FinishedRenderJobs.Entry(
                        jobId: job.jobId,
                        format: job.format ?? format,
                        userId: userId,
                        startedAt: Date()
                    ),
                    for: projectId
                )
            }
            finishJob = job
            finishPollTask?.cancel()
            let jobId = job.jobId
            finishPollTask = Task {
                await pollFinish(jobId: jobId)
            }
        }
    }

    /// Pick this project's running render back up, if the app started one
    /// that has not settled yet. Called on every appearance: the view may be
    /// the same one (tab switch) or a brand-new one whose @State never saw
    /// the render (the screen was popped or the sheet swiped away).
    private func resumeFinishIfNeeded() {
        guard finishPollTask == nil else { return }
        if let entry = FinishedRenderJobs.shared.entry(for: projectId, userId: authService.userId) {
            finishError = nil
            resumeFinish(entry)
        } else if finishJob != nil {
            // Settled while this screen was hidden; the .task on appear
            // reloads the latest renders.
            finishJob = nil
        }
    }

    /// Show a recorded render's progress and poll it (first poll right away).
    private func resumeFinish(_ entry: FinishedRenderJobs.Entry) {
        if finishJob?.jobId != entry.jobId {
            finishJob = MixbaseAPI.FinishedVideoJob(
                jobId: entry.jobId,
                status: "rendering",
                progress: nil,
                stage: "Rendering",
                format: entry.format,
                videoUrl: nil,
                error: nil
            )
        }
        finishPollTask?.cancel()
        let jobId = entry.jobId
        finishPollTask = Task {
            await pollFinish(jobId: jobId, immediately: true)
        }
    }

    /// Poll every 2.5 s until the job is done, failed, or gone (404).
    /// `immediately` skips the first wait (resuming a render already under way).
    private func pollFinish(jobId: String, immediately: Bool = false) async {
        var failures = 0
        var skipWait = immediately
        while !Task.isCancelled {
            if skipWait {
                skipWait = false
            } else {
                do {
                    try await Task.sleep(nanoseconds: 2_500_000_000)
                } catch {
                    return // cancelled
                }
            }
            do {
                guard let job = try await MixbaseAPI.shared.pollFinishedVideo(jobId: jobId) else {
                    // 404: a deploy or another server instance lost the job.
                    // (Cancelled = off screen: keep the record, so the next
                    // visit polls again and shows this outcome.)
                    if Task.isCancelled { return }
                    FinishedRenderJobs.shared.clear(projectId: projectId, jobId: jobId)
                    finishJob = nil
                    finishError = "Render was interrupted — try again"
                    await loadLatestFinished()
                    return
                }
                if Task.isCancelled { return }
                failures = 0
                if job.status == "done" {
                    FinishedRenderJobs.shared.clear(projectId: projectId, jobId: jobId)
                    finishJob = nil
                    await loadLibrary()
                    await loadLatestFinished()
                    return
                }
                if job.status == "error" {
                    FinishedRenderJobs.shared.clear(projectId: projectId, jobId: jobId)
                    finishJob = nil
                    finishError = Self.shortError(job.error) ?? "The render failed. Please try again."
                    return
                }
                finishJob = job
            } catch {
                if Task.isCancelled { return }
                failures += 1
                if failures >= 5 {
                    // The render may well still be going: keep the record, so
                    // the next visit (or a re-tap, whose 409 names this job)
                    // picks it back up.
                    finishJob = nil
                    finishError = "Lost touch with the render. Check Your Videos in a minute."
                    await loadLatestFinished()
                    return
                }
            }
        }
    }

    /// The progress line under the bar: which render, its stage, and percent.
    private static func finishProgressText(_ job: MixbaseAPI.FinishedVideoJob) -> String {
        let what: String
        switch job.format ?? "" {
        case "shorts": what = "Short"
        case "youtube": what = "YouTube video"
        default: what = "Video"
        }
        return "\(what) · \(job.stage ?? "Rendering") · \(Int(job.progress ?? 0))%"
    }

    /// Job errors can carry raw ffmpeg stderr — show only the first line,
    /// capped at ~120 characters.
    private static func shortError(_ message: String?) -> String? {
        guard let message else { return nil }
        let lines = message.split(whereSeparator: { $0 == "\n" || $0 == "\r" })
        let first = lines.first.map { String($0) } ?? message
        let trimmed = first.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.count > 120 {
            return String(trimmed.prefix(117)) + "…"
        }
        return trimmed
    }

    // MARK: Pins

    private func pin(_ url: String?, wide: Bool = false) async {
        pinningUrl = url
        pinEdits += 1
        do {
            try await MixbaseAPI.shared.pinVisualizer(projectId: projectId, videoUrl: url, wide: wide)
            if wide {
                pinnedWideUrl = url
                onWidePinChanged?(url)
            } else {
                pinnedUrl = url
                onPinChanged?(url)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        pinningUrl = nil
    }

    private func delete(_ visualizer: Visualizer) async {
        do {
            try await MixbaseAPI.shared.deleteVisualizer(id: visualizer.id)
            library.removeAll { $0.id == visualizer.id }
            // Server also un-pins deleted videos from projects (both slots)
            if pinnedUrl == visualizer.videoUrl {
                pinnedUrl = nil
                onPinChanged?(nil)
            }
            if pinnedWideUrl == visualizer.videoUrl {
                pinnedWideUrl = nil
                onWidePinChanged?(nil)
            }
            if latestFinished?.youtube?.id == visualizer.id || latestFinished?.shorts?.id == visualizer.id {
                await loadLatestFinished()
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - FinishedRenderJobs
// The finished (YouTube/Shorts) renders this app started, by project — kept
// OUTSIDE any view. VisualizerView is pushed from ProjectDetailView or shown
// in a sheet from ArtworkLibraryView, so its @State is gone the moment the
// user leaves, while the render keeps going server-side for minutes. Reopening
// the screen looks the project up here and resumes polling, so it shows live
// progress instead of an idle Render button.
//
// It is also how a 409 is read correctly: the server allows one render per
// ACCOUNT (any project, any format), so a 409 is only "this project's own
// render" when its job_id is the one recorded here.
//
// In memory only, like the server's own job map (lost on deploy by design): a
// relaunch starts empty, and a 409 then just shows the server's message.

@MainActor
final class FinishedRenderJobs {

    static let shared = FinishedRenderJobs()

    struct Entry {
        let jobId: String
        let format: String      // youtube | shorts
        let userId: String      // the account that started it
        let startedAt: Date
    }

    // The server keeps a settled job readable for an hour after it was
    // created (JOB_TTL_MS in src/lib/video-job-policy.ts). Past that a poll
    // 404s even for a render that succeeded, which would read as
    // "interrupted" — so an older record is dropped rather than resumed. The
    // latest-renders list shows the result either way.
    private static let maxAge: TimeInterval = 55 * 60

    private var jobs: [UUID: Entry] = [:]

    private init() {}

    /// The render this app recorded for a project, if it belongs to the
    /// signed-in account and is recent enough to still be polled.
    func entry(for projectId: UUID, userId: String?) -> Entry? {
        guard let entry = jobs[projectId] else { return nil }
        guard let userId,
              entry.userId == userId,
              Date().timeIntervalSince(entry.startedAt) < Self.maxAge else {
            jobs[projectId] = nil
            return nil
        }
        return entry
    }

    func record(_ entry: Entry, for projectId: UUID) {
        jobs[projectId] = entry
    }

    /// Forget a project's render — only while it is still `jobId`, so a late
    /// answer about an older job can never erase a newer render's record.
    func clear(projectId: UUID, jobId: String) {
        if jobs[projectId]?.jobId == jobId {
            jobs[projectId] = nil
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
