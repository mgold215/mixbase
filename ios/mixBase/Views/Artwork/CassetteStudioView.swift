import SwiftUI
import PhotosUI
import CoreTransferable
import CoreGraphics
import ImageIO

// MARK: - CoverTextColors
// Preset text colours for baked-in overlays (lettered covers + finished
// videos) — mirrors TEXT_COLORS in src/lib/text-colors.ts. White first: it's
// the default everywhere.

struct TextColorOption: Identifiable, Hashable {
    let value: String
    let label: String

    var id: String { value }
}

enum CoverTextColors {
    static let all: [TextColorOption] = [
        TextColorOption(value: "#FFFFFF", label: "White"),
        TextColorOption(value: "#000000", label: "Black"),
        TextColorOption(value: "#F5EFE0", label: "Cream"),
        TextColorOption(value: "#D4AF37", label: "Gold"),
        TextColorOption(value: "#E03A3E", label: "Red"),
        TextColorOption(value: "#2DD4BF", label: "Teal"),
        TextColorOption(value: "#F472B6", label: "Pink"),
        TextColorOption(value: "#60A5FA", label: "Blue"),
    ]
}

// MARK: - CassetteStudioView
// Native port of the web's Cassette Studio (src/components/CassetteStudio.tsx):
// the artist's REAL cassette photo, cut out once and dropped into a new scene,
// lettered in their own handwriting. One tap per cover once the cassette and
// the handwriting are in. The cassette's pixels are never generated.
//
// OWNER-ONLY: ProjectDetailView only links here when AuthService.ownerTools is
// true, and every /api/cassette-studio route 404s for anyone else.
//
// Photos are downscaled ON DEVICE before upload (MixbaseAPI.uploadableJPEG,
// ImageIO): phone photos are 3–12 MB HEICs and Railway's proxy truncates
// request bodies at 10 MB.

struct CassetteStudioView: View {

    let projectId: UUID
    // (artwork_url, finalized_artwork_url) after every successful render — the
    // server has already applied both to the project.
    let onRendered: (String, String?) -> Void
    // A moving cover was rendered and pinned: (video url, pinned to the wide slot).
    let onVisualizerPinned: ((String, Bool) -> Void)?

    init(
        projectId: UUID,
        onRendered: @escaping (String, String?) -> Void,
        onVisualizerPinned: ((String, Bool) -> Void)? = nil
    ) {
        self.projectId = projectId
        self.onRendered = onRendered
        self.onVisualizerPinned = onVisualizerPinned
    }

    private enum Busy: Equatable {
        // library: cutting out a photo already in mixBase.
        // look: putting the remembered look on a fresh render.
        // typing: setting a typed title from the glyph bank.
        // teaching: learning letters from a photo. sheet: reading the handwriting sheet.
        case load, subject, library, lettering, typing, teaching, render, reletter, look, motion, sheet
    }

    // One click: example scenes (tap fills the box) and the steps shown while it runs.
    private static let quickIdeas = [
        "Rainy rooftop in Tokyo at night, neon signs",
        "Desert motel at dusk, pink sky",
        "Diner counter at 3am, red neon outside",
        "Snowy windowsill, warm lamp light",
        "Car dashboard on a night highway",
    ]

    private static let quickSteps: [(id: String, label: String)] = [
        ("brief", "Writing the shot"),
        ("cover", "Cover, with your handwriting"),
        ("canvas", "Canvas (9:16)"),
        ("youtube", "YouTube (16:9)"),
    ]

    // Mirrors CASSETTE_SCENES in src/lib/cassette-scenes.ts (ids must match
    // the server; the server owns the prompts).
    private static let scenes: [(id: String, label: String)] = [
        ("city-ledge", "City ledge, blue hour"),
        ("rooftop", "Rooftop at dusk"),
        ("diner", "Diner counter, neon"),
        ("dashboard", "Car dashboard, night"),
        ("wet-street", "Wet street after rain"),
        ("pier", "Pier at golden hour"),
        ("desert", "Desert highway"),
        ("subway", "Subway platform"),
        ("record-store", "Record store counter"),
        ("studio", "Home studio desk"),
        ("rainy-window", "Rainy windowsill"),
        ("snow", "Snowy wall, winter"),
        ("garage", "Parking garage"),
        ("boardwalk", "Beach boardwalk"),
        ("motel", "Motel nightstand"),
        ("forest", "Forest, morning fog"),
        ("laundromat", "Laundromat, late night"),
        ("train", "Train window"),
    ]

    // MAX_CUSTOM_SETTING in src/lib/cassette-scenes.ts
    private static let maxSettingLength = 300

    private static let positions: [(id: String, symbol: String)] = [
        ("top-left", "arrow.up.left"), ("top-center", "arrow.up"), ("top-right", "arrow.up.right"),
        ("bottom-left", "arrow.down.left"), ("bottom-center", "arrow.down"), ("bottom-right", "arrow.down.right"),
    ]

    private static let sizes: [(id: String, label: String)] = [
        ("small", "S"), ("medium", "M"), ("large", "L"),
    ]

    private static let motionFormats: [(id: String, label: String)] = [
        ("canvas", "9:16 Canvas"), ("square", "1:1 Square"), ("youtube", "16:9 YouTube"), ("story", "9:16 Story"),
    ]

    // Where the cassette goes (place_x / place_y / place_scale on /render):
    // a 3 × 3 grid of centre × surface line, and a width. "auto" leaves the
    // field to the server's own framing.
    private static let cassetteSpots: [(id: String, x: Double, y: Double, symbol: String)] = [
        ("tl", 0.3, 0.5, "arrow.up.left"), ("t", 0.5, 0.5, "arrow.up"), ("tr", 0.7, 0.5, "arrow.up.right"),
        ("l", 0.3, 0.7, "arrow.left"), ("c", 0.5, 0.7, "circle.fill"), ("r", 0.7, 0.7, "arrow.right"),
        ("bl", 0.3, 0.88, "arrow.down.left"), ("b", 0.5, 0.88, "arrow.down"), ("br", 0.7, 0.88, "arrow.down.right"),
    ]

    private static let cassetteSizes: [(id: String, scale: Double, label: String)] = [
        ("s", 0.3, "S"), ("m", 0.4, "M"), ("l", 0.52, "L"), ("xl", 0.66, "XL"),
    ]

    private static let alignments: [(id: String, symbol: String)] = [
        ("left", "text.alignleft"), ("center", "text.aligncenter"), ("right", "text.alignright"),
    ]

    // Library
    @State private var subjects: [MixbaseAPI.StudioFile] = []
    @State private var lettering: [MixbaseAPI.StudioFile] = []
    @State private var subjectPath: String?
    @State private var letteringPath: String?
    @State private var hasLoaded = false

    // Handwriting placement
    @State private var useLettering = true
    @State private var color = "auto"
    @State private var position = "bottom-left"
    @State private var size = "medium"

    // Scene
    @State private var scene = "random"
    @State private var setting = ""
    @State private var backgroundData: Data?
    @State private var backgroundPreview: CGImage?
    @State private var glossy = false

    // Photo pickers
    @State private var subjectPick: PhotosPickerItem?
    @State private var letteringPick: PhotosPickerItem?
    @State private var backgroundPick: PhotosPickerItem?
    @State private var showLibraryPhotos = false

    // Status
    @State private var busy: Busy? = .load
    @State private var errorMessage: String?
    @State private var lastSceneLabel: String?
    @State private var hasRendered = false
    @State private var coverUrl: String?

    // 4 · Finish the look. lookRevision rebuilds the section (fresh look and
    // preview) whenever the cover underneath it changes.
    @State private var lookOptions: MixbaseAPI.FilterOptions?
    @State private var lookRevision = 0
    @State private var lookLoadSeq = 0
    // The remembered look that could not be added after a render; section 4
    // opens on it (unsaved) so adding it is one tap.
    @State private var pendingLook: MixbaseAPI.FilterSettings?
    @State private var lookSaving = false
    @State private var lookNote: String?

