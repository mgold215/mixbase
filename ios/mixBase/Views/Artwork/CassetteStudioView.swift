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
        case load, subject, lettering, render, reletter, motion
    }

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

    // Status
    @State private var busy: Busy? = .load
    @State private var errorMessage: String?
    @State private var lastSceneLabel: String?
    @State private var hasRendered = false
    @State private var coverUrl: String?

    // Make it move
    @State private var motionFormat = "canvas"
    @State private var motionUrl: String?
    @State private var motionUrlFormat = "canvas"
    @State private var motionError: String?
    @State private var isSavingMotion = false
    @State private var savedMotion = false

    private var isWorking: Bool { busy != nil }

    // Leaving mid-upload or mid-render would orphan the request's result.
    private var blocksLeaving: Bool {
        busy != nil && busy != .load
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
                    Text("Your real cassette, dropped into a new scene and lettered in your own handwriting.")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                        .padding(.horizontal)

                    cassetteSection
                    handwritingSection
                    sceneSection
                    actionSection

                    if hasRendered {
                        motionSection
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
                        VStack(spacing: 4) {
                            if busy == .subject {
                                ProgressView().tint(Color(hex: "#2dd4bf"))
                                Text("Cutting out…")
                            } else {
                                Image(systemName: "camera")
                                Text("Add photo")
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
                    .buttonStyle(.plain)
                    .disabled(isWorking)
                    .opacity(isWorking && busy != .subject ? 0.5 : 1)
                }
                .padding(.horizontal)
                .padding(.vertical, 6)
            }

            if subjects.isEmpty && busy != .load {
                hint("Snap your cassette straight on, at its own height, standing on a table. A plain wall or card behind it gives the cleanest result. We cut it out once and reuse it for every cover. The cassette is never AI-generated.")
            }
        }
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
                hint("Write the artist name and song title with a marker on plain paper and photograph it flat. Your exact strokes are lifted off the paper, with no font and no AI.")
            }

            if currentLettering != nil && useLettering {
                letteringControls
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
        }
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
        }
    }

    // MARK: - Make it move

    @ViewBuilder
    private var motionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Make it move")

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

        busy = reletter ? .reletter : .render
        errorMessage = nil

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
                    reflection: reflection
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
            } catch {
                errorMessage = error.localizedDescription
            }
            busy = nil
        }
    }

    private func makeItMove() {
        guard busy == nil else { return }
        let format = motionFormat
        let wide = format == "youtube"
        busy = .motion
        motionError = nil
        savedMotion = false

        Task {
            do {
                let url = try await MixbaseAPI.shared.renderCassetteMotion(projectId: projectId, format: format)
                motionUrl = url
                motionUrlFormat = format
                do {
                    // Landscape (YouTube) output pins as the 16:9 visualizer,
                    // everything else as the vertical one.
                    try await MixbaseAPI.shared.pinVisualizer(projectId: projectId, videoUrl: url, wide: wide)
                    onVisualizerPinned?(url, wide)
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
