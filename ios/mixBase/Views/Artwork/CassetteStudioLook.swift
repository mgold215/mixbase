import SwiftUI
import CoreGraphics
import ImageIO

// MARK: - Cassette Studio: the look + photos already in mixBase
// Two pieces of CassetteStudioView that keep their own state:
//
//  • CassetteLookSection — "4 · Finish the look": presets, sliders and a
//    tone switch over a live preview of the cover, then "Save look" bakes it
//    in server-side (/api/cassette-studio/filter). The server applies every
//    look to the cover's UNFILTERED base, so looks never stack.
//  • StudioPhotoPickerSheet — "From mixBase": the owner's images already in
//    his songs, so a cassette photo he's uploaded before needn't be sent
//    from the phone again.
//
// Mirrors src/components/CassetteStudio.tsx. Owner-only like the rest of the
// studio. Platform-neutral: previews are decoded with ImageIO into a CGImage,
// so the same code runs in the macOS app.

// MARK: - CassetteLookMemory
// "Keep this look for new covers": the toggle and the last saved look, kept
// on this device. A fresh render is always unfiltered, so CassetteStudioView
// puts this look back on it automatically.

enum CassetteLookMemory {
    static let keepKey = "cassetteStudio.keepLook"
    private static let lookKey = "cassetteStudio.lastLook"

    /// On unless the owner switched it off.
    static var keepForNewCovers: Bool {
        UserDefaults.standard.object(forKey: keepKey) as? Bool ?? true
    }

    /// The last look saved from the studio (JSON-encoded FilterSettings).
    static var lastLook: MixbaseAPI.FilterSettings? {
        get {
            guard let data = UserDefaults.standard.data(forKey: lookKey) else { return nil }
            return try? JSONDecoder().decode(MixbaseAPI.FilterSettings.self, from: data)
        }
        set {
            if let newValue, let data = try? JSONEncoder().encode(newValue) {
                UserDefaults.standard.set(data, forKey: lookKey)
            } else {
                UserDefaults.standard.removeObject(forKey: lookKey)
            }
        }
    }

    /// The look to put on a new cover, or nil when the toggle is off or the
    /// remembered look is Original.
    static var lookForNewCovers: MixbaseAPI.FilterSettings? {
        guard keepForNewCovers, let look = lastLook, !look.isOriginal else { return nil }
        return look
    }
}

// MARK: - CassetteLookSection

struct CassetteLookSection: View {

    let projectId: UUID
    // The unfiltered cover, shown until the first preview arrives.
    let baseUrl: String
    let presets: [MixbaseAPI.FilterPreset]
    let adjustments: [MixbaseAPI.FilterAdjustment]
    // The rest of the studio is busy (rendering, cutting out…).
    let locked: Bool
    // True while a save is in flight, so the studio holds still meanwhile.
    @Binding var isSaving: Bool
    // The server has baked the look into the project's cover.
    let onSaved: (MixbaseAPI.FilterSaveResult) -> Void

    @State private var look: MixbaseAPI.FilterSettings
    // The look on the cover right now.
    @State private var savedLook: MixbaseAPI.FilterSettings
    @State private var didSave = false
    @State private var saveError: String?

    @State private var preview: CGImage?
    @State private var isPreviewing = false
    @State private var previewError: String?
    // The 250 ms wait before a preview; every change restarts it.
    @State private var debounceTask: Task<Void, Never>?
    // The preview request in flight; cancelled only when a newer one starts,
    // so a drag that pauses still shows the in-between results (as on the web).
    @State private var previewTask: Task<Void, Never>?

    @AppStorage(CassetteLookMemory.keepKey) private var keepLook = true

    /// `initialLook` opens the editor on a look that is NOT on the cover yet
    /// (the remembered look, after it could not be added automatically), so
    /// saving it is one tap; nil starts from the cover's own look.
    init(
        projectId: UUID,
        options: MixbaseAPI.FilterOptions,
        initialLook: MixbaseAPI.FilterSettings? = nil,
        locked: Bool,
        isSaving: Binding<Bool>,
        onSaved: @escaping (MixbaseAPI.FilterSaveResult) -> Void
    ) {
        self.projectId = projectId
        self.baseUrl = options.baseUrl ?? ""
        self.presets = options.presets
        // A reversed range would trap in Slider; fall back to the contract's
        // sliders if the server sends nothing usable.
        let usable = options.adjustments.filter { $0.min < $0.max }
        self.adjustments = usable.isEmpty ? MixbaseAPI.FilterAdjustment.fallback : usable
        self.locked = locked
        self._isSaving = isSaving
        self.onSaved = onSaved
        let start = options.current ?? MixbaseAPI.FilterSettings.original
        self._look = State(initialValue: initialLook ?? start)
        self._savedLook = State(initialValue: start)
    }

