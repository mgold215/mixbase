import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

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

    // Audio upload for new versions
    @State private var showAudioPicker = false
    @State private var isUploadingAudio = false
    @State private var uploadProgress = ""
    @State private var newVersionLabel = ""

    // Feedback
    @State private var feedbackByVersion: [UUID: [Feedback]] = [:]
    @State private var expandedFeedback: Set<UUID> = []

    // Version history is collapsed by default, matching the web app's
    // "Version history (N)" toggle.
    @State private var showVersionHistory = false

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
                                    artworkUrl: project.artworkUrl,
                                    visualizerUrl: project.visualizerUrl
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

                        // MARK: - Visualizer (Spotify-Canvas-style loop for this track)
                        NavigationLink(destination: VisualizerView(
                            projectId: project.id,
                            projectTitle: project.title,
                            artworkUrl: project.artworkUrl,
                            pinnedUrl: project.visualizerUrl,
                            onPinChanged: { url in self.project?.visualizerUrl = url }
                        )) {
                            HStack {
                                Image(systemName: "sparkles.tv")
                                Text(project.visualizerUrl == nil ? "Create Visualizer" : "Visualizer")
                                Spacer()
                                if project.visualizerUrl != nil {
                                    HStack(spacing: 3) {
                                        Image(systemName: "pin.fill")
                                        Text("Pinned")
                                    }
                                    .font(.caption)
                                    .foregroundColor(Color(hex: "#2dd4bf"))
                                }
                                Image(systemName: "chevron.right")
                                    .font(.caption)
                                    .foregroundColor(.gray)
                            }
                            .font(.subheadline)
                            .fontWeight(.medium)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .background(Color(hex: "#111111"))
                            .cornerRadius(10)
                        }
                        .padding(.horizontal)

                        // MARK: - Upload Version Button
                        if isUploadingAudio {
                            VStack(spacing: 8) {
                                ProgressView()
                                    .tint(Color(hex: "#2dd4bf"))
                                Text(uploadProgress)
                                    .font(.caption)
                                    .foregroundColor(.gray)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color(hex: "#111111"))
                            .cornerRadius(10)
                            .padding(.horizontal)
                        } else {
                            VStack(spacing: 8) {
                                TextField("Version label (optional)", text: $newVersionLabel)
                                    .font(.caption)
                                    .foregroundColor(Color(hex: "#f0f0f0"))
                                    .padding(8)
                                    .background(Color(hex: "#161616"))
                                    .cornerRadius(6)
                                    .padding(.horizontal)

                                Button(action: { showAudioPicker = true }) {
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
                            }
                        }

                        // MARK: - Master Check (latest mix)
                        if let latest = versions.max(by: { $0.versionNumber < $1.versionNumber }) {
                            MasterCheckCard(version: latest)
                                .id(latest.id) // reset measurement state when a new mix lands
                                .padding(.horizontal)
                        }

                        // MARK: - Version History (collapsible, like the web app)
                        VStack(alignment: .leading, spacing: 12) {
                            if versions.isEmpty {
                                HStack {
                                    Text("Version History")
                                        .font(.headline)
                                        .foregroundColor(Color(hex: "#f0f0f0"))
                                    Spacer()
                                }
                                .padding(.horizontal)

                                Text("No versions yet — upload your first mix")
                                    .font(.subheadline)
                                    .foregroundColor(.gray)
                                    .padding(.horizontal)
                            } else {
                                Button(action: {
                                    withAnimation(.easeOut(duration: 0.15)) { showVersionHistory.toggle() }
                                }) {
                                    HStack {
                                        Image(systemName: "clock.arrow.circlepath")
                                            .font(.subheadline)
                                            .foregroundColor(.gray)
                                        Text("Version History")
                                            .font(.headline)
                                            .foregroundColor(Color(hex: "#f0f0f0"))
                                        Text("(\(versions.count))")
                                            .font(.subheadline)
                                            .foregroundColor(.gray)
                                        Spacer()
                                        Image(systemName: showVersionHistory ? "chevron.up" : "chevron.down")
                                            .font(.caption)
                                            .foregroundColor(.gray)
                                    }
                                    .padding(.horizontal)
                                }
                                .buttonStyle(.plain)

                                if showVersionHistory {
                                    ForEach(versions.sorted(by: { $0.versionNumber > $1.versionNumber })) { version in
                                        versionRow(version: version, project: project)
                                    }
                                }
                            }
                        }

                        // MARK: - Feedback Section
                        feedbackSection

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
        // Audio file picker for new versions
        .fileImporter(
            isPresented: $showAudioPicker,
            allowedContentTypes: [.audio, .mp3, .wav, .aiff, .mpeg4Audio],
            allowsMultipleSelection: false
        ) { result in
            if case .success(let urls) = result, let url = urls.first {
                Task { await uploadAudioVersion(url: url) }
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

                // Generate AI artwork (server applies it; update our copy live)
                NavigationLink(destination: ArtworkGeneratorView(projectId: projectId, onGenerated: { url in
                    self.project?.artworkUrl = url
                })) {
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
                artworkUrl: project.artworkUrl,
                visualizerUrl: project.visualizerUrl
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
            let shareUrl = "\(Config.apiBaseURL)/share/\(token)"
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
            let filename = "\(projectId.storageKeyComponent)-\(Int(Date().timeIntervalSince1970)).jpg"
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

    // MARK: - Feedback Section
    @ViewBuilder
    private var feedbackSection: some View {
        let allFeedback = versions.flatMap { v in feedbackByVersion[v.id] ?? [] }
        if !allFeedback.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Feedback")
                        .font(.headline)
                        .foregroundColor(Color(hex: "#f0f0f0"))
                    Text("(\(allFeedback.count))")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                    Spacer()
                }
                .padding(.horizontal)

                ForEach(versions.filter { feedbackByVersion[$0.id]?.isEmpty == false }) { version in
                    VStack(alignment: .leading, spacing: 6) {
                        // Version header
                        Button(action: {
                            if expandedFeedback.contains(version.id) {
                                expandedFeedback.remove(version.id)
                            } else {
                                expandedFeedback.insert(version.id)
                            }
                        }) {
                            HStack {
                                Text("v\(version.versionNumber)")
                                    .font(.caption)
                                    .fontWeight(.bold)
                                    .foregroundColor(Color(hex: "#2dd4bf"))
                                Text("\(feedbackByVersion[version.id]?.count ?? 0) responses")
                                    .font(.caption)
                                    .foregroundColor(.gray)
                                Spacer()
                                Image(systemName: expandedFeedback.contains(version.id) ? "chevron.up" : "chevron.down")
                                    .font(.caption)
                                    .foregroundColor(.gray)
                            }
                        }
                        .buttonStyle(.plain)

                        // Feedback items
                        if expandedFeedback.contains(version.id) {
                            ForEach(feedbackByVersion[version.id] ?? []) { feedback in
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(feedback.reviewerName ?? "Anonymous")
                                            .font(.caption)
                                            .fontWeight(.semibold)
                                            .foregroundColor(Color(hex: "#f0f0f0"))

                                        if let rating = feedback.rating {
                                            HStack(spacing: 2) {
                                                ForEach(1...5, id: \.self) { star in
                                                    Image(systemName: star <= rating ? "star.fill" : "star")
                                                        .font(.system(size: 8))
                                                        .foregroundColor(star <= rating ? .yellow : .gray.opacity(0.3))
                                                }
                                            }
                                        }

                                        Spacer()

                                        Text(feedback.createdAt, style: .date)
                                            .font(.caption2)
                                            .foregroundColor(.gray.opacity(0.5))
                                    }

                                    if let comment = feedback.comment, !comment.isEmpty {
                                        Text(comment)
                                            .font(.caption)
                                            .foregroundColor(.gray)
                                    }
                                }
                                .padding(10)
                                .background(Color(hex: "#161616"))
                                .cornerRadius(8)
                            }
                        }
                    }
                    .padding(12)
                    .background(Color(hex: "#111111"))
                    .cornerRadius(10)
                    .padding(.horizontal)
                }
            }
        }
    }

    // MARK: - Upload Audio Version
    private func uploadAudioVersion(url: URL) async {
        guard let project = project else { return }
        isUploadingAudio = true
        uploadProgress = "Preparing file..."

        // Copy the picked file into our sandbox first: the picker's
        // security-scoped grant can lapse mid-upload, and a local copy lets the
        // upload stream from disk instead of holding a whole mix in memory.
        guard url.startAccessingSecurityScopedResource() else {
            await showUploadResult("⚠️ Cannot access that file — try picking it again", success: false)
            return
        }
        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("version-upload-\(UUID().uuidString)")
            .appendingPathExtension(url.pathExtension)
        do {
            try FileManager.default.copyItem(at: url, to: tempURL)
        } catch {
            url.stopAccessingSecurityScopedResource()
            await showUploadResult("⚠️ Couldn't read the file: \(error.localizedDescription)", success: false)
            return
        }
        url.stopAccessingSecurityScopedResource()
        defer { try? FileManager.default.removeItem(at: tempURL) }

        do {
            let ext = url.pathExtension.lowercased()
            // Only names the STORAGE OBJECT (which is timestamped, so a stale
            // guess just makes a slightly-misnamed file). The row's real
            // version_number is assigned server-side by POST /api/versions.
            let nextVersion = (versions.map(\.versionNumber).max() ?? 0) + 1
            let filename = "\(project.id.storageKeyComponent)-v\(nextVersion)-\(Int(Date().timeIntervalSince1970)).\(ext)"

            uploadProgress = "Uploading audio… 0%"
            let audioUrl = try await SupabaseService.shared.uploadAudio(fileURL: tempURL, filename: filename) { fraction in
                Task { @MainActor in
                    uploadProgress = "Uploading audio… \(Int(fraction * 100))%"
                }
            }

            uploadProgress = "Creating version..."
            let label = newVersionLabel.isEmpty ? nil : newVersionLabel
            // The user-facing name is the file they PICKED (url), not tempURL —
            // tempURL is a UUID scratch copy. Without this the version showed no
            // name at all, which is what "the upload didn't work" looked like.
            // Probe tempURL for size/duration: it's the copy we still own, and
            // the security-scoped original has already been released by here.
            let version = try await MixbaseAPI.shared.createVersion(
                projectId: project.id,
                audioUrl: audioUrl,
                label: label,
                audioFilename: url.lastPathComponent,
                durationSeconds: await AudioFileMetadata.durationSeconds(of: tempURL),
                fileSizeBytes: AudioFileMetadata.fileSize(of: tempURL)
            )

            versions.append(version)
            newVersionLabel = ""
            await showUploadResult("Done!", success: true)
        } catch {
            await showUploadResult("⚠️ Upload failed: \(error.localizedDescription)", success: false)
        }
    }

    // Show the outcome, then restore the upload button. Failures stay up long
    // enough to actually read — the old 1.5s flash made every failure look
    // like the upload just silently vanished.
    private func showUploadResult(_ message: String, success: Bool) async {
        uploadProgress = message
        try? await Task.sleep(nanoseconds: success ? 1_500_000_000 : 6_000_000_000)
        isUploadingAudio = false
        uploadProgress = ""
    }

    // MARK: - Data Loading
    private func loadProjectData() async {
        isLoading = true
        do {
            project = try await SupabaseService.shared.fetchProject(id: projectId)
            versions = try await SupabaseService.shared.fetchVersions(projectId: projectId)

            // Load feedback for all versions concurrently
            let versionIds = versions.map(\.id)
            feedbackByVersion = await withTaskGroup(of: (UUID, [Feedback]).self) { group in
                for id in versionIds {
                    group.addTask {
                        (id, (try? await SupabaseService.shared.fetchFeedback(versionId: id)) ?? [])
                    }
                }
                var result: [UUID: [Feedback]] = [:]
                for await (id, feedback) in group where !feedback.isEmpty {
                    result[id] = feedback
                }
                return result
            }
        } catch {
            print("ProjectDetailView: Failed to load project — \(error.localizedDescription)")
        }
        isLoading = false
    }
}

