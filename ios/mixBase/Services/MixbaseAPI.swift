import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// MARK: - MixbaseAPI
// Client for the web app's authenticated API routes (mixbase.app). These run
// the server-side work the app can't do on device — AI artwork via Replicate,
// the free visualizer renderer, finished YouTube/Shorts renders, and the
// owner-only tools (Cassette Studio, moving covers, AI video via Runway) —
// with every allowance enforced where the keys live. There are NO paid plans
// anywhere (decision 2026-09-12): everyone gets the same free allowance, and
// the owner-only tools are gated server-side by identity, not by a purchase.
// The middleware accepts `Authorization: Bearer <supabase access token>`,
// which is exactly how this client authenticates.

final class MixbaseAPI {

    static let shared = MixbaseAPI()

    private let baseURL = Config.apiBaseURL

    // Generation routes block while the server polls the AI provider — artwork
    // up to 2 min, Runway video up to 5 min — so the session must allow far
    // more than URLSession's default 60s per-request timeout.
    private let session: URLSession

    private let decoder: JSONDecoder

    private init() {
        let config = URLSessionConfiguration.default
        // AI video (/api/visualizer/runway) sends nothing until it finishes and
        // can take ~8 min worst case; the request timeout is an IDLE timeout.
        config.timeoutIntervalForRequest = 10 * 60
        config.timeoutIntervalForResource = 12 * 60
        self.session = URLSession(configuration: config)

        // Same tolerant date handling as SupabaseService: ISO 8601 with and
        // without fractional seconds (Next.js/PostgREST emit both).
        let isoFractional = ISO8601DateFormatter()
        isoFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let isoPlain = ISO8601DateFormatter()
        isoPlain.formatOptions = [.withInternetDateTime]

        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let dateString = try container.decode(String.self)
            if let date = isoFractional.date(from: dateString) { return date }
            if let date = isoPlain.date(from: dateString) { return date }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Cannot decode date: \(dateString)"
            )
        }
    }

    // MARK: - Image models
    // Mirrors IMAGE_MODELS in src/lib/artwork-models.ts — ids must match the
    // server registry. First entry is the default.
    struct ImageModel: Identifiable {
        let id: String
        let label: String
    }

    static let imageModels: [ImageModel] = [
        ImageModel(id: "flux-ultra", label: "FLUX Ultra Raw"),
        ImageModel(id: "nano-pro",   label: "Nano Banana Pro"),
        ImageModel(id: "flux-krea",  label: "FLUX Krea"),
        ImageModel(id: "seedream",   label: "Seedream 4"),
        ImageModel(id: "flux",       label: "Flux 2 Pro"),
        ImageModel(id: "nano",       label: "Nano Banana 2"),
    ]

    // MARK: - Artwork

    /// Generate AI artwork for a project. The server generates the image,
    /// uploads it to storage AND applies it as the project's artwork.
    /// Returns the public URL of the applied artwork.
    func generateArtwork(projectId: UUID, prompt: String, model: String, vary: Bool) async throws -> String {
        let body: [String: Any] = [
            "project_id": projectId.uuidString.lowercased(),
            "prompt": prompt,
            "model": model,
            "vary": vary,
        ]
        let json = try await requestJSON(path: "/api/generate-artwork", method: "POST", body: body)
        guard let url = json["artwork_url"] as? String else {
            throw MixbaseAPIError.invalidResponse("No artwork URL in response")
        }
        return url
    }

    // MARK: - Visualizers
    // The free generator (no AI) and finished YouTube/Shorts renders are open
    // to every account. AI video (Runway) and moving covers are owner-only:
    // the server refuses them for anyone else, and the app only shows them
    // when AuthService.ownerTools is true. Nothing here is ever sold — there
    // are no paid plans (2026-09-12), and if that ever changes it will be
    // Apple In-App Purchase only.

    /// One effect the free generator offers — the web generator's own list.
    struct FreeEffectOption: Decodable, Identifiable, Equatable {
        let id: String
        let label: String
        let description: String
        let beatSynced: Bool
    }

    /// The effects the server-side free generator renders. The server runs the
    /// web generator's own effect engine, so this is the web's list; fetched so
    /// effects added on the web show up here without an app update.
    func fetchFreeVisualizerEffects() async throws -> [FreeEffectOption] {
        struct Options: Decodable { let effects: [FreeEffectOption] }
        let data = try await requestData(path: "/api/visualizer/free", method: "GET")
        return try decoder.decode(Options.self, from: data).effects
    }

    /// Server-rendered free visualizer (the web's effect engine, drawn on the
    /// backend — no AI). Seconds for the 6s formats, up to ~1 min for
    /// YouTube. Returns the stored mf-video URL (always persisted to the library).
    func generateFreeVisualizer(
        projectId: UUID,
        imageUrl: String,
        format: String,
        effect: String,
        bpm: Int?
    ) async throws -> String {
        var body: [String: Any] = [
            "projectId": projectId.uuidString.lowercased(),
            "imageUrl": imageUrl,
            "format": format,
            "effect": effect,
        ]
        if let bpm { body["bpm"] = bpm }
        let json = try await requestJSON(path: "/api/visualizer/free", method: "POST", body: body)
        guard let url = json["video_url"] as? String else {
            throw MixbaseAPIError.invalidResponse("No video URL in response")
        }
        return url
    }

    /// Every saved visualizer the user owns, newest first.
    func fetchVisualizers() async throws -> [Visualizer] {
        let data = try await requestData(path: "/api/visualizer", method: "GET")
        return try decoder.decode([Visualizer].self, from: data)
    }

    /// Delete a saved visualizer (also un-pins it from any project server-side).
    func deleteVisualizer(id: UUID) async throws {
        _ = try await requestData(path: "/api/visualizer/\(id.uuidString.lowercased())", method: "DELETE")
    }

    /// Pin (or clear, with nil) a video as a project's visualizer. The server
    /// verifies the URL is a visualizer the user actually owns.
    ///
    /// `wide` picks the slot: landscape output (a 16:9 YouTube render, or an
    /// AI ratio wider than tall) goes in `visualizer_wide_url`, everything
    /// else in `visualizer_url` — the same convention every client follows,
    /// so finished YouTube renders pick the horizontal loop and Shorts the
    /// vertical one.
    func pinVisualizer(projectId: UUID, videoUrl: String?, wide: Bool = false) async throws {
        let key = wide ? "visualizer_wide_url" : "visualizer_url"
        let body: [String: Any] = [key: videoUrl ?? NSNull()]
        _ = try await requestJSON(path: "/api/projects/\(projectId.uuidString.lowercased())", method: "PATCH", body: body)
    }

    // MARK: - AI video (owner-only; Runway image-to-video)

    struct AIVideoRatio: Decodable, Hashable {
        let value: String
        let label: String

        /// "1280:720" → true. Landscape output pins to the wide slot.
        var isLandscape: Bool {
            let parts = value.split(separator: ":")
            guard parts.count == 2,
                  let w = Double(parts[0]),
                  let h = Double(parts[1]) else { return false }
            return w > h
        }
    }

    struct AIVideoModel: Decodable, Identifiable, Equatable {
        let id: String
        let label: String
        let durations: [Int]
        let ratios: [AIVideoRatio]
    }

    struct AIVideoResult {
        let videoUrl: String
        /// false → the server could not persist the clip; `videoUrl` is the
        /// provider's temporary link (expires within hours) and can't be pinned.
        let saved: Bool
        let visualizerId: String?
    }

    /// Models + their valid durations/ratios, from the server's registry.
    func fetchAIVideoModels() async throws -> [AIVideoModel] {
        struct Options: Decodable { let models: [AIVideoModel] }
        let data = try await requestData(path: "/api/visualizer/runway", method: "GET")
        return try decoder.decode(Options.self, from: data).models
    }

    /// Generate an AI video loop from an artwork image. Blocks while the
    /// server polls the provider — up to ~5 minutes.
    func generateAIVideo(
        projectId: UUID,
        imageUrl: String,
        model: String,
        duration: Int,
        ratio: String,
        promptText: String?
    ) async throws -> AIVideoResult {
        var body: [String: Any] = [
            "imageUrl": imageUrl,
            "projectId": projectId.uuidString.lowercased(),
            "model": model,
            "duration": duration,
            "ratio": ratio,
        ]
        if let promptText {
            let trimmed = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { body["promptText"] = String(trimmed.prefix(1000)) }
        }
        let json = try await requestJSON(path: "/api/visualizer/runway", method: "POST", body: body)
        guard let url = json["videoUrl"] as? String, !url.isEmpty else {
            throw MixbaseAPIError.invalidResponse("No video URL in response")
        }
        return AIVideoResult(
            videoUrl: url,
            saved: (json["saved"] as? Bool) == true,
            visualizerId: json["visualizerId"] as? String
        )
    }

    // MARK: - Finished videos (every account — no AI, no allowance)

    /// One /api/finalize-video job, as POST (202) and GET ?job= return it.
    struct FinishedVideoJob: Decodable {
        let jobId: String
        let status: String          // rendering | uploading | done | error
        let progress: Double?       // 0–100
        let stage: String?
        let format: String?
        let videoUrl: String?
        let error: String?

        enum CodingKeys: String, CodingKey {
            case jobId = "job_id"
            case status
            case progress
            case stage
            case format
            case videoUrl = "video_url"
            case error
        }
    }

    /// The newest saved finished render per format for one project.
    struct LatestFinishedVideos: Decodable {
        let youtube: Visualizer?
        let shorts: Visualizer?
    }

    /// What POST /api/finalize-video answered.
    enum FinishedVideoStart {
        /// 202: a new render started for exactly what was asked.
        case started(FinishedVideoJob)
        /// 409: a render is already running for this ACCOUNT. The server's
        /// single-flight is per account, not per project or format, so the
        /// running job may be a different song or format entirely. jobId is
        /// that render's id; the caller re-attaches only to a job it knows is
        /// this project's own, and otherwise shows `message`.
        case alreadyRunning(jobId: String?, message: String)
    }

    /// Start a finished render. format is "youtube" or "shorts"; clipSeconds
    /// (15/30/60) and startMode ("start"/"hook"/"middle") only apply to
    /// Shorts. showText false renders no title cards at all. A 409 (a render
    /// already running for this account) comes back as .alreadyRunning —
    /// never as a job, since it may not be this request.
    func startFinishedVideo(
        projectId: UUID,
        format: String,
        color: String?,
        showText: Bool = true,
        clipSeconds: Int?,
        startMode: String?
    ) async throws -> FinishedVideoStart {
        var body: [String: Any] = [
            "project_id": projectId.uuidString.lowercased(),
            "format": format,
            "show_text": showText,
        ]
        if let color { body["color"] = color }
        if format == "shorts" {
            if let clipSeconds { body["clip_seconds"] = clipSeconds }
            if let startMode { body["start_mode"] = startMode }
        }
        let payload = try JSONSerialization.data(withJSONObject: body)
        let (status, data) = try await send(
            path: "/api/finalize-video",
            method: "POST",
            contentType: "application/json",
            body: payload
        )
        if status == 409 {
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let jobId = (json?["job_id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let message = scrubbedError(statusCode: status, data: data).errorDescription
                ?? "A render is already running — wait for it to finish"
            return .alreadyRunning(jobId: jobId, message: message)
        }
        guard (200...299).contains(status) else {
            throw scrubbedError(statusCode: status, data: data)
        }
        return .started(try decoder.decode(FinishedVideoJob.self, from: data))
    }

    /// Poll a render job. nil = the server no longer knows the job (404): a
    /// deploy or another replica interrupted it — stop polling.
    func pollFinishedVideo(jobId: String) async throws -> FinishedVideoJob? {
        let encoded = jobId.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? jobId
        let (status, data) = try await send(
            path: "/api/finalize-video?job=\(encoded)",
            method: "GET",
            contentType: nil,
            body: nil
        )
        if status == 404 { return nil }
        guard (200...299).contains(status) else {
            throw scrubbedError(statusCode: status, data: data)
        }
        return try decoder.decode(FinishedVideoJob.self, from: data)
    }

    /// Latest saved YouTube + Shorts renders for a project (either may be nil).
    func latestFinishedVideos(projectId: UUID) async throws -> LatestFinishedVideos {
        let data = try await requestData(
            path: "/api/finalize-video?project_id=\(projectId.uuidString.lowercased())",
            method: "GET"
        )
        return try decoder.decode(LatestFinishedVideos.self, from: data)
    }

    // MARK: - Cassette Studio (owner-only)
    // The artist's real cassette photo, cut out once and dropped into a new
    // scene, lettered in their own handwriting. Every route 404s for anyone
    // but the owner; the app only shows the screen when ownerTools is true.

    /// A saved cut-out cassette or handwriting image (studio/<userId>/…).
    struct StudioFile: Decodable, Identifiable, Equatable {
        let path: String
        let url: String
        let createdAt: String?

        var id: String { path }
    }

    struct StudioLibrary: Decodable {
        let subjects: [StudioFile]
        let lettering: [StudioFile]
    }

    struct CassetteRenderResult: Decodable {
        let artworkUrl: String
        let finalizedArtworkUrl: String?
        let scene: String?
        let sceneLabel: String?
        let promptUsed: String?
        let color: String?

        enum CodingKeys: String, CodingKey {
            case artworkUrl = "artwork_url"
            case finalizedArtworkUrl = "finalized_artwork_url"
            case scene
            case sceneLabel = "scene_label"
            case promptUsed = "prompt_used"
            case color
        }
    }

    /// The user's saved cassettes, plus this project's handwriting, newest first.
    func listStudio(projectId: UUID) async throws -> StudioLibrary {
        let data = try await requestData(
            path: "/api/cassette-studio?project_id=\(projectId.uuidString.lowercased())",
            method: "GET"
        )
        return try decoder.decode(StudioLibrary.self, from: data)
    }

    /// Remove one saved cassette or handwriting image.
    func deleteStudioFile(path: String) async throws {
        let encoded = path.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? path
        _ = try await requestData(path: "/api/cassette-studio?path=\(encoded)", method: "DELETE")
    }

    /// Cut a cassette out of a photo (any format the device can decode — it
    /// is re-encoded here as a ≤2400px JPEG, never uploaded raw).
    func uploadSubject(imageData: Data) async throws -> StudioFile {
        struct Response: Decodable { let subject: StudioFile }
        let jpeg = try Self.uploadableJPEG(imageData, maxEdge: 2400)
        let data = try await requestMultipart(
            path: "/api/cassette-studio/subject",
            fields: [],
            files: [MultipartFile(name: "photo", filename: "cassette.jpg", data: jpeg)]
        )
        return try decoder.decode(Response.self, from: data).subject
    }

    /// Lift the artist's handwriting off a photo as this project's lettering.
    func uploadLettering(projectId: UUID, imageData: Data) async throws -> StudioFile {
        struct Response: Decodable { let lettering: StudioFile }
        let jpeg = try Self.uploadableJPEG(imageData, maxEdge: 2400)
        let data = try await requestMultipart(
            path: "/api/cassette-studio/lettering",
            fields: [MultipartField(name: "project_id", value: projectId.uuidString.lowercased())],
            files: [MultipartFile(name: "photo", filename: "lettering.jpg", data: jpeg)]
        )
        return try decoder.decode(Response.self, from: data).lettering
    }

    /// Build a cover. scene is a preset id, "random", "custom" (with
    /// `setting`), "photo" (with `background` image data) or "keep" (re-letter
    /// the current cover). The server applies the result to the project.
    func renderCassette(
        projectId: UUID,
        scene: String,
        subject: String?,
        setting: String?,
        background: Data?,
        lettering: String?,
        color: String,
        position: String,
        size: String,
        reflection: Bool
    ) async throws -> CassetteRenderResult {
        var fields: [MultipartField] = [
            MultipartField(name: "project_id", value: projectId.uuidString.lowercased()),
            MultipartField(name: "scene", value: scene),
        ]
        if let subject, !subject.isEmpty {
            fields.append(MultipartField(name: "subject", value: subject))
        }
        if scene == "custom", let setting {
            fields.append(MultipartField(name: "setting", value: String(setting.prefix(300))))
        }
        if let lettering, !lettering.isEmpty {
            fields.append(MultipartField(name: "lettering", value: lettering))
        }
        fields.append(MultipartField(name: "color", value: color))
        fields.append(MultipartField(name: "position", value: position))
        fields.append(MultipartField(name: "size", value: size))
        if reflection {
            fields.append(MultipartField(name: "reflection", value: "1"))
        }

        var files: [MultipartFile] = []
        if scene == "photo", let background {
            let jpeg = try Self.uploadableJPEG(background, maxEdge: 3000)
            files.append(MultipartFile(name: "background", filename: "background.jpg", data: jpeg))
        }

        let data = try await requestMultipart(path: "/api/cassette-studio/render", fields: fields, files: files)
        return try decoder.decode(CassetteRenderResult.self, from: data)
    }

    // MARK: - Moving cover (owner-only; no AI)

    struct MotionAvailability: Decodable {
        let available: Bool
        let reason: String?
    }

    /// Whether this project's current cover was made in Cassette Studio with
    /// its layers saved (only those covers can move).
    func cassetteMotionAvailability(projectId: UUID) async throws -> MotionAvailability {
        let data = try await requestData(
            path: "/api/cassette-studio/motion?project_id=\(projectId.uuidString.lowercased())",
            method: "GET"
        )
        return try decoder.decode(MotionAvailability.self, from: data)
    }

    /// Render the moving cover in one of the free formats (canvas, square,
    /// youtube, story). Saved to the visualizer library server-side; returns
    /// the stored video URL.
    func renderCassetteMotion(projectId: UUID, format: String) async throws -> String {
        let body: [String: Any] = [
            "project_id": projectId.uuidString.lowercased(),
            "format": format,
        ]
        let json = try await requestJSON(path: "/api/cassette-studio/motion", method: "POST", body: body)
        guard let url = json["video_url"] as? String, !url.isEmpty else {
            throw MixbaseAPIError.invalidResponse("No video URL in response")
        }
        return url
    }

    // MARK: - Instrumental slot

    /// Set (or clear, with nil) the project's pinned instrumental — the one
    /// no-vocals file that lives beside the mixes. Goes through the web route
    /// rather than PostgREST so the server validates the URL is a Supabase
    /// Storage URL and self-heals the 035 column if a deploy beat the
    /// migration to production.
    func setInstrumental(projectId: UUID, url: String?) async throws {
        let body: [String: Any] = ["instrumental_url": url ?? NSNull()]
        _ = try await requestJSON(path: "/api/projects/\(projectId.uuidString.lowercased())", method: "PATCH", body: body)
    }

    /// Set whether someone holding this version's share link is offered a
    /// download button.
    ///
    /// This is a CONSENT SIGNAL, not an access control — see
    /// src/lib/version-defaults.ts. /api/audio is a public path and mf-audio is
    /// public-read, so anyone with the share link can already fetch the bytes.
    /// The flag says what the artist is comfortable with; do not build anything
    /// here that implies it withholds the file.
    ///
    /// Goes through the web route rather than PostgREST so it picks up the
    /// route's ownership check and rate limit.
    func setAllowDownload(versionId: UUID, allow: Bool) async throws {
        let body: [String: Any] = ["allow_download": allow]
        _ = try await requestJSON(path: "/api/versions/\(versionId.uuidString.lowercased())", method: "PATCH", body: body)
    }

    /// Move a version along the workflow (Mix → Master → Finished → Released).
    /// Goes through PATCH /api/versions/[id] rather than PostgREST so the
    /// server stays the one authority on the status set (it folds anything
    /// unknown back onto it).
    func setVersionStatus(versionId: UUID, status: String) async throws {
        let body: [String: Any] = ["status": status]
        _ = try await requestJSON(path: "/api/versions/\(versionId.uuidString.lowercased())", method: "PATCH", body: body)
    }

    // MARK: - Artwork assignment (Media library)

    /// Set an existing artwork image as a project's cover (must be a Supabase
    /// storage URL — the server validates and clears any stale finalized render).
    func assignArtworkToProject(projectId: UUID, artworkUrl: String) async throws {
        let body: [String: Any] = ["artwork_url": artworkUrl]
        _ = try await requestJSON(path: "/api/projects/\(projectId.uuidString.lowercased())", method: "PATCH", body: body)
    }

    /// Set an artwork image as a collection's cover.
    func setCollectionCover(collectionId: UUID, coverUrl: String) async throws {
        let body: [String: Any] = ["cover_url": coverUrl]
        _ = try await requestJSON(path: "/api/collections/\(collectionId.uuidString.lowercased())", method: "PATCH", body: body)
    }

    // MARK: - Released Library (mb_library_tracks via /api/library)

    /// Everything the artist has put out — ISRCs, UPCs, dates, project links.
    func fetchLibraryTracks() async throws -> [LibraryTrack] {
        let data = try await requestData(path: "/api/library", method: "GET")
        return try decoder.decode([LibraryTrack].self, from: data)
    }

    /// Sync the discography from Spotify/Deezer (server-side, upsert).
    /// Returns a human-readable summary of what changed.
    func syncLibrary(artist: String) async throws -> String {
        let json = try await requestJSON(path: "/api/library", method: "POST", body: ["artist": artist])
        let total = json["total"] as? Int ?? 0
        let created = json["created"] as? Int ?? 0
        let updated = json["updated"] as? Int ?? 0
        let name = json["artistName"] as? String ?? artist
        let source = (json["source"] as? String) == "spotify" ? "Spotify" : "Deezer"
        return "Synced \(total) track\(total == 1 ? "" : "s") for \(name) via \(source) — \(created) new, \(updated) updated."
    }

    enum IsrcLookup {
        case found(LibraryTrack)
        case notFound(String)
    }

    /// Targeted MusicBrainz lookup for one track's missing ISRC.
    func findIsrc(trackId: UUID) async throws -> IsrcLookup {
        let data = try await requestData(
            path: "/api/library/find-isrc",
            method: "POST",
            body: ["track_id": trackId.uuidString.lowercased()]
        )
        if let track = try? decoder.decode(LibraryTrack.self, from: data) {
            return .found(track)
        }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        return .notFound(json?["message"] as? String ?? "No ISRC found for this track.")
    }

    /// Link (or unlink, with nil) the project holding a track's original file.
    /// Returns the updated row.
    func linkLibraryTrack(id: UUID, projectId: UUID?) async throws -> LibraryTrack {
        let body: [String: Any] = ["project_id": projectId?.uuidString.lowercased() ?? NSNull()]
        let data = try await requestData(path: "/api/library/\(id.uuidString.lowercased())", method: "PATCH", body: body)
        return try decoder.decode(LibraryTrack.self, from: data)
    }

    /// Remove a track from the released library.
    func deleteLibraryTrack(id: UUID) async throws {
        _ = try await requestData(path: "/api/library/\(id.uuidString.lowercased())", method: "DELETE")
    }

    // MARK: - Community Feed (cross-user by design)

    /// Recent uploads across ALL artists — one entry per project (newest mix),
    /// with inter-artist comments and that project's older mixes.
    // MARK: - Account

    /// Whether this account sees the owner-only tools (`owner_tools` from
    /// GET /api/auth/me). A response without the field reads as false.
    func fetchOwnerTools() async throws -> Bool {
        let json = try await requestJSON(path: "/api/auth/me", method: "GET")
        return (json["owner_tools"] as? Bool) == true
    }

    /// Permanently delete the signed-in account and all its data (Guideline
    /// 5.1.1(v)). Goes through requestData so an expired access token is
    /// refreshed and retried instead of failing the one flow Apple requires
    /// to always work.
    func deleteAccount() async throws {
        _ = try await requestData(path: "/api/auth/delete-account", method: "POST")
    }

    // MARK: - Moderation (App Store Guideline 1.2)

    /// Report objectionable feed content. type is "version" (a track entry)
    /// or "comment". The reporter stops seeing the content immediately;
    /// heavily-reported content is removed for everyone.
    func reportContent(type: String, id: UUID, reason: String? = nil) async throws {
        var body: [String: Any] = [
            "content_type": type,
            "content_id": id.uuidString.lowercased(),
        ]
        if let reason, !reason.isEmpty { body["reason"] = reason }
        _ = try await requestData(path: "/api/feed/report", method: "POST", body: body)
    }

    /// Block another artist — their uploads and comments disappear from this
    /// account's feed everywhere, immediately and on every future load.
    func blockUser(id: UUID) async throws {
        _ = try await requestData(path: "/api/feed/block", method: "POST", body: [
            "user_id": id.uuidString.lowercased(),
        ])
    }

    /// Wrapper that swallows a single undecodable feed row. Decoding the feed
    /// as a plain [FeedItem] means ONE malformed entry (e.g. a legacy ownerless
    /// upload whose user_id serializes as "") blanks the entire community feed.
    private struct LossyFeedItem: Decodable {
        let item: FeedItem?
        init(from decoder: Decoder) {
            item = try? FeedItem(from: decoder)
        }
    }

    func fetchFeed() async throws -> [FeedItem] {
        let data = try await requestData(path: "/api/feed", method: "GET")
        return try decoder.decode([LossyFeedItem].self, from: data).compactMap(\.item)
    }

    /// Leave a comment on another artist's upload. Returns the saved comment
    /// (with this user's public artist name filled in server-side).
    func postFeedComment(versionId: UUID, comment: String) async throws -> FeedComment {
        let body: [String: Any] = [
            "version_id": versionId.uuidString.lowercased(),
            "comment": comment,
        ]
        let data = try await requestData(path: "/api/feed/comments", method: "POST", body: body)
        return try decoder.decode(FeedComment.self, from: data)
    }

    // MARK: - Mix notes (quick notes on your own mix)

    /// Jot a timestamped note on one of your own mixes — the same owner-only
    /// route the web player's notes menu posts through. The server verifies
    /// ownership, stamps the fixed "My notes" byline and writes no activity
    /// row (your own note must not ring your own notification bell), so both
    /// platforms produce identical mb_feedback rows and the web project
    /// page's markers, punch list and AI summary pick them up unchanged.
    /// Returns 201 with the inserted row in PostgREST column shape, so
    /// Feedback decodes the same way it does from a direct fetch.
    func postMixNote(versionId: UUID, comment: String, timestampSeconds: Int) async throws -> Feedback {
        let body: [String: Any] = [
            "version_id": versionId.uuidString.lowercased(),
            "comment": comment,
            "timestamp_seconds": timestampSeconds,
        ]
        let data = try await requestData(path: "/api/mix-notes", method: "POST", body: body)
        return try decoder.decode(Feedback.self, from: data)
    }

    // MARK: - Core request plumbing

    /// Perform a request and parse the response as a JSON object.
    // MARK: - Collections

    /// Mint (or fetch — it's idempotent) the public album share link for a
    /// collection. The server returns the canonical mixbase.app URL.
    func collectionShareLink(collectionId: UUID) async throws -> URL {
        let json = try await requestJSON(
            path: "/api/collections/\(collectionId.uuidString.lowercased())/share",
            method: "POST"
        )
        guard let urlString = json["url"] as? String, let url = URL(string: urlString) else {
            throw MixbaseAPIError.invalidResponse("No share URL in response")
        }
        return url
    }

    // MARK: - Versions (new mixes)

    /// Create the mb_versions row for a mix that has just finished uploading.
    ///
    /// Goes through the web route rather than writing to PostgREST directly,
    /// because three of this row's columns are the SERVER's decision, not the
    /// client's — and a direct insert has to invent all three:
    ///
    ///  • `allow_download` — a CONSENT signal, not an access control (see the
    ///    long note in src/lib/version-defaults.ts). It is deliberately NOT in
    ///    the body below, and must not be added: the route only INHERITS the
    ///    artist's previous choice when the field is ABSENT, and treats any
    ///    real boolean — `false` included — as an explicit decision that wins.
    ///    Sending a hardcoded `false` "to be safe" is exactly the bug this
    ///    replaced: an artist who ticked "let people with the share link
    ///    download this" on the web had it silently switched back off by their
    ///    next upload from the phone, with nothing in the UI to say so.
    ///  • `status` and `label` — parsed from the filename server-side
    ///    ("MASTER 2.wav" → Master, labelled 2), so both platforms land on the
    ///    same four statuses and the same per-kind numbering.
    ///  • `version_number` — computed server-side as max+1 and retried on the
    ///    unique-index violation, so two uploads racing the same project can't
    ///    both become "v2".
    ///
    /// There is no fallback to a direct insert if this fails: quietly writing
    /// the row ourselves would put every one of the above back in the client's
    /// hands. A failure surfaces to the artist instead.
    func createVersion(
        projectId: UUID,
        audioUrl: String,
        label: String?,
        audioFilename: String? = nil,
        durationSeconds: Int? = nil,
        fileSizeBytes: Int? = nil,
        shareToFeed: Bool = true
    ) async throws -> Version {
        var body: [String: Any] = [
            "project_id": projectId.uuidString.lowercased(),
            "audio_url": audioUrl,
            // The uploader's "Share to feed" toggle. Only false keeps the mix
            // off the community feed (migration 040).
            "share_to_feed": shareToFeed,
        ]
        // Omit rather than send NSNull: the route forwards these straight into
        // the insert, so a null would clobber a value a later heal or the web
        // app had already filled in.
        if let label { body["label"] = label }
        if let audioFilename { body["audio_filename"] = audioFilename }
        if let durationSeconds { body["duration_seconds"] = durationSeconds }
        if let fileSizeBytes { body["file_size_bytes"] = fileSizeBytes }

        // 201 with the inserted row — same column shape PostgREST returns, so
        // Version decodes unchanged.
        let data = try await requestData(path: "/api/versions", method: "POST", body: body)
        return try decoder.decode(Version.self, from: data)
    }

    // MARK: - Loudness (Master Check)

    /// Persist a measured BS.1770-4 reading for one mix — the same endpoint and
    /// body shape the web Master Check writes, so both platforms share one
    /// measurement history. Non-finite values (silence measures as −∞) are
    /// omitted; the server treats absent and null identically.
    func saveLoudness(versionId: UUID, measurement: LoudnessMeasurement) async throws {
        var body: [String: Any] = ["gatedBlockCount": measurement.gatedBlockCount]
        if measurement.integratedLufs.isFinite { body["integratedLufs"] = measurement.integratedLufs }
        if measurement.shortTermMaxLufs.isFinite { body["shortTermMaxLufs"] = measurement.shortTermMaxLufs }
        if measurement.samplePeakDb.isFinite { body["samplePeakDb"] = measurement.samplePeakDb }
        _ = try await requestJSON(
            path: "/api/versions/\(versionId.uuidString.lowercased())/loudness",
            method: "POST",
            body: body
        )
    }

    private func requestJSON(path: String, method: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        let data = try await requestData(path: path, method: method, body: body)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MixbaseAPIError.invalidResponse("Response was not a JSON object")
        }
        return json
    }

    /// Perform an authenticated JSON request — a thin wrapper over
    /// requestCore (same auth, 401 refresh+retry and error scrubbing).
    private func requestData(path: String, method: String, body: [String: Any]? = nil) async throws -> Data {
        var payload: Data? = nil
        if let body {
            payload = try JSONSerialization.data(withJSONObject: body)
        }
        return try await requestCore(
            path: path,
            method: method,
            contentType: payload == nil ? nil : "application/json",
            body: payload
        )
    }

    /// Perform an authenticated request and return the body of a 2xx
    /// response. Anything else throws the server's own (scrubbed) message.
    private func requestCore(path: String, method: String, contentType: String?, body: Data?) async throws -> Data {
        let (status, data) = try await send(path: path, method: method, contentType: contentType, body: body)
        guard (200...299).contains(status) else {
            throw scrubbedError(statusCode: status, data: data)
        }
        return data
    }

    /// The transport core. Sends the Bearer token; on 401, refreshes the
    /// Supabase session (coalesced in AuthService) and retries once with the
    /// new token. Returns the final status code and body WITHOUT judging the
    /// status, so the few callers that treat a non-2xx as data (409 "already
    /// running", 404 "job gone") can read it; everyone else goes through
    /// requestCore.
    private func send(path: String, method: String, contentType: String?, body: Data?) async throws -> (Int, Data) {
        func makeRequest(token: String?) throws -> URLRequest {
            guard let url = URL(string: "\(baseURL)\(path)") else {
                throw MixbaseAPIError.invalidResponse("Bad URL: \(path)")
            }
            var request = URLRequest(url: url)
            request.httpMethod = method
            if let token {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            if let body {
                if let contentType {
                    request.setValue(contentType, forHTTPHeaderField: "Content-Type")
                }
                request.httpBody = body
            }
            return request
        }

        var (data, response) = try await session.data(for: makeRequest(token: currentToken()))

        // Expired access token — refresh once and retry with the new one.
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let refreshed = await AuthService.shared.refreshSession()
            guard refreshed else { throw MixbaseAPIError.notAuthenticated }
            (data, response) = try await session.data(for: makeRequest(token: currentToken()))
        }

        guard let http = response as? HTTPURLResponse else {
            throw MixbaseAPIError.invalidResponse("Not an HTTP response")
        }
        return (http.statusCode, data)
    }

    /// The error a non-2xx response surfaces as: the server's own `error`
    /// message — but never anything purchase-shaped.
    private func scrubbedError(statusCode: Int, data: Data) -> MixbaseAPIError {
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            // Legacy monthly-limit responses carried `upgrade: true`. There
            // are no paid plans anywhere (2026-09-12), and the App Store app
            // must never point anyone at a purchase, so this always maps to
            // neutral, purchase-free copy.
            if (json["upgrade"] as? Bool) == true {
                return MixbaseAPIError.serverError("You've reached this month's limit for AI generations. It resets at the start of next month.")
            }
            // Otherwise prefer the server's own human-readable error — but
            // never trust it to be purchase-free. Belt-and-braces: if ANY
            // server message mentions upgrading, plans, pricing, or buying
            // (flagged or not), replace it with neutral copy so nothing
            // purchase-shaped can ever reach the app.
            if let message = json["error"] as? String {
                let purchaseWords = ["upgrade", "plan", "tier", "subscri", "purchase", "billing", "pricing", "credit", "buy "]
                let lowered = message.lowercased()
                if purchaseWords.contains(where: { lowered.contains($0) }) {
                    return MixbaseAPIError.serverError("This action isn't available right now. Please try again later.")
                }
                return MixbaseAPIError.serverError(message)
            }
        }
        return MixbaseAPIError.httpError(statusCode: statusCode)
    }

    // MARK: - Multipart

    /// One text part of a multipart/form-data body (sent WITHOUT filename=,
    /// so the server's FormData reads it as a string).
    struct MultipartField {
        let name: String
        let value: String
    }

    /// One file part (sent WITH filename= and Content-Type image/jpeg, so the
    /// server's FormData reads it as a File). Always a JPEG here.
    struct MultipartFile {
        let name: String
        let filename: String
        let data: Data
    }

    /// Railway's proxy truncates request bodies at exactly 10 MiB; stay clear
    /// of it so an oversize upload fails here, legibly, not mid-flight.
    private static let maxMultipartBytes = 10 * 1024 * 1024 - 64 * 1024

    /// Build a multipart/form-data body with CRLF line endings.
    static func multipartBody(boundary: String, fields: [MultipartField], files: [MultipartFile]) -> Data {
        var body = Data()
        let crlf = "\r\n"
        for field in fields {
            body.append(Data("--\(boundary)\(crlf)".utf8))
            body.append(Data("Content-Disposition: form-data; name=\"\(field.name)\"\(crlf)".utf8))
            body.append(Data(crlf.utf8))
            body.append(Data(field.value.utf8))
            body.append(Data(crlf.utf8))
        }
        for file in files {
            body.append(Data("--\(boundary)\(crlf)".utf8))
            body.append(Data("Content-Disposition: form-data; name=\"\(file.name)\"; filename=\"\(file.filename)\"\(crlf)".utf8))
            body.append(Data("Content-Type: image/jpeg\(crlf)".utf8))
            body.append(Data(crlf.utf8))
            body.append(file.data)
            body.append(Data(crlf.utf8))
        }
        body.append(Data("--\(boundary)--\(crlf)".utf8))
        return body
    }

    /// Authenticated multipart POST (same auth, refresh and error handling as
    /// the JSON requests).
    private func requestMultipart(path: String, fields: [MultipartField], files: [MultipartFile]) async throws -> Data {
        let boundary = "mixbase-\(UUID().uuidString)"
        let body = Self.multipartBody(boundary: boundary, fields: fields, files: files)
        guard body.count < Self.maxMultipartBytes else {
            throw MixbaseAPIError.serverError("That photo is too large — try a smaller one.")
        }
        return try await requestCore(
            path: path,
            method: "POST",
            contentType: "multipart/form-data; boundary=\(boundary)",
            body: body
        )
    }

    /// Query-value encoding matching JS encodeURIComponent: everything except
    /// the unreserved characters is escaped (including "/").
    private static let queryValueAllowed: CharacterSet = {
        var set = CharacterSet.alphanumerics
        set.insert(charactersIn: "-._~")
        return set
    }()

    // MARK: - Image downscaling (ImageIO — iOS and macOS alike)

    /// Re-encode any image the device can decode (HEIC, PNG, JPEG, …) as a
    /// JPEG whose longest edge is at most `maxEdge` pixels, honouring EXIF
    /// orientation. ImageIO never decodes the full-resolution bitmap, so a
    /// 48 MP photo costs no more memory than the output. nil when the data
    /// isn't a readable image. (Same technique as NowPlayingStore's widget
    /// thumbnail, which is private to that file and also built into the
    /// widget extension.)
    static func downscaledJPEG(_ data: Data, maxEdge: Int, quality: Double = 0.88) -> Data? {
        let sourceOptions: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions as CFDictionary) else { return nil }
        let thumbOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, maxEdge),
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOptions as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        let destOptions: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
        CGImageDestinationAddImage(destination, cgImage, destOptions as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return out as Data
    }

    /// The server caps each photo at 9 MiB and the whole request must stay
    /// under 10 MiB, so aim for at most 8 MiB per photo.
    private static let maxPhotoBytes = 8 * 1024 * 1024

    /// downscaledJPEG, stepping size and quality down in the (rare) case a
    /// very detailed image still comes out over the per-photo budget.
    static func uploadableJPEG(_ data: Data, maxEdge: Int) throws -> Data {
        var edge = maxEdge
        var quality = 0.88
        for _ in 0..<4 {
            guard let jpeg = downscaledJPEG(data, maxEdge: edge, quality: quality) else {
                throw MixbaseAPIError.serverError("Could not read that image — try a different photo.")
            }
            if jpeg.count <= maxPhotoBytes { return jpeg }
            edge = edge * 3 / 4
            quality = max(0.6, quality - 0.1)
        }
        throw MixbaseAPIError.serverError("That photo is too large — try a smaller one.")
    }

    /// The current Supabase access token, as persisted by AuthService.
    private func currentToken() -> String? {
        KeychainService.load(forKey: "access_token")
    }
}

// MARK: - MixbaseAPIError

enum MixbaseAPIError: LocalizedError {
    case notAuthenticated
    case serverError(String)
    case httpError(statusCode: Int)
    case invalidResponse(String)

    var errorDescription: String? {
        switch self {
        case .notAuthenticated:
            return "Your session expired. Please sign in again."
        case .serverError(let message):
            return message
        case .httpError(let code):
            return "Request failed (HTTP \(code))"
        case .invalidResponse(let message):
            return message
        }
    }
}
