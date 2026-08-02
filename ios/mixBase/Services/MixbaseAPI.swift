import Foundation

// MARK: - MixbaseAPI
// Client for the web app's authenticated API routes (mixbase.app). These are
// the routes that run the paid AI generation server-side — artwork via
// Replicate, visualizers via Runway — with per-tier limits enforced where the
// keys live. The middleware accepts `Authorization: Bearer <supabase access
// token>`, which is exactly how this client authenticates.

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
        config.timeoutIntervalForRequest = 6 * 60
        config.timeoutIntervalForResource = 8 * 60
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
        ImageModel(id: "flux-ultra",   label: "FLUX Ultra Raw"),
        ImageModel(id: "seedream",     label: "Seedream 4"),
        ImageModel(id: "imagen-ultra", label: "Imagen 4 Ultra"),
        ImageModel(id: "recraft",      label: "Recraft V3"),
        ImageModel(id: "flux",         label: "Flux 2 Pro"),
        ImageModel(id: "imagen",       label: "Imagen 4"),
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

    /// Available Runway image-to-video models with their valid durations/ratios.
    func fetchRunwayModels() async throws -> [RunwayModel] {
        let data = try await requestData(path: "/api/visualizer/runway", method: "GET")
        struct ModelsResponse: Codable { let models: [RunwayModel] }
        return try decoder.decode(ModelsResponse.self, from: data).models
    }

    /// Generate a visualizer video from an artwork image. Blocks until the
    /// server finishes polling Runway (can take minutes for slower models).
    /// The server persists the video to the user's Media library when it can.
    /// Returns the video URL (a permanent storage URL when saved=true).
    func generateVisualizer(
        projectId: UUID,
        imageUrl: String,
        model: String,
        duration: Int,
        ratio: String,
        prompt: String?
    ) async throws -> (videoUrl: String, saved: Bool) {
        var body: [String: Any] = [
            "projectId": projectId.uuidString.lowercased(),
            "imageUrl": imageUrl,
            "model": model,
            "duration": duration,
            "ratio": ratio,
        ]
        if let prompt, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            body["promptText"] = prompt
        }
        let json = try await requestJSON(path: "/api/visualizer/runway", method: "POST", body: body)
        guard let url = json["videoUrl"] as? String else {
            throw MixbaseAPIError.invalidResponse("No video URL in response")
        }
        return (url, (json["saved"] as? Bool) ?? false)
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
    func pinVisualizer(projectId: UUID, videoUrl: String?) async throws {
        let body: [String: Any] = ["visualizer_url": videoUrl ?? NSNull()]
        _ = try await requestJSON(path: "/api/projects/\(projectId.uuidString.lowercased())", method: "PATCH", body: body)
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
    func fetchFeed() async throws -> [FeedItem] {
        let data = try await requestData(path: "/api/feed", method: "GET")
        return try decoder.decode([FeedItem].self, from: data)
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

    // MARK: - Core request plumbing

    /// Perform a request and parse the response as a JSON object.
    private func requestJSON(path: String, method: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        let data = try await requestData(path: path, method: method, body: body)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MixbaseAPIError.invalidResponse("Response was not a JSON object")
        }
        return json
    }

    /// Perform an authenticated request. On 401, refreshes the Supabase session
    /// (coalesced in AuthService) and retries once with the new token. Non-2xx
    /// responses surface the server's own `error` message — that's where the
    /// tier-limit and upgrade prompts come from.
    private func requestData(path: String, method: String, body: [String: Any]? = nil) async throws -> Data {
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
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
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
        guard (200...299).contains(http.statusCode) else {
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                // Monthly tier limits come back with `upgrade: true`. On iOS there
                // is no in-app purchase, so we must NOT surface the web's
                // "Upgrade to generate more" copy — App Store Guideline 3.1.1
                // forbids steering users to an external purchase. Show neutral,
                // purchase-free copy instead.
                if (json["upgrade"] as? Bool) == true {
                    throw MixbaseAPIError.serverError("You've reached this month's limit for AI generations. It resets at the start of next month.")
                }
                // Otherwise prefer the server's own human-readable error.
                if let message = json["error"] as? String {
                    throw MixbaseAPIError.serverError(message)
                }
            }
            throw MixbaseAPIError.httpError(statusCode: http.statusCode)
        }
        return data
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
