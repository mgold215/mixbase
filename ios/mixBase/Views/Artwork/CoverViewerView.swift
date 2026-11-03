import SwiftUI

// The full cover art, opened by tapping the album art (the songs list, the
// song screen). Everyone can look at it and save it to Photos (Downloads on
// the Mac); the platform owner can also change the handwritten title (colour,
// spot, size — the cover re-lettered from its kept layers through
// /api/cassette-studio/render with scene = keep, no new scene, no AI) and the
// look (Finish the look, the same section Cassette Studio uses), without
// opening the Studio. Shared iOS + macOS source: SwiftUI only.
struct CoverViewerView: View {
    let projectId: UUID
    let title: String
    /// The cover changed here (a re-lettering, a look): the caller mirrors it.
    let onRendered: (String, String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var authService = AuthService.shared

    @State private var coverUrl: String

    // Saving the cover to the device.
    @State private var isSaving = false
    @State private var saved = false
    @State private var saveError: String?

    // The title: the song's newest lettering, what scene = keep re-applies.
    @State private var letteringPath: String?
    @State private var letteringLoaded = false
    @State private var color = "auto"
    @State private var position = "auto"
    @State private var size = "medium"
    @State private var titleBusy = false
    @State private var titleError: String?
    @State private var titleNote: String?

    // The look (CassetteLookSection), rebuilt after every new cover.
    @State private var lookOptions: MixbaseAPI.FilterOptions?
    @State private var lookRevision = 0
    @State private var lookSaving = false

    private static let positions: [(id: String, symbol: String)] = [
        ("top-left", "arrow.up.left"), ("top-center", "arrow.up"), ("top-right", "arrow.up.right"),
        ("bottom-left", "arrow.down.left"), ("bottom-center", "arrow.down"), ("bottom-right", "arrow.down.right"),
    ]

    private static let sizes: [(id: String, label: String)] = [
        ("small", "S"), ("medium", "M"), ("large", "L"),
    ]

    init(projectId: UUID, title: String, coverUrl: String, onRendered: @escaping (String, String?) -> Void) {
        self.projectId = projectId
        self.title = title
        self.onRendered = onRendered
        self._coverUrl = State(initialValue: coverUrl)
    }

    private var isBusy: Bool { titleBusy || lookSaving }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let url = URL(string: coverUrl) {
                        AsyncImage(url: url) { image in
                            image.resizable().aspectRatio(contentMode: .fit)
                        } placeholder: {
                            Color(hex: "#111111")
                                .aspectRatio(1, contentMode: .fit)
                                .overlay(ProgressView().tint(.gray))
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .padding(.horizontal)
                    }

                    saveRow

                    if authService.ownerTools {
                        titleSection
                        lookSection
                    }
                }
                .padding(.top, 8)
                .padding(.bottom, 40)
            }
            .background(Color.black.ignoresSafeArea())
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }
            }
            .task { await load() }
        }
    }

    // MARK: - Save

    private var saveRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            if isSaving {
                ProgressView().tint(Color(hex: "#2dd4bf"))
            } else if saved {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark")
                    Text("Saved")
                }
                .font(.subheadline)
                .fontWeight(.semibold)
                .foregroundColor(Color(hex: "#2dd4bf"))
            } else {
                Button(action: { Task { await saveCover() } }) {
                    HStack(spacing: 6) {
                        Image(systemName: "square.and.arrow.down")
                        Text(saveLabel)
                    }
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundColor(Color(hex: "#080808"))
                    .padding(.horizontal, 18)
                    .padding(.vertical, 10)
                    .background(Color(hex: "#2dd4bf"))
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            if let saveError {
                Text(saveError)
                    .font(.caption)
                    .foregroundColor(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal)
    }

    /// iOS saves into the Photos library; macOS downloads into ~/Downloads.
    private var saveLabel: String {
        #if os(iOS)
        "Save to Photos"
        #else
        "Save to Downloads"
        #endif
    }

    // MARK: - The title

    private var titleSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("The title")
                .font(.headline)
                .foregroundColor(Color(hex: "#f0f0f0"))

            if !letteringLoaded {
                ProgressView().tint(.gray)
            } else if letteringPath == nil {
                Text("No handwriting on this song yet. Add it in Cassette Studio and the title can be changed here.")
                    .font(.caption)
                    .foregroundColor(.gray)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        chip("Auto", selected: color == "auto") { color = "auto" }
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
                            .disabled(isBusy)
                            .accessibilityLabel(Text(option.label))
                        }
                    }
                    .padding(.vertical, 2)
                }

                HStack(alignment: .top, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Position")
                            .font(.caption2)
                            .foregroundColor(.gray)
                        chip("Auto", selected: position == "auto") { position = "auto" }
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
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Size")
                            .font(.caption2)
                            .foregroundColor(.gray)
                        HStack(spacing: 4) {
                            ForEach(Self.sizes, id: \.id) { option in
                                chip(option.label, selected: size == option.id) { size = option.id }
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }

                Button(action: { Task { await updateTitle() } }) {
                    HStack(spacing: 6) {
                        if titleBusy {
                            ProgressView().tint(Color(hex: "#080808"))
                        } else {
                            Image(systemName: "pencil")
                        }
                        Text(titleBusy ? "Updating…" : "Update the title")
                    }
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundColor(Color(hex: "#080808"))
                    .padding(.horizontal, 18)
                    .padding(.vertical, 10)
                    .background(isBusy && !titleBusy ? Color.gray.opacity(0.4) : Color(hex: "#2dd4bf"))
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(isBusy)

                Text("Re-letters this cover from its kept layers, no new scene. A clip filmed before keeps its title.")
                    .font(.caption2)
                    .foregroundColor(.gray)
                    .fixedSize(horizontal: false, vertical: true)

                if let titleNote {
                    Text(titleNote)
                        .font(.caption)
                        .foregroundColor(Color(hex: "#2dd4bf"))
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let titleError {
                    Text(titleError)
                        .font(.caption)
                        .foregroundColor(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal)
    }

    private func chip(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
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
        .disabled(isBusy)
    }

    private func positionButton(_ option: (id: String, symbol: String)) -> some View {
        Button(action: { position = option.id }) {
            Image(systemName: option.symbol)
                .font(.caption)
                .foregroundColor(position == option.id ? Color(hex: "#080808") : Color(hex: "#999999"))
                .frame(width: 34, height: 30)
                .background(position == option.id ? Color(hex: "#2dd4bf") : Color(hex: "#222222"))
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
    }

    // MARK: - The look

    @ViewBuilder
    private var lookSection: some View {
        if let options = lookOptions, options.baseUrl != nil {
            CassetteLookSection(
                projectId: projectId,
                options: options,
                heading: "The look",
                locked: titleBusy,
                isSaving: $lookSaving,
                onSaved: { result in
                    if let art = result.artworkUrl {
                        onRendered(art, result.finalizedArtworkUrl)
                    }
                    if let cover = result.finalizedArtworkUrl ?? result.artworkUrl {
                        coverUrl = cover
                        saved = false
                    }
                }
            )
            .id(lookRevision)
        }
    }

    // MARK: - Actions

    private func load() async {
        guard authService.ownerTools else { return }
        let library = try? await MixbaseAPI.shared.listStudio(projectId: projectId)
        // Newest first, the one the Studio would use too.
        letteringPath = library?.lettering.first?.path
        letteringLoaded = true
        lookOptions = try? await MixbaseAPI.shared.filterOptions(projectId: projectId)
        lookRevision += 1
    }

    private func saveCover() async {
        isSaving = true
        saveError = nil
        do {
            try await PhotoLibrarySaver.saveImage(from: coverUrl)
            saved = true
        } catch {
            saveError = error.localizedDescription
        }
        isSaving = false
    }

    /// Re-letter the current cover (scene = keep) with the song's own
    /// lettering in the chosen colour, spot and size, then put the remembered
    /// look back on, as the Studio does after a render.
    private func updateTitle() async {
        guard let letteringPath, !isBusy else { return }
        titleBusy = true
        titleError = nil
        titleNote = nil
        do {
            let result = try await MixbaseAPI.shared.renderCassette(
                projectId: projectId,
                scene: "keep",
                subject: nil,
                setting: nil,
                background: nil,
                lettering: letteringPath,
                color: color,
                position: position,
                size: size,
                reflection: false
            )
            coverUrl = result.finalizedArtworkUrl ?? result.artworkUrl
            saved = false
            onRendered(result.artworkUrl, result.finalizedArtworkUrl)
            if let remembered = CassetteLookMemory.lookForNewCovers {
                if let look = try? await MixbaseAPI.shared.saveFilter(projectId: projectId, settings: remembered) {
                    if let art = look.artworkUrl {
                        onRendered(art, look.finalizedArtworkUrl)
                    }
                    if let cover = look.finalizedArtworkUrl ?? look.artworkUrl {
                        coverUrl = cover
                    }
                } else {
                    titleNote = "Your saved look wasn't added again, so this cover is plain. Add it below."
                }
            }
            lookOptions = try? await MixbaseAPI.shared.filterOptions(projectId: projectId)
            lookRevision += 1
        } catch {
            titleError = error.localizedDescription
        }
        titleBusy = false
    }
}
