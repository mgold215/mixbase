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
            // Prefer the server's human-readable error (e.g. "Monthly artwork
            // limit reached (3/3). Upgrade to generate more.")
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let message = json["error"] as? String {
                throw MixbaseAPIError.serverError(message)
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
