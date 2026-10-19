import SwiftUI
import CoreGraphics

// MARK: - FinalizeArtworkView
// Native twin of the web Artwork tab's Finalize step (ArtworkGenerator.tsx):
// choose where the artist name and song title go, how big, a colour grade, the
// text colour and the divider line. The SERVER does the lettering
// (POST /api/finalize-artwork — the same Futura renderer the website uses) and
// saves the result as the project's finalized cover, so the app and the
// website can never letter a cover differently. Nothing is drawn on device.
//
// The controls are built from GET /api/finalize-artwork — the server's own
// option list (src/lib/finalize-options.ts) — so a filter or position added on
// the web appears here without an app update.
//
// Open to every account: no AI, no monthly allowance (only the server's hourly
// rate limit applies).

struct FinalizeArtworkView: View {

    let projectId: UUID

    /// The clean source image (artwork_url) — what the server letters.
    let sourceUrl: String

    /// The project's current lettered cover, if it has one.
    let finalizedUrl: String?

    /// Lets the presenting screen show the new cover immediately.
    var onFinalized: ((String) -> Void)? = nil

    @State private var options: MixbaseAPI.FinalizeOptions?
    @State private var settings: MixbaseAPI.FinalizeSettings?
    @State private var loadError: String?

    /// The cover rendered in this visit (replaces `finalizedUrl` in the preview).
    @State private var renderedUrl: String?
    @State private var isFinalizing = false
    @State private var errorMessage: String?

    @State private var isSaving = false
    @State private var saveMessage: String?

    private let teal = Color(hex: "#2dd4bf")

    /// What the preview shows: this visit's render, else the existing lettered
    /// cover, else the clean source.
    private var previewUrl: String {
        renderedUrl ?? finalizedUrl ?? sourceUrl
    }

    private var hasLetteredCover: Bool {
        renderedUrl != nil || finalizedUrl != nil
    }

    var body: some View {
        ZStack {
            Color(hex: "#080808")
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    preview

                    Text("Adds your artist name and the song title to the cover. Your artist name comes from Settings.")
                        .font(.caption)
                        .foregroundColor(.gray)
                        .padding(.horizontal)

                    if let options, let current = settings {
                        controls(options: options, settings: Binding(
                            get: { settings ?? current },
                            set: { settings = $0 }
                        ))
                    } else if let loadError {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(loadError)
                                .font(.caption)
                                .foregroundColor(.red)
                            Button("Try again") { Task { await loadOptions() } }
                                .font(.subheadline.weight(.medium))
                                .foregroundColor(teal)
                        }
                        .padding(.horizontal)
                    } else {
                        ProgressView()
                            .tint(teal)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 24)
                    }

