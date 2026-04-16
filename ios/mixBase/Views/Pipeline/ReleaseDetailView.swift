import SwiftUI

// MARK: - ReleaseDetailView
// Full release detail screen with editable fields:
// - Title, release date, linked project
// - Checklist toggles (mixing, mastering, artwork, DSP, social, press)
// - DSP platform toggles (Spotify, Apple Music, Tidal, Bandcamp, SoundCloud, YouTube, Amazon)
// - Notes text editor
// Each toggle change saves to Supabase.

struct ReleaseDetailView: View {

    // The release data — we use @State so we can mutate the toggles locally
    @State var release: Release

    // Track if we're currently saving to Supabase
    @State private var isSaving = false

    var body: some View {
        ZStack {
            // Dark background
            Color(hex: "#080808")
                .ignoresSafeArea()

            Form {
                // MARK: - Title (editable)
                Section {
                    TextField("Release title", text: $release.title)
                        .foregroundColor(Color(hex: "#f0f0f0"))
                        .onChange(of: release.title) { _, _ in
                            saveRelease()
                        }
                } header: {
                    Text("Title")
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }

                // MARK: - Release Date
                Section {
                    DatePicker(
                        "Release Date",
                        selection: Binding(
                            get: { release.releaseDate ?? Date() },
                            set: { newDate in
                                release.releaseDate = newDate
                                saveRelease()
                            }
                        ),
                        displayedComponents: .date
                    )
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .tint(Color(hex: "#2dd4bf"))
                } header: {
                    Text("Date")
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }

                // MARK: - Linked Project
                if let projectId = release.projectId {
                    Section {
                        NavigationLink(destination: ProjectDetailView(projectId: projectId)) {
                            HStack {
                                Image(systemName: "link")
                                    .foregroundColor(Color(hex: "#2dd4bf"))
                                Text("View linked project")
                                    .foregroundColor(Color(hex: "#f0f0f0"))
                            }
                        }
                    } header: {
                        Text("Project")
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }
                }

                // MARK: - Checklist
                // Toggle rows for each step in the release process
                Section {
                    checklistToggle(label: "Mixing Done", icon: "slider.horizontal.3", isOn: $release.mixingDone)
                    checklistToggle(label: "Mastering Done", icon: "waveform", isOn: $release.masteringDone)
                    checklistToggle(label: "Artwork Ready", icon: "photo", isOn: $release.artworkReady)
                    checklistToggle(label: "DSP Submitted", icon: "arrow.up.circle", isOn: $release.dspSubmitted)
                    checklistToggle(label: "Social Posts Done", icon: "bubble.left.and.bubble.right", isOn: $release.socialPostsDone)
                    checklistToggle(label: "Press Release Done", icon: "doc.text", isOn: $release.pressReleaseDone)
                } header: {
                    Text("Checklist")
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }

                // MARK: - DSP Platforms
                // Toggle rows for each streaming platform
                Section {
                    checklistToggle(label: "Spotify", icon: "music.note", isOn: $release.dspSpotify)
                    checklistToggle(label: "Apple Music", icon: "music.note.list", isOn: $release.dspAppleMusic)
                    checklistToggle(label: "Tidal", icon: "waveform.circle", isOn: $release.dspTidal)
                    checklistToggle(label: "Bandcamp", icon: "bag", isOn: $release.dspBandcamp)
                    checklistToggle(label: "SoundCloud", icon: "cloud", isOn: $release.dspSoundcloud)
                    checklistToggle(label: "YouTube", icon: "play.rectangle", isOn: $release.dspYoutube)
                    checklistToggle(label: "Amazon", icon: "shippingbox", isOn: $release.dspAmazon)
                } header: {
                    Text("DSP Platforms")
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }

                // MARK: - Notes
                Section {
                    TextEditor(text: Binding(
                        get: { release.notes ?? "" },
                        set: { newValue in
                            release.notes = newValue.isEmpty ? nil : newValue
                        }
                    ))
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .frame(minHeight: 100)
                    .scrollContentBackground(.hidden)
                    .background(Color.clear)
                    .onChange(of: release.notes) { _, _ in
                        saveRelease()
                    }
                } header: {
                    Text("Notes")
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }
            }
            .scrollContentBackground(.hidden) // Hide default white form background
        }
        .navigationTitle(release.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
    }

    // MARK: - Checklist Toggle Row
    // A reusable toggle row with an icon, label, and a teal-tinted switch
    private func checklistToggle(label: String, icon: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: Binding(
            get: { isOn.wrappedValue },
            set: { newValue in
                isOn.wrappedValue = newValue
                saveRelease()
            }
        )) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .foregroundColor(isOn.wrappedValue ? Color(hex: "#2dd4bf") : .gray)
                    .frame(width: 20)
                Text(label)
                    .foregroundColor(Color(hex: "#f0f0f0"))
            }
        }
        .tint(Color(hex: "#2dd4bf"))
    }

    // MARK: - Save Release
    // Debounced save — sends the updated release to Supabase
    private func saveRelease() {
        guard !isSaving else { return }
        isSaving = true

        Task {
            // Small delay to batch rapid changes (e.g. toggling multiple items quickly)
            try? await Task.sleep(for: .milliseconds(500))
            do {
                try await SupabaseService.shared.updateRelease(release)
            } catch {
                print("ReleaseDetailView: Failed to save release — \(error.localizedDescription)")
            }
            isSaving = false
        }
    }
}
