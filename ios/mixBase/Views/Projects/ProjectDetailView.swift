import SwiftUI
import PhotosUI

// MARK: - ProjectDetailView
// Shows full details for a single project: artwork, editable metadata, versions list,
// buttons to generate/upload artwork, upload versions, and share.

struct ProjectDetailView: View {

    let projectId: UUID

    @EnvironmentObject var audioService: AudioService

    @State private var project: Project?
    @State private var versions: [Version] = []
    @State private var isLoading = true

    // Editing state
    @State private var isEditingTitle = false
    @State private var editTitle = ""
    @State private var editGenre = ""
    @State private var editBpm = ""
    @State private var editKey = ""
    @State private var isSaving = false

    // Photo picker for artwork upload
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var isUploadingArtwork = false

    var body: some View {
        ZStack {
            Color(hex: "#080808")
                .ignoresSafeArea()

            if isLoading {
                ProgressView()
                    .tint(Color(hex: "#2dd4bf"))
            } else if let project = project {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // MARK: - Artwork with upload/generate options
                        artworkSection(project: project)

                        // MARK: - Editable Project Info
                        projectInfoSection(project: project)

                        // MARK: - Quick Play (plays latest version)
                        if let latest = versions.max(by: { $0.versionNumber < $1.versionNumber }) {
                            Button(action: {
                                audioService.play(
                                    version: latest,
                                    trackName: project.title,
                                    artworkUrl: project.artworkUrl
                                )
                            }) {
                                HStack {
                                    Image(systemName: "play.fill")
                                    Text("Play Latest (v\(latest.versionNumber))")
                                }
                                .font(.subheadline)
                                .fontWeight(.semibold)
                                .foregroundColor(Color(hex: "#080808"))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .background(Color(hex: "#2dd4bf"))
                                .cornerRadius(10)
                            }
                            .padding(.horizontal)
                        }

                        // MARK: - Versions Section
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Text("Versions")
                                    .font(.headline)
                                    .foregroundColor(Color(hex: "#f0f0f0"))
                                Text("(\(versions.count))")
                                    .font(.subheadline)
                                    .foregroundColor(.gray)
                                Spacer()
                            }
                            .padding(.horizontal)

                            if versions.isEmpty {
                                Text("No versions yet — upload your first mix")
                                    .font(.subheadline)
                                    .foregroundColor(.gray)
                                    .padding(.horizontal)
                            } else {
                                ForEach(versions.sorted(by: { $0.versionNumber > $1.versionNumber })) { version in
                                    versionRow(version: version, project: project)
                                }
                            }
                        }

                        // MARK: - Upload Version Button
                        Button(action: {
                            print("Upload version tapped")
                        }) {
                            HStack {
                                Image(systemName: "arrow.up.doc")
                                Text("Upload Version")
                            }
                            .font(.subheadline)
                            .fontWeight(.medium)
                            .foregroundColor(Color(hex: "#2dd4bf"))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color(hex: "#2dd4bf").opacity(0.15))
                            .cornerRadius(10)
                        }
                        .padding(.horizontal)