// MARK: - MasterCheckCard
// Native Master Check for the latest mix — measured BS.1770-4 loudness,
// per-DSP normalization deltas, the mastering verdict, and the limiter/chain
// recommendations, mirroring the web card. Measuring streams the audio file
// through LoudnessAnalyzer on a background task (a few MB of memory whatever
// the mix length) and persists through the same API route the web writes, so
// both platforms share one measurement history.
struct MasterCheckCard: View {

    let version: Version

    @State private var measured: LoudnessMeasurement?
    @State private var measuring = false
    @State private var statusText = ""
    @State private var errorText: String?
    @State private var showRecommendations = false

    // The stored row, when this mix was measured before (on either platform).
    private var stored: LoudnessMeasurement? {
        guard version.loudnessLufs != nil || version.loudnessShortTermLufs != nil
            || version.samplePeakDb != nil else { return nil }
        return LoudnessMeasurement(
            integratedLufs: version.loudnessLufs ?? -.infinity,
            shortTermMaxLufs: version.loudnessShortTermLufs ?? -.infinity,
            samplePeakDb: version.samplePeakDb ?? -.infinity,
            gatedBlockCount: 0
        )
    }

    // This session's measurement wins over the stored row.
    private var display: LoudnessMeasurement? { measured ?? stored }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: "gauge")
                    .font(.caption)
                    .foregroundColor(Color(hex: "#2dd4bf"))
                Text("MASTER CHECK")
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .tracking(1)
                    .foregroundColor(.gray)
                Text("v\(version.versionNumber)")
                    .font(.caption2)
                    .foregroundColor(.gray)
                Spacer()
                if measuring {
                    HStack(spacing: 6) {
                        ProgressView()
                            .tint(Color(hex: "#2dd4bf"))
                            .scaleEffect(0.7)
                        Text(statusText)
                            .font(.caption2)
                            .foregroundColor(.gray)
                    }
                } else {
                    Button(display == nil ? "Measure loudness" : "Re-measure") {
                        Task { await runMeasure() }
                    }
                    .font(.caption)
                    .fontWeight(display == nil ? .semibold : .regular)
                    .foregroundColor(Color(hex: "#2dd4bf"))
                }
            }

            if let errorText {
                Text(errorText)
                    .font(.caption)
                    .foregroundColor(.red)
            }

            if let m = display {
                // Readout
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(LoudnessAnalyzer.formatLufs(m.integratedLufs))
                        .font(.headline)
                        .foregroundColor(Color(hex: "#f0f0f0"))
                    Text("integrated")
                        .font(.caption2)
                        .foregroundColor(.gray)
                }
                Text("peak \(LoudnessAnalyzer.formatDb(m.samplePeakDb)) dBFS (sample)  ·  loudest 3s \(LoudnessAnalyzer.formatLufs(m.shortTermMaxLufs))")
                    .font(.caption2)
                    .foregroundColor(.gray)

                // What each platform's normalizer will do with this master.
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 6) {
                    ForEach(LoudnessAnalyzer.dspDeltas(m)) { d in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(d.name)
                                .font(.caption2)
                                .foregroundColor(.gray)
                            Text(deltaText(d.deltaDb))
                                .font(.caption)
                                .foregroundColor(Color(hex: "#f0f0f0"))
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(Color(hex: "#161616"))
                        .cornerRadius(8)
                    }
                }

                // Verdict
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(LoudnessAnalyzer.verdict(m)) { issue in
                        HStack(alignment: .top, spacing: 6) {
                            Image(systemName: issueIcon(issue.level))
                                .font(.caption2)
                                .padding(.top, 1)
                            Text(issue.message)
                                .font(.caption)
                        }
                        .foregroundColor(issueColor(issue.level))
                    }
                }

                // Limiter & chain recommendations — collapsed by default, the
                // full text is a lot for a phone card.
                let recs = LoudnessAnalyzer.recommendations(m)
                if !recs.isEmpty {
                    Button(action: { withAnimation(.easeOut(duration: 0.15)) { showRecommendations.toggle() } }) {
                        HStack(spacing: 5) {
                            Image(systemName: "slider.horizontal.3")
                                .font(.caption2)
                            Text("Limiter & chain recommendations")
                                .font(.caption)
                                .fontWeight(.medium)
                            Image(systemName: showRecommendations ? "chevron.up" : "chevron.down")
                                .font(.system(size: 9))
                        }
                        .foregroundColor(Color(hex: "#2dd4bf"))
                    }
                    if showRecommendations {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(recs) { r in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("\(r.area). ")
                                        .font(.caption)
                                        .fontWeight(.semibold)
                                        .foregroundColor(Color(hex: "#2dd4bf"))
                                    + Text(r.advice)
                                        .font(.caption)
                                        .fontWeight(.regular)
                                        .foregroundColor(Color(hex: "#d0d0d0"))
                                    if let plugins = r.plugins {
                                        Text(plugins)
                                            .font(.caption2)
                                            .foregroundColor(.gray)
                                    }
                                }
                            }
                        }
                        .padding(10)
                        .background(Color(hex: "#161616"))
                        .cornerRadius(8)
                    }
                }
            }
        }
        .padding(12)
        .background(Color(hex: "#111111"))
        .cornerRadius(10)
    }

    private func deltaText(_ delta: Double?) -> String {
        guard let delta else { return "—" }
        if delta > 0.2 { return String(format: "−%.1f dB by normalization", delta) }
        if delta < -0.2 { return String(format: "%.1f dB under target", abs(delta)) }
        return "at target"
    }

    private func issueIcon(_ level: LoudnessIssueLevel) -> String {
        switch level {
        case .error: return "exclamationmark.circle"
        case .warning: return "exclamationmark.triangle"
        case .info: return "checkmark"
        }
    }

    private func issueColor(_ level: LoudnessIssueLevel) -> Color {
        switch level {
        case .error: return Color(red: 0.97, green: 0.44, blue: 0.44)
        case .warning: return Color(red: 0.98, green: 0.75, blue: 0.14)
        case .info: return Color(red: 0.20, green: 0.83, blue: 0.60)
        }
    }

    // Download → decode/measure off the main actor → show → persist. A failed
    // save keeps the on-screen number; re-measuring later retries the write.
    private func runMeasure() async {
        measuring = true
        errorText = nil
        statusText = "Downloading…"
        defer {
            measuring = false
            statusText = ""
        }
        do {
            guard let url = URL(string: version.audioUrl) else {
                throw LoudnessAnalyzerError.unreadable("This mix has no readable audio URL")
            }
            let (tempURL, _) = try await URLSession.shared.download(from: url)
            // AVAudioFile sniffs the container partly by extension — give the
            // temp file the real one instead of URLSession's ".tmp".
            let ext = url.pathExtension.isEmpty ? "wav" : url.pathExtension
            let dest = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString + "." + ext)
            try FileManager.default.moveItem(at: tempURL, to: dest)
            defer { try? FileManager.default.removeItem(at: dest) }

            statusText = "Measuring…"
            let m = try await Task.detached(priority: .userInitiated) {
                try LoudnessAnalyzer.measure(fileURL: dest)
            }.value
            measured = m

            statusText = "Saving…"
            try? await MixbaseAPI.shared.saveLoudness(versionId: version.id, measurement: m)
        } catch {
            errorText = error.localizedDescription
        }
    }
}
