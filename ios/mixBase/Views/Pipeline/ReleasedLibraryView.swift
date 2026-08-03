import SwiftUI

// MARK: - LibraryTrack
// One released track (mb_library_tracks row + optional project join) — the
// artist's already-out discography: ISRC, UPC, dates, and a link to the
// mixBASE project holding the original audio file.

struct LibraryTrack: Codable, Identifiable {

    let id: UUID
    var title: String
    var artistName: String?
    var isrc: String?
    var upc: String?
    var releaseTitle: String?
    var releaseDate: String?     // "yyyy-MM-dd" from the date column
    var releaseType: String?
    var source: String?          // "spotify" | "deezer"
    var sourceUrl: String?
    var projectId: UUID?
    var project: ProjectRef?

    struct ProjectRef: Codable {
        let title: String
    }

    enum CodingKeys: String, CodingKey {
        case id, title, isrc, upc, source
        case artistName = "artist_name"
        case releaseTitle = "release_title"
        case releaseDate = "release_date"
        case releaseType = "release_type"
        case sourceUrl = "source_url"
        case projectId = "project_id"
        case project = "mb_projects"
    }
}

// MARK: - ReleasedLibraryView
// iOS version of the web /library page: sync the released catalog from
// Spotify/Deezer, browse every drop with its ISRC/UPC/date, copy codes for
// DistroKid, fill missing ISRCs from MusicBrainz, link each track to the
// project that holds its original file — and play that original right here.

struct ReleasedLibraryView: View {

    @EnvironmentObject var audioService: AudioService

    @State private var tracks: [LibraryTrack] = []
    @State private var projects: [Project] = []
    @State private var isLoading = true

    // Sync bar
    @State private var artistQuery = ""
    @State private var isSyncing = false
    @State private var syncMessage: String?
    @State private var syncError: String?

    // Row actions
    @State private var copiedKey: String?
    @State private var findingId: UUID?
    @State private var playingTrackId: UUID?
    @State private var actionError: String?

    private var missingIsrcCount: Int { tracks.filter { $0.isrc == nil }.count }

    var body: some View {
        ZStack {
            Color(hex: "#080808").ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // MARK: Sync bar
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            TextField("Artist name or Spotify artist link", text: $artistQuery)
                                .font(.subheadline)
                                .foregroundColor(Color(hex: "#f0f0f0"))
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                                .padding(10)
                                .background(Color(hex: "#161616"))
                                .cornerRadius(10)

                            Button(action: sync) {
                                HStack(spacing: 5) {
                                    if isSyncing {
                                        ProgressView().tint(Color(hex: "#080808"))
                                    } else {
                                        Image(systemName: "arrow.triangle.2.circlepath")
                                    }
                                    Text(isSyncing ? "Syncing…" : "Sync")
                                }
                                .font(.subheadline)
                                .fontWeight(.semibold)
                                .foregroundColor(Color(hex: "#080808"))
                                .padding(.horizontal, 14)
                                .padding(.vertical, 10)
                                .background(
                                    isSyncing || artistQuery.trimmingCharacters(in: .whitespaces).isEmpty
                                        ? Color.gray.opacity(0.4)
                                        : Color(hex: "#2dd4bf")
                                )
                                .cornerRadius(10)
                            }
                            .disabled(isSyncing || artistQuery.trimmingCharacters(in: .whitespaces).isEmpty)
                        }

                        Text("Pulls your released songs from Spotify (or Deezer) — re-run it any time a new drop goes live.")
                            .font(.caption2)
                            .foregroundColor(.gray)

                        if let syncMessage {
                            Text(syncMessage)
                                .font(.caption)
                                .foregroundColor(Color(hex: "#2dd4bf"))
                        }
                        if let syncError {
                            Text(syncError)
                                .font(.caption)
                                .foregroundColor(.red)
                        }
                    }
                    .padding(14)
                    .background(Color(hex: "#111111"))
                    .cornerRadius(14)
                    .padding(.horizontal)

                    if let actionError {
                        Text(actionError)
                            .font(.caption)
                            .foregroundColor(.red)
                            .padding(.horizontal)
                    }