                        Spacer(minLength: 80)
                    }
                    .padding(.top, 16)
                }
            } else {
                Text("Project not found")
                    .foregroundColor(.gray)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .task {
            await loadProjectData()
        }
        // Handle photo selection for artwork upload
        .onChange(of: selectedPhoto) { _, newItem in
            if let newItem {
                Task { await uploadSelectedPhoto(newItem) }
            }
        }
    }

    // MARK: - Artwork Section
    // Large artwork with overlay buttons to generate AI art or upload from photos
    @ViewBuilder
    private func artworkSection(project: Project) -> some View {
        ZStack(alignment: .bottomTrailing) {
            // Large artwork image
            if let artworkUrl = project.artworkUrl, let url = URL(string: artworkUrl) {
                AsyncImage(url: url) { image in
                    image.resizable().aspectRatio(contentMode: .fill)
                } placeholder: {
                    artworkPlaceholder
                }
                .frame(maxWidth: .infinity)
                .frame(height: 280)
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .padding(.horizontal)
            } else {
                artworkPlaceholder
                    .frame(height: 280)
                    .padding(.horizontal)
            }

            // Overlay buttons: Generate AI art + Upload from photos
            HStack(spacing: 8) {
                // Upload from Photos
                PhotosPicker(selection: $selectedPhoto, matching: .images) {
                    HStack(spacing: 4) {
                        Image(systemName: "photo")
                        Text("Upload")
                    }
                    .font(.caption2)
                    .fontWeight(.medium)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.black.opacity(0.7))
                    .cornerRadius(8)
                }

                // Generate AI artwork
                NavigationLink(destination: ArtworkGeneratorView(projectId: projectId)) {
                    HStack(spacing: 4) {
                        Image(systemName: "paintbrush")
                        Text("AI Art")
                    }
                    .font(.caption2)
                    .fontWeight(.medium)
                    .foregroundColor(Color(hex: "#080808"))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color(hex: "#2dd4bf"))
                    .cornerRadius(8)
                }
            }
            .padding(12)
            .padding(.trailing, 4)

            // Loading indicator for artwork upload
            if isUploadingArtwork {
                Color.black.opacity(0.6)
                    .frame(maxWidth: .infinity)
                    .frame(height: 280)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .overlay(
                        ProgressView()
                            .tint(Color(hex: "#2dd4bf"))
                            .scaleEffect(1.5)
                    )
                    .padding(.horizontal)
            }
        }
    }

    private var artworkPlaceholder: some View {
        RoundedRectangle(cornerRadius: 16)
            .fill(Color(hex: "#1a1a1a"))
            .overlay(
                VStack(spacing: 8) {
                    Image(systemName: "music.note")
                        .font(.system(size: 48))
                        .foregroundColor(.gray.opacity(0.3))
                    Text("No artwork")
                        .font(.caption)
                        .foregroundColor(.gray.opacity(0.4))
                }
            )
    }

    // MARK: - Editable Project Info
    // Tap the title or metadata to edit inline
    @ViewBuilder
    private func projectInfoSection(project: Project) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            // Title — tap to edit
            if isEditingTitle {
                // Editing mode: text fields for all metadata
                VStack(alignment: .leading, spacing: 10) {
                    TextField("Title", text: $editTitle)
                        .font(.title2)
                        .fontWeight(.bold)
                        .foregroundColor(Color(hex: "#f0f0f0"))
                        .padding(8)
                        .background(Color(hex: "#161616"))
                        .cornerRadius(8)

                    HStack(spacing: 10) {
                        TextField("Genre", text: $editGenre)
                            .font(.subheadline)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                            .padding(8)
                            .background(Color(hex: "#161616"))
                            .cornerRadius(8)

                        TextField("BPM", text: $editBpm)
                            .font(.subheadline)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                            .keyboardType(.numberPad)
                            .padding(8)
                            .background(Color(hex: "#161616"))
                            .cornerRadius(8)
                            .frame(width: 80)

                        TextField("Key", text: $editKey)
                            .font(.subheadline)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                            .padding(8)
                            .background(Color(hex: "#161616"))
                            .cornerRadius(8)
                            .frame(width: 60)
                    }

                    HStack(spacing: 10) {
                        Button("Save") {
                            Task { await saveProjectEdits() }
                        }
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundColor(Color(hex: "#080808"))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Color(hex: "#2dd4bf"))
                        .cornerRadius(8)

                        Button("Cancel") {
                            isEditingTitle = false
                        }
                        .font(.subheadline)
                        .foregroundColor(.gray)
                    }
                }
            } else {
                // Display mode — tap to enter edit mode
                Button(action: {
                    editTitle = project.title
                    editGenre = project.genre ?? ""
                    editBpm = project.bpm != nil ? "\(project.bpm!)" : ""
                    editKey = project.keySignature ?? ""
                    isEditingTitle = true
                }) {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(project.title)
                                .font(.title2)
                                .fontWeight(.bold)
                                .foregroundColor(Color(hex: "#f0f0f0"))

                            Image(systemName: "pencil")
                                .font(.caption)
                                .foregroundColor(.gray.opacity(0.5))
                        }

                        HStack(spacing: 12) {
                            if let genre = project.genre {
                                metadataTag(icon: "guitars", text: genre)
                            }
                            if let bpm = project.bpm {
                                metadataTag(icon: "metronome", text: "\(bpm) BPM")
                            }
                            if let key = project.keySignature {
                                metadataTag(icon: "music.note", text: key)
                            }
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal)
    }

    private func metadataTag(icon: String, text: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.caption2)
            Text(text)
                .font(.caption)
        }
        .foregroundColor(.gray)
    }

    // MARK: - Version Row
    @ViewBuilder
    private func versionRow(version: Version, project: Project) -> some View {
        Button(action: {
            audioService.play(
                version: version,
                trackName: project.title,
                artworkUrl: project.artworkUrl
            )
        }) {
            HStack(spacing: 12) {
                // Play indicator / version number
                ZStack {
                    Circle()
                        .fill(
                            audioService.currentVersion?.id == version.id
                                ? Color(hex: "#2dd4bf")
                                : Color(hex: "#2dd4bf").opacity(0.15)
                        )
                        .frame(width: 36, height: 36)

                    if audioService.currentVersion?.id == version.id && audioService.isPlaying {
                        Image(systemName: "waveform")
                            .font(.caption)
                            .foregroundColor(Color(hex: "#080808"))
                    } else {
                        Text("v\(version.versionNumber)")
                            .font(.caption)
                            .fontWeight(.bold)
                            .foregroundColor(
                                audioService.currentVersion?.id == version.id
                                    ? Color(hex: "#080808")
                                    : Color(hex: "#2dd4bf")
                            )
                    }
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text(version.label ?? "Version \(version.versionNumber)")
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundColor(Color(hex: "#f0f0f0"))

                    HStack(spacing: 6) {
                        Text(version.createdAt, style: .date)
                            .font(.caption2)
                            .foregroundColor(.gray)

                        if let seconds = version.durationSeconds {
                            Text(formatDuration(seconds))
                                .font(.caption2)
                                .foregroundColor(.gray)
                        }
                    }
                }

                Spacer()

                StatusBadge(status: version.status)

                // Share button
                Button(action: { shareVersion(version) }) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.caption)
                        .foregroundColor(.gray)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Helpers

    private func formatDuration(_ totalSeconds: Int) -> String {
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return String(format: "%d:%02d", minutes, seconds)
    }

    private func shareVersion(_ version: Version) {
        if let token = version.shareToken {
            let shareUrl = "https://mixbase-production.up.railway.app/share/\(token)"
            UIPasteboard.general.string = shareUrl
        }
    }

    // MARK: - Save Edits
    private func saveProjectEdits() async {
        guard var updatedProject = project else { return }
        isSaving = true

        updatedProject.title = editTitle.trimmingCharacters(in: .whitespaces)
        updatedProject.genre = editGenre.isEmpty ? nil : editGenre
        updatedProject.bpm = Int(editBpm)
        updatedProject.keySignature = editKey.isEmpty ? nil : editKey

        do {
            try await SupabaseService.shared.updateProject(updatedProject)
            project = updatedProject
            isEditingTitle = false
        } catch {
            print("Failed to save project: \(error.localizedDescription)")
        }
        isSaving = false
    }

    // MARK: - Upload Photo as Artwork
    private func uploadSelectedPhoto(_ item: PhotosPickerItem) async {
        isUploadingArtwork = true
        do {
            // Load image data from the photo picker
            guard let data = try await item.loadTransferable(type: Data.self) else {
                isUploadingArtwork = false
                return
            }

            // Upload to Supabase Storage
            let filename = "\(projectId.uuidString)/\(Int(Date().timeIntervalSince1970)).jpg"
            let publicUrl = try await SupabaseService.shared.uploadArtwork(data: data, filename: filename)

            // Update the project's artwork URL
            if var updatedProject = project {
                updatedProject.artworkUrl = publicUrl
                try await SupabaseService.shared.updateProject(updatedProject)
                project = updatedProject
            }
        } catch {
            print("Failed to upload artwork: \(error.localizedDescription)")
        }
        isUploadingArtwork = false
        selectedPhoto = nil
    }

    // MARK: - Data Loading
    private func loadProjectData() async {
        isLoading = true
        do {
            project = try await SupabaseService.shared.fetchProject(id: projectId)
            versions = try await SupabaseService.shared.fetchVersions(projectId: projectId)
        } catch {
            print("ProjectDetailView: Failed to load project — \(error.localizedDescription)")
        }
        isLoading = false
    }
}