    // Type it in my handwriting (the glyph bank, /api/cassette-studio/glyphs)
    @State private var typedText = ""
    @State private var typedAlign = "center"
    @State private var typeNote: String?
    @State private var teachOpen = false
    @State private var teachText = ""
    @State private var teachData: Data?
    @State private var teachPick: PhotosPickerItem?
    @State private var teachError: String?
    @State private var teachNote: String?
    @State private var glyphCounts: [String: Int]?
    @State private var glyphChars = ""
    @State private var forgetCandidate: String?

    // Cassette placement: "auto" or a cassetteSpots id; "auto" or a cassetteSizes id.
    @State private var spot = "auto"
    @State private var cassetteSize = "auto"

    // Make it move
    @State private var motionFormat = "canvas"
    @State private var motionWithTitle = true
    @State private var motionUrl: String?
    @State private var motionUrlFormat = "canvas"
    @State private var motionError: String?
    @State private var isSavingMotion = false
    @State private var savedMotion = false
    // The project's CURRENT cover can already move (its layers were saved).
    @State private var canMove = false

    // One click: the description, the run being polled, what it will use.
    @State private var quickText = ""
    @State private var quickJob: MixbaseAPI.QuickJob?
    @State private var quickError: String?
    @State private var setupInfo: MixbaseAPI.StudioSetup?
    @State private var sheetPick: PhotosPickerItem?
    @State private var sheetError: String?
    @State private var manualOpen = false
    @State private var pollToken = 0
    // The cover and clips already handed to the song screen, so polling
    // announces each once.
    @State private var announcedCover: String?
    @State private var announcedClips: Set<String> = []

    private var quickRunning: Bool { quickJob?.isRunning ?? false }

    private var isWorking: Bool { busy != nil || lookSaving || quickRunning }

    private var quickReady: Bool { setupInfo?.cassette != nil || !subjects.isEmpty }

    private var needsSheet: Bool {
        guard let setupInfo else { return false }
        return setupInfo.signature == nil || setupInfo.letters.known < setupInfo.letters.total
    }

    // Leaving mid-upload or mid-render would orphan the request's result.
    private var blocksLeaving: Bool {
        (busy != nil && busy != .load) || lookSaving
    }

    private var currentLettering: MixbaseAPI.StudioFile? {
        guard let letteringPath else { return nil }
        return lettering.first { $0.path == letteringPath }
    }

    private var canRender: Bool {
        guard subjectPath != nil, !isWorking else { return false }
        if scene == "custom" && setting.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        if scene == "photo" && backgroundData == nil { return false }
        return true
    }