    private var canSave: Bool {
        !locked && !isSaving && !look.matches(savedLook)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("4 · Finish the look")
                .font(.headline)
                .foregroundColor(Color(hex: "#f0f0f0"))
                .padding(.horizontal)

            previewArea
                .padding(.horizontal)

            if let previewError {
                Text(previewError)
                    .font(.caption)
                    .foregroundColor(.gray)
                    .padding(.horizontal)
            }

            presetRow

            Picker("Tone", selection: toneBinding) {
                Text("Color").tag("color")
                Text("B&W").tag("bw")
                Text("Sepia").tag("sepia")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(locked)
            .padding(.horizontal)

            VStack(spacing: 10) {
                ForEach(adjustments) { adjustment in
                    adjustmentSlider(adjustment)
                }
            }
            .padding(.horizontal)

            Toggle(isOn: $keepLook) {
                Text("Keep this look for new covers")
                    .font(.caption)
                    .foregroundColor(Color(hex: "#f0f0f0"))
            }
            .toggleStyle(.switch)
            .tint(Color(hex: "#2dd4bf"))
            .padding(.horizontal)

            actionRow
                .padding(.horizontal)

            if let saveError {
                Text(saveError)
                    .font(.caption)
                    .foregroundColor(.red)
                    .padding(.horizontal)
            } else if didSave && look.matches(savedLook) {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle.fill")
                    Text("Saved")
                }
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(Color(hex: "#2dd4bf"))
                .padding(.horizontal)
            }
        }
        .onAppear { requestPreview(debounced: false) }
        .onChange(of: look) { _, _ in
            saveError = nil
            requestPreview(debounced: true)
        }
        .onDisappear {
            debounceTask?.cancel()
            previewTask?.cancel()
        }
    }

    // MARK: Preview

    private var previewArea: some View {
        ZStack {
            if let preview {
                Image(decorative: preview, scale: 1)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
            } else if let url = URL(string: baseUrl) {
                AsyncImage(url: url) { image in
                    image.resizable().aspectRatio(contentMode: .fit)
                } placeholder: {
                    Rectangle()
                        .fill(Color(hex: "#1a1a1a"))
                        .aspectRatio(1, contentMode: .fit)
                }
            } else {
                Rectangle()
                    .fill(Color(hex: "#1a1a1a"))
                    .aspectRatio(1, contentMode: .fit)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(alignment: .topTrailing) {
            if isPreviewing {
                ProgressView()
                    .tint(.white)
                    .padding(8)
                    .background(Color.black.opacity(0.55), in: Circle())
                    .padding(10)
            }
        }
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity)
    }

    // MARK: Controls

    private var presetRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(presets) { preset in
                    Button(action: { choose(preset) }) {
                        Text(preset.label)
                            .font(.caption)
                            .fontWeight(.medium)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .foregroundColor(look.preset == preset.id ? Color(hex: "#080808") : Color(hex: "#f0f0f0"))
                            .background(look.preset == preset.id ? Color(hex: "#2dd4bf") : Color(hex: "#222222"))
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(locked)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 2)
        }
    }

    private func adjustmentSlider(_ adjustment: MixbaseAPI.FilterAdjustment) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(adjustment.label)
                    .font(.caption)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                Spacer()
                Text("\(look[adjustment: adjustment.id])")
                    .font(.caption.monospacedDigit())
                    .foregroundColor(.gray)
            }
            Slider(value: sliderBinding(adjustment), in: adjustment.min...adjustment.max, step: 1)
                .tint(Color(hex: "#2dd4bf"))
        }
        .disabled(locked)
    }

    private var actionRow: some View {
        HStack(spacing: 10) {
            Button(action: { look = MixbaseAPI.FilterSettings.original }) {
                Text("Reset")
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .padding(.horizontal, 18)
                    .padding(.vertical, 14)
                    .background(Color(hex: "#111111"))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12)
                            .stroke(Color(hex: "#333333"), lineWidth: 1)
                    )
                    .cornerRadius(12)
            }
            .buttonStyle(.plain)
            .disabled(locked || isSaving || look.isOriginal)
            .opacity(locked || isSaving || look.isOriginal ? 0.5 : 1)

            Button(action: save) {
                HStack {
                    if isSaving {
                        ProgressView().tint(Color(hex: "#080808"))
                        Text("Saving…")
                    } else {
                        Image(systemName: "checkmark")
                        Text("Save look")
                    }
                }
                .font(.headline)
                .foregroundColor(Color(hex: "#080808"))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(canSave || isSaving ? Color(hex: "#2dd4bf") : Color.gray.opacity(0.4))
                .cornerRadius(12)
            }
            .buttonStyle(.plain)
            .disabled(!canSave)
        }
    }

    private var toneBinding: Binding<String> {
        Binding(
            get: { look.tone },
            set: { newValue in
                guard newValue != look.tone else { return }
                look.tone = newValue
                look.preset = "custom"
            }
        )
    }

    private func sliderBinding(_ adjustment: MixbaseAPI.FilterAdjustment) -> Binding<Double> {
        Binding(
            get: { Double(look[adjustment: adjustment.id]) },
            set: { newValue in
                let value = Int(newValue.rounded())
                guard value != look[adjustment: adjustment.id] else { return }
                look[adjustment: adjustment.id] = value
                look.preset = "custom"
            }
        )
    }

    private func choose(_ preset: MixbaseAPI.FilterPreset) {
        var next = preset.settings
        next.preset = preset.id
        look = next
    }

    // MARK: Actions

    /// Fetch a preview of the current look, 250 ms after the last change
    /// (straight away on open). The sliders never wait on this.
    private func requestPreview(debounced: Bool) {
        debounceTask?.cancel()
        let settings = look
        isPreviewing = true
        previewError = nil
        debounceTask = Task {
            if debounced {
                try? await Task.sleep(for: .milliseconds(250))
                if Task.isCancelled { return }
            }
            startPreview(settings)
        }
    }

    /// Start one preview request, cancelling the one in flight (the contract:
    /// a newer preview cancels the older one when it STARTS). Until then an
    /// older answer may still land and is shown, so a drag that pauses shows
    /// its in-between results; the spinner stays up until the look on screen
    /// has its own preview.
    private func startPreview(_ settings: MixbaseAPI.FilterSettings) {
        previewTask?.cancel()
        previewTask = Task {
            do {
                let data = try await MixbaseAPI.shared.filterPreview(projectId: projectId, settings: settings)
                if Task.isCancelled { return }
                guard let image = Self.decodePreview(data) else {
                    throw MixbaseAPIError.invalidResponse("Couldn't show the preview.")
                }
                preview = image
            } catch {
                if Task.isCancelled { return }
                // A newer look is already on its way; its answer decides.
                guard settings == look else { return }
                previewError = "Preview didn't load: \(error.localizedDescription)"
            }
            if settings == look {
                isPreviewing = false
            }
        }
    }

    private func save() {
        guard canSave else { return }
        let settings = look
        isSaving = true
        saveError = nil
        Task {
            do {
                let result = try await MixbaseAPI.shared.saveFilter(projectId: projectId, settings: settings)
                let applied = result.filter ?? MixbaseAPI.FilterSettings.original
                savedLook = applied
                CassetteLookMemory.lastLook = applied
                // The server clamps; show what it actually applied unless the
                // owner has already moved on to another look.
                if look == settings && !applied.matches(settings) {
                    look = applied
                }
                didSave = true
                onSaved(result)
            } catch {
                saveError = error.localizedDescription
            }
            isSaving = false
        }
    }

    /// The preview JPEG as a CGImage (ImageIO — iOS and macOS alike).
    private static func decodePreview(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [kCGImageSourceShouldCacheImmediately: true]
        return CGImageSourceCreateImageAtIndex(source, 0, options as CFDictionary)
    }
}