                    // MARK: Library list
                    if isLoading && tracks.isEmpty {
                        HStack { Spacer(); ProgressView().tint(Color(hex: "#2dd4bf")); Spacer() }
                            .padding(.vertical, 40)
                    } else if tracks.isEmpty {
                        VStack(spacing: 10) {
                            Image(systemName: "music.note.list")
                                .font(.system(size: 40))
                                .foregroundColor(.gray.opacity(0.3))
                            Text("No released tracks yet — sync your catalog above to fill the library.")
                                .font(.subheadline)
                                .foregroundColor(.gray)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 50)
                        .padding(.horizontal, 30)
                    } else {
                        HStack {
                            Text("\(tracks.count) RELEASED TRACK\(tracks.count == 1 ? "" : "S")")
                                .font(.caption2)
                                .fontWeight(.semibold)
                                .foregroundColor(.gray)
                            Spacer()
                            if missingIsrcCount > 0 {
                                Text("\(missingIsrcCount) missing ISRC")
                                    .font(.caption2)
                                    .foregroundColor(.yellow)
                            }
                        }
                        .padding(.horizontal)

                        ForEach(tracks) { track in
                            trackRow(track)
                        }
                    }

                    Spacer(minLength: 100)
                }
                .padding(.top, 12)
            }
            .refreshable { await loadLibrary() }
        }
        .navigationTitle("Released Library")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .task {
            await loadLibrary()
            await prefillArtist()
        }
    }

    // MARK: - Track Row
    @ViewBuilder
    private func trackRow(_ track: LibraryTrack) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            // Title line (+ open on Spotify/Deezer)
            HStack(spacing: 6) {
                Text(track.title)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .lineLimit(1)

                if let sourceUrl = track.sourceUrl, let url = URL(string: sourceUrl) {
                    Link(destination: url) {
                        Image(systemName: "arrow.up.right.square")
                            .font(.caption2)
                            .foregroundColor(.gray)
                    }
                }

                Spacer()

                // Play the original file from the linked project
                if track.projectId != nil {
                    Button(action: { Task { await playOriginal(track) } }) {
                        if playingTrackId == track.id {
                            ProgressView().tint(Color(hex: "#2dd4bf"))
                        } else {
                            Image(systemName: "play.circle.fill")
                                .font(.title3)
                                .foregroundColor(Color(hex: "#2dd4bf"))
                        }
                    }
                }

                Button(action: { Task { await deleteTrack(track) } }) {
                    Image(systemName: "trash")
                        .font(.caption)
                        .foregroundColor(.gray)
                }
            }

            // Release details line
            HStack(spacing: 8) {
                if let releaseTitle = track.releaseTitle, releaseTitle != track.title {
                    Text(releaseTitle).lineLimit(1)
                }
                if let date = track.releaseDate {
                    Text(formatDate(date))
                }
                if let type = track.releaseType {
                    Text(type.uppercased())
                        .font(.system(size: 9, weight: .semibold))
                }
            }
            .font(.caption2)
            .foregroundColor(.gray)

            // Codes + project link
            HStack(spacing: 8) {
                // ISRC — the DistroKid reuse code
                if let isrc = track.isrc {
                    codeChip(key: "\(track.id)-isrc", label: isrc)
                } else {
                    Button(action: { Task { await findIsrc(track) } }) {
                        HStack(spacing: 4) {
                            if findingId == track.id {
                                ProgressView().tint(.yellow).scaleEffect(0.7)
                            } else {
                                Image(systemName: "magnifyingglass")
                            }
                            Text(findingId == track.id ? "Searching…" : "Find ISRC")
                        }
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .foregroundColor(.yellow)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Color.yellow.opacity(0.12))
                        .clipShape(Capsule())
                    }
                    .disabled(findingId == track.id)
                }

                if let upc = track.upc {
                    codeChip(key: "\(track.id)-upc", label: "UPC \(upc)", copyValue: upc)
                }

                Spacer()

                // Link the project holding this track's original file
                if track.projectId == nil && !projects.isEmpty {
                    Menu {
                        ForEach(projects) { project in
                            Button(project.title) {
                                Task { await linkProject(track, projectId: project.id) }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "link")
                            Text("Link project")
                        }
                        .font(.caption2)
                        .foregroundColor(Color(hex: "#2dd4bf"))
                    }
                } else if let projectTitle = track.project?.title {
                    Text(projectTitle)
                        .font(.caption2)
                        .foregroundColor(Color(hex: "#2dd4bf"))
                        .lineLimit(1)
                }
            }
        }
        .padding(14)
        .background(Color(hex: "#111111"))
        .cornerRadius(12)
        .padding(.horizontal)
    }

    // Tap-to-copy chip with a brief checkmark confirmation
    @ViewBuilder
    private func codeChip(key: String, label: String, copyValue: String? = nil) -> some View {
        Button(action: {
            UIPasteboard.general.string = copyValue ?? label
            copiedKey = key
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                if copiedKey == key { copiedKey = nil }
            }
        }) {
            HStack(spacing: 4) {
                Text(label)
                    .font(.system(size: 10, design: .monospaced))
                Image(systemName: copiedKey == key ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 8))
                    .foregroundColor(copiedKey == key ? Color(hex: "#2dd4bf") : .gray)
            }
            .foregroundColor(Color(hex: "#f0f0f0").opacity(0.8))
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .overlay(Capsule().stroke(Color(hex: "#333333"), lineWidth: 1))
        }
    }

    // MARK: - Helpers

    // "yyyy-MM-dd" → "Aug 27, 2026"
    private func formatDate(_ raw: String) -> String {
        let parser = DateFormatter()
        parser.dateFormat = "yyyy-MM-dd"
        parser.locale = Locale(identifier: "en_US_POSIX")
        guard let date = parser.date(from: raw) else { return raw }
        return date.formatted(date: .abbreviated, time: .omitted)
    }

    private func flashError(_ message: String) {
        actionError = message
        Task {
            try? await Task.sleep(for: .seconds(4))
            if actionError == message { actionError = nil }
        }
    }

    // MARK: - Actions

    private func loadLibrary() async {
        isLoading = true
        do {
            async let fetchedTracks = MixbaseAPI.shared.fetchLibraryTracks()
            async let fetchedProjects = SupabaseService.shared.fetchProjects()
            tracks = try await fetchedTracks
            projects = try await fetchedProjects
        } catch {
            flashError(error.localizedDescription)
        }
        isLoading = false
    }

    // Pre-fill the sync field with the artist name from the profile
    private func prefillArtist() async {
        guard artistQuery.isEmpty, let userId = AuthService.shared.userId else { return }
        let name = await SupabaseService.shared.fetchArtistName(userId: userId)
        if artistQuery.isEmpty && !name.isEmpty { artistQuery = name }
    }

    private func sync() {
        isSyncing = true
        syncMessage = nil
        syncError = nil
        Task {
            do {
                syncMessage = try await MixbaseAPI.shared.syncLibrary(
                    artist: artistQuery.trimmingCharacters(in: .whitespaces))
                tracks = (try? await MixbaseAPI.shared.fetchLibraryTracks()) ?? tracks
            } catch {
                syncError = error.localizedDescription
            }
            isSyncing = false
        }
    }

    private func findIsrc(_ track: LibraryTrack) async {
        findingId = track.id
        do {
            switch try await MixbaseAPI.shared.findIsrc(trackId: track.id) {
            case .found(let updated):
                tracks = tracks.map { $0.id == updated.id ? updated : $0 }
            case .notFound(let message):
                flashError(message)
            }
        } catch {
            flashError(error.localizedDescription)
        }
        findingId = nil
    }

    private func linkProject(_ track: LibraryTrack, projectId: UUID) async {
        do {
            let updated = try await MixbaseAPI.shared.linkLibraryTrack(id: track.id, projectId: projectId)
            tracks = tracks.map { $0.id == updated.id ? updated : $0 }
        } catch {
            flashError("Could not link the project — please try again.")
        }
    }

    private func deleteTrack(_ track: LibraryTrack) async {
        do {
            try await MixbaseAPI.shared.deleteLibraryTrack(id: track.id)
            tracks.removeAll { $0.id == track.id }
        } catch {
            flashError("Could not remove the track — please try again.")
        }
    }

    // The "original file": the linked project's most polished version —
    // Released > Finished > highest version number (same rule as the web).
    private func playOriginal(_ track: LibraryTrack) async {
        guard let projectId = track.projectId else { return }
        playingTrackId = track.id
        do {
            async let fetchedProject = SupabaseService.shared.fetchProject(id: projectId)
            async let fetchedVersions = SupabaseService.shared.fetchVersions(projectId: projectId)
            let project = try await fetchedProject
            let versions = (try await fetchedVersions).sorted { $0.versionNumber > $1.versionNumber }
            let best = versions.first(where: { $0.status == "Released" })
                ?? versions.first(where: { $0.status == "Finished" })
                ?? versions.first
            if let best {
                audioService.play(version: best, trackName: project.title, artworkUrl: project.artworkUrl, visualizerUrl: project.visualizerUrl)
            } else {
                flashError("The linked project has no audio versions yet.")
            }
        } catch {
            flashError(error.localizedDescription)
        }
        playingTrackId = nil
    }
}