    var body: some View {
        ZStack {
            Color(hex: "#080808")
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    quickSection
                    setupSection

                    Button(action: { manualOpen.toggle() }) {
                        HStack(spacing: 6) {
                            Image(systemName: manualOpen ? "chevron.down" : "chevron.right")
                            Text("Manual studio (every control)")
                        }
                        .font(.subheadline)
                        .foregroundColor(Color(hex: "#999999"))
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal)

                    if manualOpen {
                        cassetteSection
                        handwritingSection
                        sceneSection
                        actionSection
                        lookSection

                        if hasRendered || canMove {
                            motionSection
                        }
                    }

                    Spacer(minLength: 80)
                }
                .padding(.top, 16)
            }
        }
        .navigationTitle("Cassette Studio")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .studioBackButtonHidden(blocksLeaving)
        .task {
            guard !hasLoaded else { return }
            hasLoaded = true
            await load()
            await loadLook()
        }
        .sheet(isPresented: $showLibraryPhotos) {
            StudioPhotoPickerSheet { photo in
                Task { await addSubject(fromLibrary: photo) }
            }
        }
        .onChange(of: subjectPick) { _, item in
            if let item {
                Task { await addSubject(item) }
            }
        }
        .onChange(of: letteringPick) { _, item in
            if let item {
                Task { await addLettering(item) }
            }
        }
        .onChange(of: sheetPick) { _, item in
            if let item {
                Task { await uploadSheet(item) }
            }
        }
        .onDisappear { pollToken += 1 }
        .onChange(of: teachPick) { _, item in
            if let item {
                Task { await chooseTeachPhoto(item) }
            }
        }
        .confirmationDialog(
            "Forget this letter?",
            isPresented: Binding(get: { forgetCandidate != nil }, set: { if !$0 { forgetCandidate = nil } }),
            titleVisibility: .visible
        ) {
            Button("Forget every sample of \(forgetCandidate ?? "")", role: .destructive) {
                if let c = forgetCandidate {
                    forgetCandidate = nil
                    Task { await forget(c) }
                }
            }
            Button("Cancel", role: .cancel) { forgetCandidate = nil }
        }
        .onChange(of: backgroundPick) { _, item in
            if let item {
                Task { await chooseBackground(item) }
            }
        }
        .onChange(of: setting) { _, newValue in
            if newValue.count > Self.maxSettingLength {
                setting = String(newValue.prefix(Self.maxSettingLength))
            }
        }
    }

    // MARK: - 1 · Cassette

    @ViewBuilder
    private var cassetteSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("1 · Your cassette")

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(subjects) { file in
                        subjectTile(file)
                    }

                    PhotosPicker(selection: $subjectPick, matching: .images) {
                        addCassetteTile(icon: "camera", title: "Add photo", cutting: busy == .subject)
                    }
                    .buttonStyle(.plain)
                    .disabled(isWorking)
                    .opacity(isWorking && busy != .subject ? 0.5 : 1)

                    // A cassette photo already uploaded to one of the songs.
                    Button(action: { showLibraryPhotos = true }) {
                        addCassetteTile(icon: "photo.on.rectangle", title: "From mixBase", cutting: busy == .library)
                    }
                    .buttonStyle(.plain)
                    .disabled(isWorking)
                    .opacity(isWorking && busy != .library ? 0.5 : 1)
                }
                .padding(.horizontal)
                .padding(.vertical, 6)
            }

            if subjects.isEmpty && busy != .load {
                hint("Snap your cassette straight on, at its own height, standing on a table. A plain wall or card behind it gives the cleanest result. We cut it out once and reuse it for every cover. The cassette is never AI-generated.")
            }
        }
    }

    private func addCassetteTile(icon: String, title: String, cutting: Bool) -> some View {
        VStack(spacing: 4) {
            if cutting {
                ProgressView().tint(Color(hex: "#2dd4bf"))
                Text("Cutting out…")
            } else {
                Image(systemName: icon)
                Text(title)
            }
        }
        .font(.caption2)
        .foregroundColor(Color(hex: "#999999"))
        .frame(width: 88, height: 64)
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color(hex: "#333333"), style: StrokeStyle(lineWidth: 1, dash: [4]))
        )
    }

    private func subjectTile(_ file: MixbaseAPI.StudioFile) -> some View {
        let selected = subjectPath == file.path
        return ZStack(alignment: .topTrailing) {
            Button(action: { subjectPath = file.path }) {
                ZStack {
                    StudioCheckerboard()
                    if let url = URL(string: file.url) {
                        AsyncImage(url: url) { image in
                            image.resizable().aspectRatio(contentMode: .fit)
                        } placeholder: {
                            ProgressView().tint(.gray)
                        }
                        .padding(4)
                    }
                }
                .frame(width: 88, height: 64)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(selected ? Color(hex: "#2dd4bf") : Color.clear, lineWidth: 2)
                )
            }
            .buttonStyle(.plain)
            .disabled(isWorking)
            .accessibilityLabel(Text("Use this cassette"))

            Button(action: { Task { await removeFile(file, isSubject: true) } }) {
                Image(systemName: "xmark")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundColor(Color(hex: "#bbbbbb"))
                    .frame(width: 18, height: 18)
                    .background(Color(hex: "#222222"))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(isWorking)
            .offset(x: 5, y: -5)
            .accessibilityLabel(Text("Remove cassette"))
        }
    }

    // MARK: - 2 · Handwriting

    @ViewBuilder
    private var handwritingSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                sectionTitle("2 · Your handwriting")
                Spacer()
                if currentLettering != nil {
                    Toggle(isOn: $useLettering) {
                        Text("On cover")
                            .font(.caption)
                            .foregroundColor(Color(hex: "#999999"))
                    }
                    .toggleStyle(.switch)
                    .tint(Color(hex: "#2dd4bf"))
                    .fixedSize()
                    .disabled(isWorking)
                    .padding(.trailing)
                }
            }

            HStack(spacing: 10) {
                if let current = currentLettering {
                    ZStack(alignment: .topTrailing) {
                        ZStack {
                            Color(hex: "#2a3340")
                            if let url = URL(string: current.url) {
                                AsyncImage(url: url) { image in
                                    image.resizable().aspectRatio(contentMode: .fit)
                                } placeholder: {
                                    ProgressView().tint(.gray)
                                }
                                .padding(6)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 72)
                        .clipShape(RoundedRectangle(cornerRadius: 10))

                        Button(action: { Task { await removeFile(current, isSubject: false) } }) {
                            Image(systemName: "xmark")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundColor(Color(hex: "#bbbbbb"))
                                .frame(width: 18, height: 18)
                                .background(Color.black.opacity(0.5))
                                .clipShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .disabled(isWorking)
                        .padding(5)
                        .accessibilityLabel(Text("Remove handwriting"))
                    }
                }

                PhotosPicker(selection: $letteringPick, matching: .images) {
                    VStack(spacing: 4) {
                        if busy == .lettering {
                            ProgressView().tint(Color(hex: "#2dd4bf"))
                            Text("Reading…")
                        } else {
                            Image(systemName: "pencil.line")
                            Text(currentLettering == nil ? "Add a photo of your handwriting" : "Replace")
                                .multilineTextAlignment(.center)
                        }
                    }
                    .font(.caption2)
                    .foregroundColor(Color(hex: "#999999"))
                    .padding(.horizontal, 6)
                    .frame(maxWidth: currentLettering == nil ? CGFloat.infinity : 88)
                    .frame(height: 72)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(Color(hex: "#333333"), style: StrokeStyle(lineWidth: 1, dash: [4]))
                    )
                }
                .buttonStyle(.plain)
                .disabled(isWorking)
                .opacity(isWorking && busy != .lettering ? 0.5 : 1)
            }
            .padding(.horizontal)

            if currentLettering == nil && busy != .load {
                hint("Write the artist name and song title with a marker on plain paper and photograph it flat. Your exact strokes are lifted off the paper, with no font and no AI. Holes and breaks in a stroke are mended; the letters stay yours.")
            }

            typeItBlock

            if currentLettering != nil && useLettering {
                letteringControls
            }
        }
    }

    // MARK: - Type it in my handwriting

    /// A title set from the letters the bank has learned (the server lays
    /// the artist's own samples out — no font, no AI) plus the teaching box
    /// that fills the bank.
    @ViewBuilder
    private var typeItBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Or type it in your handwriting", systemImage: "keyboard")
                    .font(.caption)
                    .foregroundColor(Color(hex: "#999999"))
                Spacer()
                Button(action: {
                    teachOpen.toggle()
                    if teachOpen && glyphCounts == nil {
                        Task { await loadGlyphs() }
                    }
                }) {
                    Label(teachOpen ? "Close teaching" : "Teach it my letters", systemImage: "graduationcap")
                        .font(.caption)
                        .foregroundColor(teachOpen ? Color(hex: "#2dd4bf") : Color(hex: "#999999"))
                }
                .buttonStyle(.plain)
                .disabled(isWorking)
            }

            TextField("artist name, then the song title on a new line", text: $typedText, axis: .vertical)
                .font(.subheadline)
                .foregroundColor(Color(hex: "#f0f0f0"))
                .lineLimit(2...3)
                .padding(10)
                .background(Color(hex: "#161616"))
                .cornerRadius(10)
                .disabled(isWorking)

            HStack(spacing: 8) {
                ForEach(Self.alignments, id: \.id) { option in
                    Button(action: { typedAlign = option.id }) {
                        Image(systemName: option.symbol)
                            .font(.caption)
                            .foregroundColor(typedAlign == option.id ? Color(hex: "#080808") : Color(hex: "#999999"))
                            .frame(width: 34, height: 28)
                            .background(typedAlign == option.id ? Color(hex: "#2dd4bf") : Color(hex: "#222222"))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                    .disabled(isWorking)
                    .accessibilityLabel(Text("Align \(option.id)"))
                }

                Spacer()

                Button(action: typeIt) {
                    HStack(spacing: 6) {
                        if busy == .typing {
                            ProgressView().tint(Color(hex: "#f0f0f0")).controlSize(.small)
                            Text("Setting…")
                        } else {
                            Image(systemName: "signature")
                            Text("Set it")
                        }
                    }
                    .font(.caption)
                    .fontWeight(.semibold)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color(hex: "#111111"))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(hex: "#333333"), lineWidth: 1))
                    .cornerRadius(10)
                }
                .buttonStyle(.plain)
                .disabled(isWorking || typedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if let typeNote {
                Text(typeNote)
                    .font(.caption)
                    .foregroundColor(.gray)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if teachOpen {
                teachBlock
            }
        }
        .padding(12)
        .background(Color(hex: "#0a0a0a"))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(hex: "#222222"), lineWidth: 1))
        .cornerRadius(12)
        .padding(.horizontal)
    }

    @ViewBuilder
    private var teachBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider().background(Color(hex: "#222222"))

            Text("Write letters on plain paper with clear space between every letter — no joined-up writing, dots close to their i and j — in a few lines (your alphabet in capitals, then lower case, then digits). Photograph it flat, then type exactly what each line says. Every letter becomes a sample; teach a letter several times and your typed titles will vary the way your writing does.")
                .font(.caption)
                .foregroundColor(.gray)
                .fixedSize(horizontal: false, vertical: true)

            HStack(alignment: .top, spacing: 10) {
                PhotosPicker(selection: $teachPick, matching: .images) {
                    VStack(spacing: 4) {
                        Image(systemName: teachData == nil ? "camera" : "checkmark.circle.fill")
                        Text(teachData == nil ? "Photo of letters" : "Photo ready")
                            .multilineTextAlignment(.center)
                    }
                    .font(.caption2)
                    .foregroundColor(teachData == nil ? Color(hex: "#999999") : Color(hex: "#2dd4bf"))
                    .padding(.horizontal, 6)
                    .frame(width: 88, height: 72)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(Color(hex: "#333333"), style: StrokeStyle(lineWidth: 1, dash: [4]))
                    )
                }
                .buttonStyle(.plain)
                .disabled(isWorking)

                TextField("What the photo says, one line per line of writing", text: $teachText, axis: .vertical)
                    .font(.subheadline)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .lineLimit(3...6)
                    .padding(10)
                    .background(Color(hex: "#161616"))
                    .cornerRadius(10)
                    .disabled(isWorking)
            }

            HStack(spacing: 8) {
                Button(action: { Task { await teach(fromPhoto: true) } }) {
                    HStack(spacing: 6) {
                        if busy == .teaching {
                            ProgressView().tint(Color(hex: "#f0f0f0")).controlSize(.small)
                            Text("Learning…")
                        } else {
                            Image(systemName: "graduationcap")
                            Text("Learn from the photo")
                        }
                    }
                    .font(.caption)
                    .fontWeight(.semibold)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(Color(hex: "#111111"))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(hex: "#333333"), lineWidth: 1))
                    .cornerRadius(10)
                }
                .buttonStyle(.plain)
                .disabled(isWorking || teachData == nil || teachText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                if currentLettering != nil {
                    Button(action: { Task { await teach(fromPhoto: false) } }) {
                        Text("Learn from the handwriting above")
                            .font(.caption)
                            .foregroundColor(Color(hex: "#cccccc"))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 9)
                            .background(Color(hex: "#111111"))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(hex: "#333333"), lineWidth: 1))
                            .cornerRadius(10)
                    }
                    .buttonStyle(.plain)
                    .disabled(isWorking || teachText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }

            if let teachError {
                Text(teachError)
                    .font(.caption)
                    .foregroundColor(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let teachNote {
                Text(teachNote)
                    .font(.caption)
                    .foregroundColor(.gray)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let glyphCounts {
                let known = glyphCounts.values.filter { $0 > 0 }.count
                Text(known == 0 ? "No letters learned yet." : "\(known) letters learned — tap one to forget its samples.")
                    .font(.caption2)
                    .foregroundColor(.gray)
                let letters = glyphChars.map { String($0) }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 24), spacing: 4)], spacing: 4) {
                    ForEach(letters, id: \.self) { letter in
                        let n = glyphCounts[letter] ?? 0
                        Button(action: { if n > 0 { forgetCandidate = letter } }) {
                            Text(letter)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundColor(n > 0 ? Color(hex: "#2dd4bf") : Color(hex: "#444444"))
                                .frame(width: 24, height: 24)
                                .background(n > 0 ? Color(hex: "#2dd4bf").opacity(0.2) : Color(hex: "#161616"))
                                .clipShape(RoundedRectangle(cornerRadius: 5))
                        }
                        .buttonStyle(.plain)
                        .disabled(n == 0 || isWorking)
                        .accessibilityLabel(Text(n > 0 ? "\(letter), \(n) samples" : "\(letter), not learned"))
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var letteringControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Colour
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    smallChip("Auto", selected: color == "auto") { color = "auto" }

                    ForEach(CoverTextColors.all) { option in
                        Button(action: { color = option.value }) {
                            RoundedRectangle(cornerRadius: 6)
                                .fill(Color(hex: option.value))
                                .frame(width: 28, height: 28)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 6)
                                        .stroke(
                                            color == option.value ? Color(hex: "#2dd4bf") : Color(hex: "#333333"),
                                            lineWidth: color == option.value ? 3 : 1
                                        )
                                )
                        }
                        .buttonStyle(.plain)
                        .disabled(isWorking)
                        .accessibilityLabel(Text(option.label))
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 2)
            }

            HStack(alignment: .top, spacing: 20) {
                // Position (3 × 2 grid, top row then bottom row)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Position")
                        .font(.caption2)
                        .foregroundColor(.gray)
                    VStack(spacing: 4) {
                        HStack(spacing: 4) {
                            ForEach(Array(Self.positions.prefix(3)), id: \.id) { option in
                                positionButton(option)
                            }
                        }
                        HStack(spacing: 4) {
                            ForEach(Array(Self.positions.suffix(3)), id: \.id) { option in
                                positionButton(option)
                            }
                        }
                    }
                }

                // Size
                VStack(alignment: .leading, spacing: 6) {
                    Text("Size")
                        .font(.caption2)
                        .foregroundColor(.gray)
                    HStack(spacing: 4) {
                        ForEach(Self.sizes, id: \.id) { option in
                            Button(action: { size = option.id }) {
                                Text(option.label)
                                    .font(.caption)
                                    .fontWeight(.semibold)
                                    .foregroundColor(size == option.id ? Color(hex: "#080808") : Color(hex: "#f0f0f0"))
                                    .frame(width: 34, height: 30)
                                    .background(size == option.id ? Color(hex: "#2dd4bf") : Color(hex: "#222222"))
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                            .buttonStyle(.plain)
                            .disabled(isWorking)
                        }
                    }
                }

                Spacer(minLength: 0)
            }
            .padding(.horizontal)
        }
    }

    private func positionButton(_ option: (id: String, symbol: String)) -> some View {
        Button(action: { position = option.id }) {
            Image(systemName: option.symbol)
                .font(.caption)
                .foregroundColor(position == option.id ? Color(hex: "#080808") : Color(hex: "#999999"))
                .frame(width: 34, height: 28)
                .background(position == option.id ? Color(hex: "#2dd4bf") : Color(hex: "#222222"))
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(isWorking)
        .accessibilityLabel(Text(option.id))
    }

    // MARK: - 3 · Scene

    @ViewBuilder
    private var sceneSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("3 · Scene")

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8)], spacing: 8) {
                sceneChip(id: "random", label: "Surprise me", icon: "shuffle")

                ForEach(Self.scenes, id: \.id) { option in
                    sceneChip(id: option.id, label: option.label, icon: nil)
                }

                sceneChip(id: "custom", label: "Describe my own…", icon: "text.cursor")

                PhotosPicker(selection: $backgroundPick, matching: .images) {
                    chipLabel("My own photo (no AI)", icon: "photo", selected: scene == "photo")
                }
                .buttonStyle(.plain)
                .disabled(isWorking)
            }
            .padding(.horizontal)

            if scene == "custom" {
                TextField("What it stands on and what's behind it, e.g. a hotel bar counter, city lights through the window at night", text: $setting, axis: .vertical)
                    .font(.subheadline)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .lineLimit(2...4)
                    .padding(10)
                    .background(Color(hex: "#161616"))
                    .cornerRadius(10)
                    .padding(.horizontal)
                    .disabled(isWorking)
            }

            if scene == "photo", let preview = backgroundPreview {
                HStack(alignment: .top, spacing: 12) {
                    Image(decorative: preview, scale: 1)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 64, height: 64)
                        .clipShape(RoundedRectangle(cornerRadius: 8))

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Your photo is the background, with no AI. Shoot a ledge, table or counter at table height, with room in the middle for the cassette.")
                            .font(.caption)
                            .foregroundColor(.gray)

                        Toggle(isOn: $glossy) {
                            Text("Glossy surface (adds a reflection)")
                                .font(.caption)
                                .foregroundColor(Color(hex: "#f0f0f0"))
                        }
                        .toggleStyle(.switch)
                        .tint(Color(hex: "#2dd4bf"))
                        .disabled(isWorking)
                    }
                }
                .padding(.horizontal)
            }

            placementControls
        }
    }

    /// Where the cassette goes: Auto (the server's own framing) or a spot on
    /// a 3 × 3 grid, and its size.
    @ViewBuilder
    private var placementControls: some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Cassette position")
                    .font(.caption2)
                    .foregroundColor(.gray)
                HStack(alignment: .top, spacing: 6) {
                    smallChip("Auto", selected: spot == "auto") { spot = "auto" }
                    VStack(spacing: 4) {
                        ForEach(0..<3, id: \.self) { row in
                            HStack(spacing: 4) {
                                ForEach(Array(Self.cassetteSpots[(row * 3)..<(row * 3 + 3)]), id: \.id) { option in
                                    Button(action: { spot = option.id }) {
                                        Image(systemName: option.symbol)
                                            .font(.caption2)
                                            .foregroundColor(spot == option.id ? Color(hex: "#080808") : Color(hex: "#999999"))
                                            .frame(width: 30, height: 24)
                                            .background(spot == option.id ? Color(hex: "#2dd4bf") : Color(hex: "#222222"))
                                            .clipShape(RoundedRectangle(cornerRadius: 6))
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(isWorking)
                                    .accessibilityLabel(Text("Cassette \(option.id)"))
                                }
                            }
                        }
                    }
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Cassette size")
                    .font(.caption2)
                    .foregroundColor(.gray)
                HStack(spacing: 4) {
                    smallChip("Auto", selected: cassetteSize == "auto") { cassetteSize = "auto" }
                    ForEach(Self.cassetteSizes, id: \.id) { option in
                        Button(action: { cassetteSize = option.id }) {
                            Text(option.label)
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundColor(cassetteSize == option.id ? Color(hex: "#080808") : Color(hex: "#f0f0f0"))
                                .frame(minWidth: 30)
                                .frame(height: 30)
                                .padding(.horizontal, 4)
                                .background(cassetteSize == option.id ? Color(hex: "#2dd4bf") : Color(hex: "#222222"))
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                        .disabled(isWorking)
                    }
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal)
    }

    /// The placement to send with a render (nil fields → the server's default).
    private var placement: MixbaseAPI.CassettePlacement {
        var p = MixbaseAPI.CassettePlacement.auto
        if let s = Self.cassetteSpots.first(where: { $0.id == spot }) {
            p.x = s.x
            p.y = s.y
        }
        if let z = Self.cassetteSizes.first(where: { $0.id == cassetteSize }) {
            p.scale = z.scale
        }
        return p
    }

    private func sceneChip(id: String, label: String, icon: String?) -> some View {
        Button(action: { scene = id }) {
            chipLabel(label, icon: icon, selected: scene == id)
        }
        .buttonStyle(.plain)
        .disabled(isWorking)
    }

    private func chipLabel(_ label: String, icon: String?, selected: Bool) -> some View {
        HStack(spacing: 4) {
            if let icon {
                Image(systemName: icon)
            }
            Text(label)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .font(.caption)
        .fontWeight(.medium)
        .foregroundColor(selected ? Color(hex: "#080808") : Color(hex: "#f0f0f0"))
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(selected ? Color(hex: "#2dd4bf") : Color(hex: "#222222"))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Actions row

    @ViewBuilder
    private var actionSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundColor(.red)
                    .padding(.horizontal)
            }

            if let lastSceneLabel, !isWorking {
                Text("Last scene: \(lastSceneLabel)")
                    .font(.caption2)
                    .foregroundColor(.gray)
                    .padding(.horizontal)
            }

            Button(action: { render(reletter: false) }) {
                HStack {
                    if busy == .render {
                        ProgressView().tint(Color(hex: "#080808"))
                        Text(scene == "photo" ? "Compositing…" : "Building the scene (~30s)…")
                    } else {
                        Image(systemName: hasRendered ? "arrow.clockwise" : "camera")
                        Text(hasRendered ? "Make another" : "Make cover")
                    }
                }
                .font(.headline)
                .foregroundColor(Color(hex: "#080808"))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(canRender || busy == .render ? Color(hex: "#2dd4bf") : Color.gray.opacity(0.4))
                .cornerRadius(12)
            }
            .buttonStyle(.plain)
            .disabled(!canRender)
            .padding(.horizontal)

            if hasRendered && currentLettering != nil && useLettering {
                Button(action: { render(reletter: true) }) {
                    HStack {
                        if busy == .reletter {
                            ProgressView().tint(Color(hex: "#f0f0f0"))
                            Text("Updating…")
                        } else {
                            Image(systemName: "textformat")
                            Text("Update text only")
                        }
                    }
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Color(hex: "#111111"))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12)
                            .stroke(Color(hex: "#333333"), lineWidth: 1)
                    )
                    .cornerRadius(12)
                }
                .buttonStyle(.plain)
                .disabled(isWorking)
                .opacity(isWorking && busy != .reletter ? 0.5 : 1)
                .padding(.horizontal)
            }

            if subjectPath == nil && busy != .load {
                hint("Add a cassette photo to start.")
            }

            if let coverUrl, let url = URL(string: coverUrl) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(Color(hex: "#2dd4bf"))
                        Text("Applied as this song's cover")
                            .font(.subheadline)
                            .fontWeight(.medium)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                    }

                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fit)
                    } placeholder: {
                        RoundedRectangle(cornerRadius: 12)
                            .fill(Color(hex: "#1a1a1a"))
                            .aspectRatio(1, contentMode: .fit)
                            .overlay(ProgressView().tint(.gray))
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .padding(.horizontal)
            }

            if busy == .look {
                HStack(spacing: 6) {
                    ProgressView()
                        .tint(.gray)
                        .controlSize(.small)
                    Text("Adding your look…")
                }
                .font(.caption)
                .foregroundColor(.gray)
                .padding(.horizontal)
            } else if let lookNote {
                hint(lookNote)
            }
        }
    }

    // MARK: - 4 · Finish the look

    @ViewBuilder
    private var lookSection: some View {
        if let options = lookOptions, options.baseUrl != nil {
            CassetteLookSection(
                projectId: projectId,
                options: options,
                initialLook: pendingLook,
                locked: busy != nil,
                isSaving: $lookSaving,
                onSaved: { result in
                    lookNote = nil
                    pendingLook = nil
                    applySavedLook(result)
                }
            )
            .id(lookRevision)
        }
    }

    // MARK: - Make it move

    @ViewBuilder
    private var motionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Make it move")

            if hasRendered || canMove {
                hint("Turns this cover into a loop: the reels turn, the camera drifts. No AI. It's saved to Your Videos and pinned as this song's visualizer.")

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Self.motionFormats, id: \.id) { option in
                            smallChip(option.label, selected: motionFormat == option.id) {
                                motionFormat = option.id
                            }
                        }
                    }
                    .padding(.horizontal)
                }

                Toggle(isOn: Binding(get: { !motionWithTitle }, set: { motionWithTitle = !$0 })) {
                    Text("Without the title (the cassette and the scene only)")
                        .font(.caption)
                        .foregroundColor(Color(hex: "#f0f0f0"))
                }
                .toggleStyle(.switch)
                .tint(Color(hex: "#2dd4bf"))
                .disabled(isWorking)
                .padding(.horizontal)

                Button(action: makeItMove) {
                    HStack {
                        if busy == .motion {
                            ProgressView().tint(Color(hex: "#080808"))
                            Text("Rendering…")
                        } else {
                            Image(systemName: "play.rectangle")
                            Text("Make it move")
                        }
                    }
                    .font(.headline)
                    .foregroundColor(Color(hex: "#080808"))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(isWorking && busy != .motion ? Color.gray.opacity(0.4) : Color(hex: "#2dd4bf"))
                    .cornerRadius(12)
                }
                .buttonStyle(.plain)
                .disabled(isWorking)
                .padding(.horizontal)
            }

            if let motionError {
                Text(motionError)
                    .font(.caption)
                    .foregroundColor(.red)
                    .padding(.horizontal)
            }

            if let motionUrl, let url = URL(string: motionUrl) {
                VStack(alignment: .leading, spacing: 8) {
                    motionPreview(url: url)

                    if isSavingMotion {
                        ProgressView().tint(Color(hex: "#2dd4bf"))
                    } else if savedMotion {
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark")
                            Text("Saved")
                        }
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundColor(Color(hex: "#2dd4bf"))
                    } else {
                        Button(action: { Task { await saveMotion(motionUrl) } }) {
                            HStack(spacing: 4) {
                                Image(systemName: "square.and.arrow.down")
                                Text(saveButtonLabel)
                            }
                            .font(.caption)
                            .fontWeight(.medium)
                            .foregroundColor(Color(hex: "#2dd4bf"))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal)
            }
        }
    }

    // MARK: - One click

    @ViewBuilder
    private var quickSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles")
                    .foregroundColor(Color(hex: "#2dd4bf"))
                Text("Describe the scene")
                    .font(.headline)
                    .foregroundColor(Color(hex: "#f0f0f0"))
            }

            TextField("e.g. rainy rooftop in Tokyo at night, neon signs reflecting in puddles", text: $quickText, axis: .vertical)
                .font(.subheadline)
                .foregroundColor(Color(hex: "#f0f0f0"))
                .lineLimit(2...4)
                .padding(10)
                .background(Color(hex: "#161616"))
                .cornerRadius(10)
                .disabled(quickRunning)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Self.quickIdeas, id: \.self) { idea in
                        smallChip(idea, selected: quickText == idea) { quickText = idea }
                    }
                }
            }

            Button(action: makeIt) {
                HStack {
                    if quickRunning {
                        ProgressView().tint(Color(hex: "#080808"))
                        Text("Making it…")
                    } else {
                        Image(systemName: "sparkles")
                        Text(quickJob?.status == "done" ? "Make another" : "Make it")
                    }
                }
                .font(.headline)
                .foregroundColor(Color(hex: "#080808"))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(canMakeIt || quickRunning ? Color(hex: "#2dd4bf") : Color.gray.opacity(0.4))
                .cornerRadius(12)
            }
            .buttonStyle(.plain)
            .disabled(!canMakeIt)

            Text("Your real cassette in that scene, with moodmixformat and the title in your handwriting, then the same scene filmed as Canvas and YouTube clips of the cassette playing. Everything is applied to this song. Takes about 3–5 minutes.")
                .font(.caption)
                .foregroundColor(.gray)
                .fixedSize(horizontal: false, vertical: true)

            if let quickError {
                Text(quickError)
                    .font(.caption)
                    .foregroundColor(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let job = quickJob {
                quickProgress(job)
            }
        }
        .padding(14)
        .background(Color(hex: "#081414"))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(hex: "#2dd4bf").opacity(0.3), lineWidth: 1)
        )
        .cornerRadius(14)
        .padding(.horizontal)
    }

    private var canMakeIt: Bool {
        !isWorking && quickReady && quickText.trimmingCharacters(in: .whitespacesAndNewlines).count >= 3
    }

    private func quickProgress(_ job: MixbaseAPI.QuickJob) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Self.quickSteps, id: \.id) { step in
                let state = job.steps[step.id] ?? "pending"
                HStack(spacing: 8) {
                    stepIcon(state)
                    Text(step.label)
                        .font(.caption)
                        .foregroundColor(state == "pending" ? Color(hex: "#555555") : Color(hex: "#cccccc"))
                    if step.id == "brief", let label = job.sceneLabel {
                        Text("· \(label)")
                            .font(.caption)
                            .foregroundColor(.gray)
                            .lineLimit(1)
                    }
                }
            }

            if job.isRunning {
                Text(job.stage)
                    .font(.caption2)
                    .foregroundColor(.gray)
            }
            if job.status == "error", let err = job.error {
                Text(err)
                    .font(.caption)
                    .foregroundColor(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let cover = job.finalizedArtworkUrl ?? job.artworkUrl, let url = URL(string: cover) {
                AsyncImage(url: url) { image in
                    image.resizable().aspectRatio(1, contentMode: .fill)
                } placeholder: {
                    Color(hex: "#1a1a1a").overlay(ProgressView().tint(.gray))
                }
                .frame(width: 160, height: 160)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }

            ForEach(job.clips, id: \.videoUrl) { clip in
                VStack(alignment: .leading, spacing: 4) {
                    if let url = URL(string: clip.videoUrl) {
                        if clip.format == "youtube" {
                            LoopingVideoPlayer(url: url)
                                .aspectRatio(16.0 / 9.0, contentMode: .fit)
                                .frame(maxWidth: .infinity)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        } else {
                            LoopingVideoPlayer(url: url)
                                .frame(width: 135, height: 240)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                    }
                    Text("\(clip.format == "youtube" ? "YouTube" : "Canvas") · \(clip.kind == "cinematic" ? (clip.model ?? "cinematic") : "cassette loop")")
                        .font(.caption2)
                        .foregroundColor(.gray)
                }
            }

            ForEach(job.notes, id: \.self) { note in
                Text("· \(note)")
                    .font(.caption2)
                    .foregroundColor(.gray)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(hex: "#0a0a0a"))
        .cornerRadius(10)
    }

    @ViewBuilder
    private func stepIcon(_ state: String) -> some View {
        switch state {
        case "done":
            Image(systemName: "checkmark.circle.fill")
                .font(.caption)
                .foregroundColor(Color(hex: "#2dd4bf"))
        case "running":
            ProgressView()
                .controlSize(.mini)
                .tint(.gray)
        case "failed":
            Image(systemName: "exclamationmark.circle.fill")
                .font(.caption)
                .foregroundColor(.red)
        default:
            Image(systemName: "circle")
                .font(.caption)
                .foregroundColor(Color(hex: "#444444"))
        }
    }

    // MARK: - Setup

    @ViewBuilder
    private var setupSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Setup")

            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    ZStack {
                        StudioCheckerboard()
                        if let cassette = setupInfo?.cassette?.url ?? subjects.first?.url, let url = URL(string: cassette) {
                            AsyncImage(url: url) { image in
                                image.resizable().aspectRatio(contentMode: .fit)
                            } placeholder: {
                                ProgressView().tint(.gray)
                            }
                            .padding(3)
                        }
                    }
                    .frame(width: 64, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 4) {
                            Image(systemName: quickReady ? "checkmark.circle.fill" : "exclamationmark.circle")
                                .foregroundColor(quickReady ? Color(hex: "#2dd4bf") : .orange)
                            Text("Cassette")
                                .foregroundColor(Color(hex: "#cccccc"))
                        }
                        .font(.caption)

                        PhotosPicker(selection: $subjectPick, matching: .images) {
                            Text(busy == .subject ? "Cutting out…" : (quickReady ? "New photo" : "Add a photo"))
                                .font(.caption)
                                .foregroundColor(Color(hex: "#2dd4bf"))
                        }
                        .buttonStyle(.plain)
                        .disabled(isWorking)
                    }
                }

                HStack(spacing: 10) {
                    ZStack {
                        Color(hex: "#2a3340")
                        if let signature = setupInfo?.signature, let url = URL(string: signature.url) {
                            AsyncImage(url: url) { image in
                                image.resizable().aspectRatio(contentMode: .fit)
                            } placeholder: {
                                ProgressView().tint(.gray)
                            }
                            .padding(4)
                        }
                    }
                    .frame(width: 96, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 4) {
                            Image(systemName: needsSheet || setupInfo == nil ? "exclamationmark.circle" : "checkmark.circle.fill")
                                .foregroundColor(needsSheet || setupInfo == nil ? .orange : Color(hex: "#2dd4bf"))
                            Text(setupInfo.map { "Handwriting · \($0.letters.known)/\($0.letters.total) letters" } ?? "Handwriting")
                                .foregroundColor(Color(hex: "#cccccc"))
                        }
                        .font(.caption)

                        PhotosPicker(selection: $sheetPick, matching: .images) {
                            Text(busy == .sheet ? "Reading your sheet…" : ((setupInfo?.letters.known ?? 0) > 0 ? "New handwriting sheet" : "Add your handwriting sheet"))
                                .font(.caption)
                                .foregroundColor(Color(hex: "#2dd4bf"))
                        }
                        .buttonStyle(.plain)
                        .disabled(isWorking)
                    }
                }
            }
            .padding(.horizontal)

            if needsSheet {
                hint("Handwriting sheet, once: on plain paper write moodmixformat on the first line, then A–Z and 0–9 in capitals on the lines below with a gap between every letter. Photograph it flat. After that every song title is written in your hand automatically.")
            }

            if let title = setupInfo?.title, !title.missing.isEmpty, !needsSheet {
                Text("This title uses \(title.missing.joined(separator: " ")), which your sheet doesn't have.")
                    .font(.caption)
                    .foregroundColor(.orange)
                    .padding(.horizontal)
            }

            if let sheetError {
                Text(sheetError)
                    .font(.caption)
                    .foregroundColor(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal)
            }
        }
    }

    @ViewBuilder
    private func motionPreview(url: URL) -> some View {
        if motionUrlFormat == "youtube" {
            LoopingVideoPlayer(url: url)
                .aspectRatio(16.0 / 9.0, contentMode: .fit)
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: 12))
        } else if motionUrlFormat == "square" {
            LoopingVideoPlayer(url: url)
                .frame(width: 240, height: 240)
                .clipShape(RoundedRectangle(cornerRadius: 12))
        } else {
            LoopingVideoPlayer(url: url)
                .frame(width: 180, height: 320)
                .clipShape(RoundedRectangle(cornerRadius: 12))
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

    // MARK: - Building blocks

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.headline)
            .foregroundColor(Color(hex: "#f0f0f0"))
            .padding(.horizontal)
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundColor(.gray)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal)
    }

    private func smallChip(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.caption)
                .fontWeight(.medium)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .foregroundColor(selected ? Color(hex: "#080808") : Color(hex: "#f0f0f0"))
                .background(selected ? Color(hex: "#2dd4bf") : Color(hex: "#222222"))
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(isWorking)
    }

    // MARK: - Actions

    private func load() async {
        do {
            let library = try await MixbaseAPI.shared.listStudio(projectId: projectId)
            subjects = library.subjects
            lettering = library.lettering
            if subjectPath == nil { subjectPath = library.subjects.first?.path }
            if letteringPath == nil { letteringPath = library.lettering.first?.path }
        } catch {
            errorMessage = error.localizedDescription
        }
        if busy == .load { busy = nil }
        await loadMotion()
        await loadSetupInfo()
        await resumeQuick()
    }

    /// Whether the current cover can move. Best-effort: a failed read only
    /// hides the row until the next render.
    private func loadMotion() async {
        guard let availability = try? await MixbaseAPI.shared.cassetteMotionAvailability(projectId: projectId) else { return }
        canMove = availability.available
    }

    // MARK: One click

    private func loadSetupInfo() async {
        if let info = try? await MixbaseAPI.shared.studioSetup(projectId: projectId) {
            setupInfo = info
        }
    }

    /// A run already going (or just finished) for this song: show it, and
    /// keep polling if it is still going. What it already applied is not
    /// announced again.
    private func resumeQuick() async {
        guard let job = try? await MixbaseAPI.shared.latestQuickJob(projectId: projectId) else { return }
        announcedCover = job.finalizedArtworkUrl ?? job.artworkUrl
        announcedClips = Set(job.clips.map { $0.videoUrl })
        quickJob = job
        if job.isRunning {
            await pollQuick(job.id)
        }
    }

    private func makeIt() {
        let text = quickText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 3, !quickRunning else { return }
        quickError = nil
        Task {
            do {
                let job = try await MixbaseAPI.shared.startQuick(projectId: projectId, description: text)
                applyQuick(job)
                await pollQuick(job.id)
            } catch {
                quickError = error.localizedDescription
                // One may already be running for this song: pick it up.
                if let existing = try? await MixbaseAPI.shared.latestQuickJob(projectId: projectId), existing.isRunning {
                    applyQuick(existing)
                    await pollQuick(existing.id)
                }
            }
        }
    }

    /// Poll a run until it finishes. A newer poll (or leaving the screen)
    /// stops this one.
    private func pollQuick(_ id: String) async {
        pollToken += 1
        let token = pollToken
        while token == pollToken {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard token == pollToken else { return }
            do {
                let job = try await MixbaseAPI.shared.quickJob(id: id)
                applyQuick(job)
                if !job.isRunning {
                    await loadSetupInfo()
                    await loadLook()
                    return
                }
            } catch {
                quickError = error.localizedDescription
                return
            }
        }
    }

    /// Show a run's state and hand the song screen anything new it applied.
    private func applyQuick(_ job: MixbaseAPI.QuickJob) {
        quickJob = job
        if let art = job.artworkUrl {
            let cover = job.finalizedArtworkUrl ?? art
            if cover != announcedCover {
                announcedCover = cover
                onRendered(art, job.finalizedArtworkUrl)
                coverUrl = cover
                hasRendered = true
                canMove = true
            }
        }
        for clip in job.clips where !announcedClips.contains(clip.videoUrl) {
            announcedClips.insert(clip.videoUrl)
            onVisualizerPinned?(clip.videoUrl, clip.format == "youtube")
        }
    }

    private func uploadSheet(_ item: PhotosPickerItem) async {
        guard busy == nil else {
            sheetPick = nil
            return
        }
        busy = .sheet
        sheetError = nil
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                throw MixbaseAPIError.serverError("Could not read that image.")
            }
            try await MixbaseAPI.shared.uploadHandwritingSheet(imageData: data)
            await loadSetupInfo()
        } catch {
            sheetError = error.localizedDescription
        }
        busy = nil
        sheetPick = nil
    }

    // MARK: Type it / teach it

    private func typeIt() {
        guard busy == nil else { return }
        let text = typedText
        let align = typedAlign
        busy = .typing
        errorMessage = nil
        typeNote = nil
        Task {
            do {
                let file = try await MixbaseAPI.shared.typeLettering(projectId: projectId, text: text, align: align)
                lettering.insert(file, at: 0)
                letteringPath = file.path
                useLettering = true
                typeNote = "Set in your handwriting. Not quite right? Set it again for another take, or teach more samples of a letter."
            } catch {
                errorMessage = error.localizedDescription
                // The usual reason: a letter the bank has not learned yet.
                teachOpen = true
                if glyphCounts == nil { await loadGlyphs() }
            }
            busy = nil
        }
    }

    private func loadGlyphs() async {
        do {
            let bank = try await MixbaseAPI.shared.listGlyphs()
            glyphCounts = bank.counts
            glyphChars = bank.chars
        } catch {
            teachError = error.localizedDescription
        }
    }

    private func chooseTeachPhoto(_ item: PhotosPickerItem) async {
        teachError = nil
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                throw MixbaseAPIError.serverError("Could not read that image.")
            }
            teachData = data
        } catch {
            teachError = error.localizedDescription
        }
        teachPick = nil
    }

    /// Teach from the picked photo, or from the handwriting already lifted
    /// for this song, and the text it says.
    private func teach(fromPhoto: Bool) async {
        guard busy == nil else { return }
        let text = teachText
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            teachError = "Type what the writing says, line by line."
            return
        }
        busy = .teaching
        teachError = nil
        teachNote = nil
        do {
            let result: MixbaseAPI.GlyphTeachResult
            if fromPhoto {
                guard let teachData else {
                    throw MixbaseAPIError.serverError("Add a photo of your letters first.")
                }
                result = try await MixbaseAPI.shared.teachGlyphs(imageData: teachData, text: text)
            } else {
                guard let path = letteringPath else {
                    throw MixbaseAPIError.serverError("Add your handwriting first.")
                }
                result = try await MixbaseAPI.shared.teachGlyphs(letteringPath: path, text: text)
            }
            glyphCounts = result.counts
            let n = result.added.count
            teachNote = "Learned \(n) letter\(n == 1 ? "" : "s"). Teach the same letters again from another photo for more variety."
            teachData = nil
            teachText = ""
        } catch {
            teachError = error.localizedDescription
        }
        busy = nil
    }

    private func forget(_ letter: String) async {
        teachError = nil
        do {
            try await MixbaseAPI.shared.forgetGlyphs(char: letter)
            glyphCounts?[letter] = 0
        } catch {
            teachError = "Could not remove that letter."
        }
    }

    /// Section 4's presets, sliders and the look on the cover now. Called on
    /// open and after every render. A failed read hides the section (as on
    /// the web) rather than showing the previous cover's look as current;
    /// the rest of the studio works without it.
    private func loadLook() async {
        // Renders no longer wait on this read, so two can overlap; only the
        // newest one may replace the section.
        lookLoadSeq += 1
        let seq = lookLoadSeq
        let options = try? await MixbaseAPI.shared.filterOptions(projectId: projectId)
        guard seq == lookLoadSeq else { return }
        lookOptions = options
        lookRevision += 1
    }

    private func addSubject(_ item: PhotosPickerItem) async {
        guard busy == nil else {
            subjectPick = nil
            return
        }
        busy = .subject
        errorMessage = nil
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                throw MixbaseAPIError.serverError("Could not read that image.")
            }
            let file = try await MixbaseAPI.shared.uploadSubject(imageData: data)
            subjects.insert(file, at: 0)
            subjectPath = file.path
        } catch {
            errorMessage = error.localizedDescription
        }
        busy = nil
        subjectPick = nil
        await loadSetupInfo()
    }

    /// Same cut-out as addSubject, from an image already in one of the songs
    /// (the server fetches it; nothing is uploaded from the device).
    private func addSubject(fromLibrary photo: MixbaseAPI.StudioPhoto) async {
        guard !isWorking else { return }
        busy = .library
        errorMessage = nil
        do {
            let file = try await MixbaseAPI.shared.uploadSubject(sourcePath: photo.path)
            subjects.insert(file, at: 0)
            subjectPath = file.path
        } catch {
            errorMessage = error.localizedDescription
        }
        busy = nil
    }

    private func addLettering(_ item: PhotosPickerItem) async {
        guard busy == nil else {
            letteringPick = nil
            return
        }
        busy = .lettering
        errorMessage = nil
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                throw MixbaseAPIError.serverError("Could not read that image.")
            }
            let file = try await MixbaseAPI.shared.uploadLettering(projectId: projectId, imageData: data)
            lettering.insert(file, at: 0)
            letteringPath = file.path
            useLettering = true
        } catch {
            errorMessage = error.localizedDescription
        }
        busy = nil
        letteringPick = nil
    }

    private func chooseBackground(_ item: PhotosPickerItem) async {
        errorMessage = nil
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                throw MixbaseAPIError.serverError("Could not read that image.")
            }
            guard let preview = Self.previewImage(from: data, maxEdge: 300) else {
                throw MixbaseAPIError.serverError("Could not read that image.")
            }
            // Kept as picked; MixbaseAPI downscales it to ≤3000px JPEG at
            // upload time.
            backgroundData = data
            backgroundPreview = preview
            scene = "photo"
        } catch {
            errorMessage = error.localizedDescription
        }
        backgroundPick = nil
    }

    private func removeFile(_ file: MixbaseAPI.StudioFile, isSubject: Bool) async {
        guard busy == nil else { return }
        errorMessage = nil
        do {
            try await MixbaseAPI.shared.deleteStudioFile(path: file.path)
        } catch {
            errorMessage = "Could not remove that."
            return
        }
        if isSubject {
            subjects.removeAll { $0.path == file.path }
            if subjectPath == file.path { subjectPath = subjects.first?.path }
        } else {
            lettering.removeAll { $0.path == file.path }
            if letteringPath == file.path { letteringPath = lettering.first?.path }
        }
    }

    private func render(reletter: Bool) {
        guard busy == nil else { return }
        let sceneToSend = reletter ? "keep" : scene
        let subject = subjectPath
        let customSetting: String? = scene == "custom" ? setting : nil
        let background: Data? = (!reletter && scene == "photo") ? backgroundData : nil
        let letteringToSend: String? = (useLettering && currentLettering != nil) ? letteringPath : nil
        let chosenColor = color
        let chosenPosition = position
        let chosenSize = size
        let reflection = glossy
        let chosenPlacement = placement

        busy = reletter ? .reletter : .render
        errorMessage = nil
        lookNote = nil

        Task {
            do {
                let result = try await MixbaseAPI.shared.renderCassette(
                    projectId: projectId,
                    scene: sceneToSend,
                    subject: subject,
                    setting: customSetting,
                    background: background,
                    lettering: letteringToSend,
                    color: chosenColor,
                    position: chosenPosition,
                    size: chosenSize,
                    reflection: reflection,
                    placement: chosenPlacement
                )
                onRendered(result.artworkUrl, result.finalizedArtworkUrl)
                coverUrl = result.finalizedArtworkUrl ?? result.artworkUrl
                if !reletter {
                    lastSceneLabel = result.sceneLabel
                }
                hasRendered = true
                // The cover changed, so a moving cover made from the old one
                // no longer matches it.
                motionUrl = nil
                motionError = nil
                savedMotion = false
                await applyRememberedLook()
            } catch {
                errorMessage = error.localizedDescription
                busy = nil
                return
            }
            // The cover is applied and shown; refresh section 4 without
            // holding the rest of the studio on that read.
            busy = nil
            await loadLook()
        }
    }

    /// "Keep this look for new covers": every render comes back plain, so put
    /// the last saved look back on it. If that fails the plain cover stays,
    /// with a note, and section 4 opens on that look so adding it is one tap.
    private func applyRememberedLook() async {
        pendingLook = nil
        guard let remembered = CassetteLookMemory.lookForNewCovers else { return }
        busy = .look
        do {
            let result = try await MixbaseAPI.shared.saveFilter(projectId: projectId, settings: remembered)
            applySavedLook(result)
        } catch {
            pendingLook = remembered
            lookNote = "Your saved look wasn't added this time, so this cover is plain. Tap Save look below to add it."
        }
    }

    /// A look was baked into the cover server-side: mirror it like a render.
    private func applySavedLook(_ result: MixbaseAPI.FilterSaveResult) {
        if let artworkUrl = result.artworkUrl {
            onRendered(artworkUrl, result.finalizedArtworkUrl)
        }
        if let newCover = result.finalizedArtworkUrl ?? result.artworkUrl {
            coverUrl = newCover
        }
        // A moving cover made before the look no longer matches the cover.
        motionUrl = nil
        motionError = nil
        savedMotion = false
    }

    private func makeItMove() {
        guard busy == nil else { return }
        let format = motionFormat
        let wide = format == "youtube"
        let withTitle = motionWithTitle
        busy = .motion
        motionError = nil
        savedMotion = false

        Task {
            do {
                let clip = try await MixbaseAPI.shared.renderCassetteMotion(projectId: projectId, format: format, withTitle: withTitle)
                motionUrl = clip.videoUrl
                motionUrlFormat = format
                do {
                    // Landscape (YouTube) output pins as the 16:9 visualizer,
                    // everything else as the vertical one.
                    try await MixbaseAPI.shared.pinVisualizer(projectId: projectId, videoUrl: clip.videoUrl, wide: wide)
                    onVisualizerPinned?(clip.videoUrl, wide)
                } catch {
                    motionError = "Saved to Your Videos, but pinning it failed: \(error.localizedDescription)"
                }
            } catch {
                motionError = error.localizedDescription
            }
            busy = nil
        }
    }

    private func saveMotion(_ url: String) async {
        isSavingMotion = true
        motionError = nil
        do {
            try await PhotoLibrarySaver.saveVideo(from: url)
            savedMotion = true
        } catch {
            motionError = error.localizedDescription
        }
        isSavingMotion = false
    }

    /// Small preview of a picked photo (ImageIO, so it works the same on iOS
    /// and macOS and never decodes the full-resolution bitmap).
    private static func previewImage(from data: Data, maxEdge: Int) -> CGImage? {
        let sourceOptions: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions as CFDictionary) else { return nil }
        let thumbOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxEdge,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOptions as CFDictionary)
    }
}

// MARK: - StudioCheckerboard
// Drawn behind cut-outs so their transparency (and the clear plastic) shows.

private struct StudioCheckerboard: View {
    var body: some View {
        Canvas { context, size in
            let cell: CGFloat = 6
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(hex: "#1a1a1a")))
            var y: CGFloat = 0
            var row = 0
            while y < size.height {
                var x: CGFloat = row % 2 == 0 ? 0 : cell
                while x < size.width {
                    context.fill(Path(CGRect(x: x, y: y, width: cell, height: cell)), with: .color(Color(hex: "#262626")))
                    x += cell * 2
                }
                y += cell
                row += 1
            }
        }
    }
}

// MARK: - Back-button lock
// Leaving mid-upload or mid-render would drop the result on the floor, so the
// back button (and the iOS swipe-back that goes with it) is hidden while the
// studio is busy. macOS has no navigation-bar back button to hide.

#if os(iOS)
private extension View {
    func studioBackButtonHidden(_ hidden: Bool) -> some View {
        navigationBarBackButtonHidden(hidden)
    }
}
#else
private extension View {
    func studioBackButtonHidden(_ hidden: Bool) -> some View {
        self
    }
}
#endif