// MARK: - StudioPhotoPickerSheet
// "From mixBase": a grid of the owner's images already in his songs (newest
// first). Picking one hands it back for the same cut-out as a new photo.

struct StudioPhotoPickerSheet: View {

    @Environment(\.dismiss) private var dismiss

    let onPick: (MixbaseAPI.StudioPhoto) -> Void

    @State private var photos: [MixbaseAPI.StudioPhoto] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    private let columns = [GridItem(.adaptive(minimum: 100), spacing: 12)]

    init(onPick: @escaping (MixbaseAPI.StudioPhoto) -> Void) {
        self.onPick = onPick
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808").ignoresSafeArea()

                if isLoading {
                    ProgressView().tint(Color(hex: "#2dd4bf"))
                } else if let errorMessage {
                    message(errorMessage)
                } else if photos.isEmpty {
                    message("No images in your songs yet. Covers and artwork you add to mixBase show up here.")
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Pick a photo of your cassette. It's cut out and kept with your cassettes.")
                                .font(.caption)
                                .foregroundColor(.gray)
                                .fixedSize(horizontal: false, vertical: true)

                            LazyVGrid(columns: columns, spacing: 12) {
                                ForEach(photos) { photo in
                                    photoTile(photo)
                                }
                            }
                        }
                        .padding()
                    }
                }
            }
            .navigationTitle("From mixBase")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.foregroundColor(.gray)
                }
            }
        }
        .photoSheetFrame()
        .task { await load() }
    }

    private func photoTile(_ photo: MixbaseAPI.StudioPhoto) -> some View {
        Button(action: {
            onPick(photo)
            dismiss()
        }) {
            VStack(spacing: 6) {
                Group {
                    if let url = URL(string: photo.thumbUrl ?? photo.url) {
                        StudioPhotoThumb(url: url)
                    } else {
                        Rectangle().fill(Color(hex: "#1a1a1a"))
                    }
                }
                .frame(height: 104)
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: 10))

                Text(photo.projectTitle ?? "Untitled")
                    .font(.caption2)
                    .foregroundColor(.gray)
                    .lineLimit(1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("Use this photo from \(photo.projectTitle ?? "Untitled")"))
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundColor(.gray)
            .multilineTextAlignment(.center)
            .padding(32)
    }

    private func load() async {
        do {
            photos = try await MixbaseAPI.shared.studioPhotos()
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

// MARK: - Grid thumbnails
// The server hands back full-size originals (often several MB, some much
// larger). AsyncImage would decode each at full size and keep none of them, so
// the grid downloads each once, downsamples it off the main thread with ImageIO
// and keeps the small image for the rest of the session.

private final class StudioThumbCache: @unchecked Sendable {
    static let shared = StudioThumbCache()
    private let cache = NSCache<NSString, CGImage>()

    private init() {
        cache.countLimit = 300
    }

    func image(for key: String) -> CGImage? {
        cache.object(forKey: key as NSString)
    }

    func store(_ image: CGImage, for key: String) {
        cache.setObject(image, forKey: key as NSString)
    }
}

/// A thumbnail no larger than `maxPixel` on its long side (ImageIO; iOS and macOS alike).
private func downsampledThumbnail(_ data: Data, maxPixel: CGFloat) -> CGImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceShouldCacheImmediately: true,
        kCGImageSourceThumbnailMaxPixelSize: maxPixel,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
}

private struct StudioPhotoThumb: View {
    let url: URL

    @Environment(\.displayScale) private var displayScale
    @State private var image: CGImage?
    @State private var failed = false

    var body: some View {
        ZStack {
            Rectangle().fill(Color(hex: "#1a1a1a"))
            if let image {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else if failed {
                Image(systemName: "photo")
                    .foregroundColor(.gray)
            }
        }
        .task(id: url) { await load() }
    }

    private func load() async {
        let key = url.absoluteString
        if let cached = StudioThumbCache.shared.image(for: key) {
            image = cached
            return
        }
        // A tile is ~104pt tall and cropped to fill, so the long side needs a
        // little headroom over the tile.
        let maxPixel = 160 * max(displayScale, 1)
        do {
            let data = try await MixbaseAPI.shared.imageData(from: url)
            let thumb = await Task.detached(priority: .utility) {
                downsampledThumbnail(data, maxPixel: maxPixel)
            }.value
            if Task.isCancelled { return }
            if let thumb {
                StudioThumbCache.shared.store(thumb, for: key)
                image = thumb
            } else {
                failed = true
            }
        } catch {
            if !Task.isCancelled { failed = true }
        }
    }
}

// MARK: - Sheet size
// A macOS sheet sizes itself to its content, which collapses a scrolling grid;
// give it a usable size. iOS sheets fill the screen anyway.

#if os(macOS)
private extension View {
    func photoSheetFrame() -> some View {
        frame(minWidth: 520, minHeight: 560)
    }
}
#else
private extension View {
    func photoSheetFrame() -> some View {
        self
    }
}
#endif
