import SwiftUI

// MARK: - Feed models (GET /api/feed — see src/lib/feed.ts)

/// One community-feed entry: a project's newest mix from any artist.
struct FeedItem: Codable, Identifiable {
    let versionId: UUID
    let projectId: UUID
    let userId: UUID
    let title: String
    let artist: String
    let versionLabel: String
    let artworkUrl: String?
    let audioUrl: String
    let createdAt: Date
    var comments: [FeedComment]
    let older: [OlderMix]

    var id: UUID { versionId }

    enum CodingKeys: String, CodingKey {
        case title, artist, comments, older
        case versionId = "version_id"
        case projectId = "project_id"
        case userId = "user_id"
        case versionLabel = "version_label"
        case artworkUrl = "artwork_url"
        case audioUrl = "audio_url"
        case createdAt = "created_at"
    }
}

struct FeedComment: Codable, Identifiable {
    let id: UUID
    let versionId: UUID
    let userId: UUID
    let artist: String
    let comment: String
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id, artist, comment
        case versionId = "version_id"
        case userId = "user_id"
        case createdAt = "created_at"
    }
}

/// An earlier mix of a feed item's project.
struct OlderMix: Codable, Identifiable {
    let versionId: UUID
    let versionLabel: String
    let audioUrl: String
    let createdAt: Date

    var id: UUID { versionId }

    enum CodingKeys: String, CodingKey {
        case versionId = "version_id"
        case versionLabel = "version_label"
        case audioUrl = "audio_url"
        case createdAt = "created_at"
    }
}

// MARK: - FeedView
// The mixBASE community feed (web /feed on iOS): recent uploads across every
// artist on the platform — listen, browse a project's older mixes, and leave
// comments for each other. Cross-user by design.

struct FeedView: View {

    @EnvironmentObject var audioService: AudioService

    @State private var items: [FeedItem] = []
    @State private var isLoading = true
    @State private var loadFailed = false

    // Comment composer state, per feed item
    @State private var expandedComments: Set<UUID> = []
    @State private var draftComment: [UUID: String] = [:]
    @State private var postingFor: UUID?
    @State private var errorMessage: String?

    // UGC moderation (App Store Guideline 1.2): report/block confirmations
    @State private var moderationMessage: String?

    var body: some View {
        ZStack {
            Color(hex: "#080808").ignoresSafeArea()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundColor(.red)
                            .padding(.horizontal)
                    }

                    if isLoading && items.isEmpty {
                        HStack { Spacer(); ProgressView().tint(Color(hex: "#2dd4bf")); Spacer() }
                            .padding(.vertical, 60)
                    } else if loadFailed && items.isEmpty {
                        VStack(spacing: 10) {
                            Text("Couldn't load the feed")
                                .font(.subheadline)
                                .foregroundColor(Color(hex: "#f0f0f0"))
                            Button("Retry") { Task { await loadFeed() } }
                                .font(.subheadline).fontWeight(.semibold)
                                .foregroundColor(Color(hex: "#2dd4bf"))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 60)
                    } else if items.isEmpty {
                        Text("Nothing in the feed yet — uploads from every artist land here.")
                            .font(.subheadline)
                            .foregroundColor(.gray)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 60)
                            .padding(.horizontal, 30)
                    } else {
                        ForEach(items) { item in
                            feedCard(item)
                        }
                    }

