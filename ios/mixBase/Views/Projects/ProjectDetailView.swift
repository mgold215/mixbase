import SwiftUI

// MARK: - ProjectDetailView
// Shows full details for a single project: artwork, metadata, versions list,
// and buttons to generate artwork, upload versions, or share.

struct ProjectDetailView: View {

    // The project ID passed in from the grid
    let projectId: UUID

    // Access the shared audio service to play versions
    @EnvironmentObject var audioService: AudioService

    // Project and its versions fetched from Supabase
    @State private var project: Project?
    @State private var versions: [Version] = []
    @State private var isLoading = true

    // Navigation to the artwork generator
    @State private var showArtworkGenerator = false

    var body: some View {
        ZStack {
            // Dark background
            Color(hex: "#080808")
                .ignoresSafeArea()

            if isLoading {
                ProgressView()
                    .tint(Color(hex: "#2dd4bf"))
            } else if let project = project {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // MARK: - Large Artwork
                        artworkSection(project: project)

                        // MARK: - Project Info
                        VStack(alignment: .leading, spacing: 8) {
                            Text(project.title)
                                .font(.title)
                                .fontWeight(.bold)
                                .foregroundColor(Color(hex: "#f0f0f0"))

                            // Genre, BPM, Key on one line
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
                        .padding(.horizontal)

                        // MARK: - Generate Artwork Button
                        NavigationLink(destination: ArtworkGeneratorView(projectId: projectId)) {
                            HStack {
                                Image(systemName: "paintbrush")
                                Text("Generate Artwork")
                            }
                            .font(.subheadline)
                            .fontWeight(.medium)
                            .foregroundColor(Color(hex: "#080808"))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color(hex: "#2dd4bf"))
                            .cornerRadius(10)
                        }
                        .padding(.horizontal)

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
                                // List of versions
                                ForEach(versions.sorted(by: { $0.versionNumber > $1.versionNumber })) { version in
                                    versionRow(version: version)
                                }
                            }
                        }

                        // MARK: - Upload Version Button
                        Button(action: {
                            // Upload functionality will be added later
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

                        Spacer(minLength: 80) // Space for mini player
                    }
                    .padding(.top, 16)
                }
            } else {
                // Project not found
                Text("Project not found")
                    .foregroundColor(.gray)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        // Fetch project data when the view first appears
        .task {
            await loadProjectData()
        }
    }

    // MARK: - Artwork Section
    // Large artwork image at the top with rounded corners
    @ViewBuilder
    private func artworkSection(project: Project) -> some View {
        if let artworkUrl = project.artworkUrl, let url = URL(string: artworkUrl) {
            AsyncImage(url: url) { image in
                image
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } placeholder: {
                RoundedRectangle(cornerRadius: 16)
                    .fill(Color(hex: "#1a1a1a"))
                    .overlay(
                        Image(systemName: "music.note")
                            .font(.system(size: 48))
                            .foregroundColor(.gray.opacity(0.3))
                    )
            }
            .frame(maxWidth: .infinity)
            .frame(height: 280)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .padding(.horizontal)
        } else {
            // Placeholder when there's no artwork
            RoundedRectangle(cornerRadius: 16)
                .fill(Color(hex: "#1a1a1a"))
                .frame(height: 280)
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
                .padding(.horizontal)
        }
    }

    // MARK: - Metadata Tag
    // A small icon + text pair for genre, BPM, key
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
    // A single version entry in the list, showing number, label, status, date, duration
    @ViewBuilder
    private func versionRow(version: Version) -> some View {
        Button(action: {
            // Play this version when tapped
            audioService.play(
                version: version,
                trackName: project?.title ?? "Unknown",
                artworkUrl: project?.artworkUrl
            )
        }) {
            HStack(spacing: 12) {
                // Version number in a circle
                Text("v\(version.versionNumber)")
                    .font(.caption)
                    .fontWeight(.bold)
                    .foregroundColor(Color(hex: "#2dd4bf"))
                    .frame(width: 36, height: 36)
                    .background(Color(hex: "#2dd4bf").opacity(0.15))
                    .clipShape(Circle())

                // Label and date
                VStack(alignment: .leading, spacing: 3) {
                    Text(version.label ?? "Version \(version.versionNumber)")
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundColor(Color(hex: "#f0f0f0"))

                    HStack(spacing: 6) {
                        // Date
                        Text(version.createdAt, style: .date)
                            .font(.caption2)
                            .foregroundColor(.gray)

                        // Duration (if available)
                        if let seconds = version.durationSeconds {
                            Text(formatDuration(seconds))
                                .font(.caption2)
                                .foregroundColor(.gray)
                        }
                    }
                }

                Spacer()

                // Status badge
                StatusBadge(status: version.status)

                // Share button — copies the share link to clipboard
                Button(action: {
                    shareVersion(version)
                }) {
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

    // Format seconds into "M:SS" string (e.g. 183 -> "3:03")
    private func formatDuration(_ totalSeconds: Int) -> String {
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return String(format: "%d:%02d", minutes, seconds)
    }

    // Copy a shareable link to the clipboard
    private func shareVersion(_ version: Version) {
        if let token = version.shareToken {
            let shareUrl = "https://mixbase-production.up.railway.app/share/\(token)"
            UIPasteboard.general.string = shareUrl
        }
    }

    // MARK: - Data Loading
    private func loadProjectData() async {
        isLoading = true
        do {
            // Fetch the project and its versions from Supabase
            project = try await SupabaseService.shared.fetchProject(id: projectId)
            versions = try await SupabaseService.shared.fetchVersions(projectId: projectId)
        } catch {
            print("ProjectDetailView: Failed to load project — \(error.localizedDescription)")
        }
        isLoading = false
    }
}