                    Spacer(minLength: 80)
                }
                .padding(.top, 16)
            }
        }
        .navigationTitle("Finalize Artwork")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .task {
            if options == nil { await loadOptions() }
        }
    }

    // MARK: - Preview

    private var preview: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let url = URL(string: previewUrl) {
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                } placeholder: {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(Color(hex: "#1a1a1a"))
                        .aspectRatio(1, contentMode: .fit)
                        .overlay(ProgressView().tint(.gray))
                }
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay {
                    if isFinalizing {
                        RoundedRectangle(cornerRadius: 12)
                            .fill(Color.black.opacity(0.55))
                            .overlay(ProgressView().tint(teal).scaleEffect(1.4))
                    }
                }
            }

            if renderedUrl != nil {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(teal)
                    Text("Saved as the project cover")
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundColor(Color(hex: "#f0f0f0"))
                }
            } else {
                Text(finalizedUrl != nil ? "Current finalized cover" : "Current artwork")
                    .font(.caption)
                    .foregroundColor(.gray)
            }
        }
        .padding(.horizontal)
    }

    // MARK: - Controls

    @ViewBuilder
    private func controls(options: MixbaseAPI.FinalizeOptions, settings: Binding<MixbaseAPI.FinalizeSettings>) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            // Text placement — 3×3 anchor grid (the server lists the anchors
            // in reading order, so rows of three)
            section("Text placement") {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(stride(from: 0, to: options.positions.count, by: 3)), id: \.self) { start in
                        HStack(spacing: 6) {
                            ForEach(options.positions[start..<min(start + 3, options.positions.count)], id: \.self) { position in
                                positionCell(position, selected: settings.wrappedValue.position == position) {
                                    settings.wrappedValue.position = position
                                }
                            }
                        }
                    }
                }
            }

            // Size
            section("Size") {
                Picker("Size", selection: settings.size) {
                    ForEach(options.sizes) { size in
                        Text(size.label).tag(size.value)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }

            // Filter — whole-image colour grades
            section("Filter") {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 4), spacing: 6) {
                    ForEach(options.filters) { filter in
                        chip(filter.label, selected: settings.wrappedValue.filter == filter.value) {
                            settings.wrappedValue.filter = filter.value
                        }
                    }
                }
            }

            // Text colour — preset swatches + a free picker, white by default
            section("Text color") {
                colorRow(options: options, settings: settings)
            }

            // Divider line between artist name and title
            Toggle(isOn: settings.showRule) {
                Text("Divider line between name & title")
                    .font(.subheadline)
                    .foregroundColor(Color(hex: "#f0f0f0"))
            }
            .tint(teal)
            .padding(.horizontal)

            // Finalize
            Button(action: finalize) {
                HStack(spacing: 8) {
                    if isFinalizing {
                        ProgressView()
                            .tint(Color(hex: "#080808"))
                        Text("Finalizing…")
                    } else {
                        Image(systemName: "wand.and.stars")
                        Text(hasLetteredCover ? "Finalize Again" : "Finalize Artwork")
                    }
                }
                .font(.headline)
                .foregroundColor(Color(hex: "#080808"))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(isFinalizing ? Color.gray.opacity(0.4) : teal)
                .cornerRadius(12)
            }
            .buttonStyle(.plain)
            .disabled(isFinalizing)
            .padding(.horizontal)

            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundColor(.red)
                    .padding(.horizontal)
            }

            // Save the lettered cover — the web's "Download Finalized"
            if hasLetteredCover {
                Button(action: saveCover) {
                    HStack(spacing: 6) {
                        if isSaving {
                            ProgressView().tint(teal)
                        } else {
                            Image(systemName: "square.and.arrow.down")
                        }
                        Text(saveButtonTitle)
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundColor(teal)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(teal.opacity(0.15))
                    .cornerRadius(10)
                }
                .buttonStyle(.plain)
                .disabled(isSaving || isFinalizing)
                .padding(.horizontal)

                if let saveMessage {
                    Text(saveMessage)
                        .font(.caption)
                        .foregroundColor(.gray)
                        .padding(.horizontal)
                }
            }
        }
    }

    private var saveButtonTitle: String {
        #if os(iOS)
        return "Save Finalized Cover to Photos"
        #else
        return "Save Finalized Cover to Downloads"
        #endif
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundColor(.gray)
            content()
        }
        .padding(.horizontal)
    }

    private func chip(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.caption)
                .fontWeight(.medium)
                .foregroundColor(selected ? teal : Color(hex: "#999999"))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(selected ? teal.opacity(0.2) : Color(hex: "#0f0f0f"))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(selected ? teal.opacity(0.5) : Color(hex: "#222222"), lineWidth: 1)
                )
                .cornerRadius(8)
        }
        .buttonStyle(.plain)
        .disabled(isFinalizing)
    }

    /// One cell of the placement grid — the dot sits where the text will.
    private func positionCell(_ position: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            RoundedRectangle(cornerRadius: 7)
                .fill(selected ? teal.opacity(0.15) : Color(hex: "#0f0f0f"))
                .overlay(
                    RoundedRectangle(cornerRadius: 7)
                        .stroke(selected ? teal : Color(hex: "#2a2a2a"), lineWidth: 1)
                )
                .overlay(alignment: Self.alignment(for: position)) {
                    Circle()
                        .fill(selected ? teal : Color(hex: "#555555"))
                        .frame(width: 7, height: 7)
                        .padding(6)
                }
                .frame(width: 38, height: 38)
        }
        .buttonStyle(.plain)
        .disabled(isFinalizing)
        .accessibilityLabel(Text(position.replacingOccurrences(of: "-", with: " ")))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// `vertical-horizontal` (e.g. "bottom-center") → where the dot sits.
    private static func alignment(for position: String) -> Alignment {
        let parts = position.split(separator: "-").map(String.init)
        let v = parts.first ?? "middle"
        let h = parts.last ?? "center"
        let vertical: VerticalAlignment = v == "top" ? .top : (v == "bottom" ? .bottom : .center)
        let horizontal: HorizontalAlignment = h == "left" ? .leading : (h == "right" ? .trailing : .center)
        return Alignment(horizontal: horizontal, vertical: vertical)
    }

    @ViewBuilder
    private func colorRow(options: MixbaseAPI.FinalizeOptions, settings: Binding<MixbaseAPI.FinalizeSettings>) -> some View {
        let current = settings.wrappedValue.color.uppercased()
        let isPreset = options.colors.contains { $0.value.uppercased() == current }

        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(options.colors) { option in
                    let selected = option.value.uppercased() == current
                    Button(action: { settings.wrappedValue.color = option.value.uppercased() }) {
                        Circle()
                            .fill(Color(hex: option.value))
                            .frame(width: 28, height: 28)
                            .overlay(
                                Circle()
                                    .stroke(
                                        selected ? teal : Color(hex: "#333333"),
                                        lineWidth: selected ? 3 : 1
                                    )
                            )
                    }
                    .buttonStyle(.plain)
                    .disabled(isFinalizing)
                    .accessibilityLabel(Text("Text color \(option.label)"))
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }

                // Any other colour — the web's custom picker.
                ColorPicker("Custom text color", selection: Binding(
                    get: { Self.cgColor(hex: settings.wrappedValue.color) },
                    set: { newValue in
                        if let hex = Self.hex(from: newValue) { settings.wrappedValue.color = hex }
                    }
                ), supportsOpacity: false)
                .labelsHidden()
                .disabled(isFinalizing)
                .overlay(
                    Circle()
                        .stroke(teal, lineWidth: 3)
                        .frame(width: 34, height: 34)
                        .opacity(isPreset ? 0 : 1)
                        .allowsHitTesting(false)
                )

                Text(current)
                    .font(.caption2.monospaced())
                    .foregroundColor(.gray)
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 2)
        }
    }

    // MARK: - Colour conversion (CoreGraphics — iOS and macOS alike)

    private static func cgColor(hex: String) -> CGColor {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else {
            return CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
        }
        return CGColor(
            srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }

    /// #RRGGBB in sRGB — the only colour shape the server accepts.
    private static func hex(from color: CGColor) -> String? {
        guard let srgb = CGColorSpace(name: CGColorSpace.sRGB),
              let converted = color.converted(to: srgb, intent: .defaultIntent, options: nil),
              let components = converted.components,
              components.count >= 3 else { return nil }
        func byte(_ component: CGFloat) -> Int {
            Int((min(max(component, 0), 1) * 255).rounded())
        }
        return String(format: "#%02X%02X%02X", byte(components[0]), byte(components[1]), byte(components[2]))
    }

    // MARK: - Actions

    private func loadOptions() async {
        loadError = nil
        do {
            let loaded = try await MixbaseAPI.shared.finalizeOptions()
            options = loaded
            if settings == nil {
                settings = MixbaseAPI.FinalizeSettings(
                    position: loaded.defaults.position,
                    size: loaded.defaults.size,
                    filter: loaded.defaults.filter,
                    color: loaded.defaults.color,
                    showRule: loaded.defaults.showRule
                )
            }
        } catch {
            loadError = "Could not load the finalize options. \(error.localizedDescription)"
        }
    }

    private func finalize() {
        guard let settings, !isFinalizing else { return }
        isFinalizing = true
        errorMessage = nil
        saveMessage = nil

        Task {
            do {
                let url = try await MixbaseAPI.shared.finalizeArtwork(projectId: projectId, settings: settings)
                renderedUrl = url
                onFinalized?(url)
            } catch {
                errorMessage = error.localizedDescription
            }
            isFinalizing = false
        }
    }

    private func saveCover() {
        isSaving = true
        saveMessage = nil
        let url = previewUrl

        Task {
            do {
                try await PhotoLibrarySaver.saveImage(from: url)
                #if os(iOS)
                saveMessage = "Saved to your Photos library."
                #else
                saveMessage = "Saved to your Downloads folder."
                #endif
            } catch {
                saveMessage = error.localizedDescription
            }
            isSaving = false
        }
    }
}