                    Spacer(minLength: 100)
                }
                .padding(.top, 12)
            }
            .refreshable { await loadFeed() }
        }
        .navigationTitle("mixBASE Feed")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .task { await loadFeed() }
        .alert("Thanks", isPresented: Binding(
            get: { moderationMessage != nil },
            set: { if !$0 { moderationMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(moderationMessage ?? "")
        }
    }

    // MARK: - Moderation actions (App Store Guideline 1.2)

    private func isOwnContent(_ contentUserId: UUID) -> Bool {
        contentUserId.uuidString.lowercased() == AuthService.shared.userId?.lowercased()
    }

    private func report(type: String, id: UUID) {
        Task {
            do {
                try await MixbaseAPI.shared.reportContent(type: type, id: id)
                if type == "version" {
                    items.removeAll { $0.versionId == id }
                } else {
                    for idx in items.indices { items[idx].comments.removeAll { $0.id == id } }
                }
                moderationMessage = "Report received. We review reported content within 24 hours and remove anything objectionable."
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func block(userId: UUID, artist: String) {
        Task {
            do {
                try await MixbaseAPI.shared.blockUser(id: userId)
                items.removeAll { $0.userId == userId }
                for idx in items.indices { items[idx].comments.removeAll { $0.userId == userId } }
                moderationMessage = "\(artist) is blocked. You won't see their uploads or comments anymore."
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    // MARK: - Feed Card
    @ViewBuilder
    private func feedCard(_ item: FeedItem) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                // Artwork
                if let artworkUrl = item.artworkUrl, let url = URL(string: artworkUrl) {
                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        RoundedRectangle(cornerRadius: 10).fill(Color(hex: "#1a1a1a"))
                    }
                    .frame(width: 56, height: 56)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                } else {
                    RoundedRectangle(cornerRadius: 10)
                        .fill(Color(hex: "#1a1a1a"))
                        .frame(width: 56, height: 56)
                        .overlay(Image(systemName: "music.note").foregroundColor(.gray.opacity(0.4)))
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(Color(hex: "#f0f0f0"))
                        .lineLimit(1)
                    Text(item.artist)
                        .font(.caption)
                        .foregroundColor(Color(hex: "#2dd4bf"))
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        Text(item.versionLabel)
                        Text("·")
                        Text(item.createdAt, style: .relative)
                    }
                    .font(.caption2)
                    .foregroundColor(.gray)
                }

                Spacer()

                Button(action: { play(item) }) {
                    let isThisPlaying = audioService.currentVersion?.id == item.versionId && audioService.isPlaying
                    Image(systemName: isThisPlaying ? "waveform.circle.fill" : "play.circle.fill")
                        .font(.system(size: 34))
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }
            }

            // Older mixes of this project
            if !item.older.isEmpty {
                Menu {
                    ForEach(item.older) { mix in
                        Button(action: { playOlder(mix, of: item) }) {
                            Text("\(mix.versionLabel) · \(mix.createdAt.formatted(date: .abbreviated, time: .omitted))")
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "clock.arrow.circlepath")
                        Text("Older mixes (\(item.older.count))")
                    }
                    .font(.caption2)
                    .foregroundColor(.gray)
                }
            }

            // Comments
            Button(action: { toggleComments(item.versionId) }) {
                HStack(spacing: 4) {
                    Image(systemName: "bubble.left")
                    Text(item.comments.isEmpty
                         ? "Leave a comment"
                         : "\(item.comments.count) comment\(item.comments.count == 1 ? "" : "s")")
                    Image(systemName: expandedComments.contains(item.versionId) ? "chevron.up" : "chevron.down")
                        .font(.system(size: 9))
                }
                .font(.caption)
                .foregroundColor(Color(hex: "#2dd4bf"))
            }

            if expandedComments.contains(item.versionId) {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(item.comments) { comment in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(comment.artist)
                                    .font(.caption)
                                    .fontWeight(.semibold)
                                    .foregroundColor(Color(hex: "#f0f0f0"))
                                Text(comment.createdAt, style: .relative)
                                    .font(.caption2)
                                    .foregroundColor(.gray.opacity(0.6))
                            }
                            Text(comment.comment)
                                .font(.caption)
                                .foregroundColor(.gray)
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(hex: "#161616"))
                        .cornerRadius(8)
                        // UGC moderation (Guideline 1.2): long-press a comment
                        // to report it or block its author.
                        .contextMenu {
                            if !isOwnContent(comment.userId) {
                                Button(role: .destructive) {
                                    report(type: "comment", id: comment.id)
                                } label: {
                                    Label("Report Comment", systemImage: "flag")
                                }
                                Button(role: .destructive) {
                                    block(userId: comment.userId, artist: comment.artist)
                                } label: {
                                    Label("Block \(comment.artist)", systemImage: "hand.raised")
                                }
                            }
                        }
                    }

                    // Composer
                    HStack(spacing: 8) {
                        TextField("Say something…", text: draftBinding(for: item.versionId), axis: .vertical)
                            .font(.caption)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                            .padding(8)
                            .background(Color(hex: "#161616"))
                            .cornerRadius(8)
                            .lineLimit(1...4)

                        Button(action: { Task { await postComment(on: item) } }) {
                            if postingFor == item.versionId {
                                ProgressView().tint(Color(hex: "#2dd4bf"))
                            } else {
                                Image(systemName: "paperplane.fill")
                                    .font(.body)
                                    .foregroundColor(
                                        (draftComment[item.versionId] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                            ? .gray.opacity(0.4)
                                            : Color(hex: "#2dd4bf")
                                    )
                            }
                        }
                        .disabled(postingFor == item.versionId
                                  || (draftComment[item.versionId] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
        .padding(14)
        .background(Color(hex: "#111111"))
        .cornerRadius(14)
        .padding(.horizontal)
        // UGC moderation (Guideline 1.2): every cross-user feed entry can be
        // reported, and its uploader blocked. Long-press the card.
        .contextMenu {
            if !isOwnContent(item.userId) {
                Button(role: .destructive) {
                    report(type: "version", id: item.versionId)
                } label: {
                    Label("Report Track", systemImage: "flag")
                }
                Button(role: .destructive) {
                    block(userId: item.userId, artist: item.artist)
                } label: {
                    Label("Block \(item.artist)", systemImage: "hand.raised")
                }
            }
        }
    }

    // MARK: - Actions

    private func draftBinding(for id: UUID) -> Binding<String> {
        Binding(
            get: { draftComment[id] ?? "" },
            set: { draftComment[id] = $0 }
        )
    }

    private func toggleComments(_ id: UUID) {
        if expandedComments.contains(id) {
            expandedComments.remove(id)
        } else {
            expandedComments.insert(id)
        }
    }

    private func loadFeed() async {
        isLoading = true
        do {
            items = try await MixbaseAPI.shared.fetchFeed()
            loadFailed = false
        } catch {
            loadFailed = true
            print("FeedView: load failed — \(error.localizedDescription)")
        }
        isLoading = false
    }

    // Play a feed track through the shared audio engine. Feed entries are other
    // artists' versions, so we build a lightweight Version for the player.
    private func play(_ item: FeedItem) {
        let version = Version(
            id: item.versionId,
            projectId: item.projectId,
            versionNumber: 0,
            label: item.versionLabel,
            audioUrl: item.audioUrl,
            audioFilename: nil,
            durationSeconds: nil,
            fileSizeBytes: nil,
            status: "Mix",
            privateNotes: nil,
            publicNotes: nil,
            changeLog: nil,
            shareToken: nil,
            allowDownload: false,
            createdAt: item.createdAt
        )
        audioService.play(version: version, trackName: "\(item.title) — \(item.artist)", artworkUrl: item.artworkUrl)
    }

    private func playOlder(_ mix: OlderMix, of item: FeedItem) {
        let version = Version(
            id: mix.versionId,
            projectId: item.projectId,
            versionNumber: 0,
            label: mix.versionLabel,
            audioUrl: mix.audioUrl,
            audioFilename: nil,
            durationSeconds: nil,
            fileSizeBytes: nil,
            status: "Mix",
            privateNotes: nil,
            publicNotes: nil,
            changeLog: nil,
            shareToken: nil,
            allowDownload: false,
            createdAt: mix.createdAt
        )
        audioService.play(version: version, trackName: "\(item.title) — \(item.artist)", artworkUrl: item.artworkUrl)
    }

    private func postComment(on item: FeedItem) async {
        let text = (draftComment[item.versionId] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        postingFor = item.versionId
        errorMessage = nil
        do {
            let created = try await MixbaseAPI.shared.postFeedComment(versionId: item.versionId, comment: text)
            if let index = items.firstIndex(where: { $0.versionId == item.versionId }) {
                items[index].comments.append(created)
            }
            draftComment[item.versionId] = ""
        } catch {
            errorMessage = error.localizedDescription
        }
        postingFor = nil
    }
}
