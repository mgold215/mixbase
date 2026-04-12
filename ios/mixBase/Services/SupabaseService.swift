import Foundation

// MARK: - SupabaseService
// A "singleton" service — meaning there's only one instance shared across the whole app.
// It handles all communication with your Supabase database using plain HTTP requests.
// No external SDK needed; we just use Apple's built-in URLSession.

class SupabaseService {

    // The single shared instance that the whole app uses
    static let shared = SupabaseService()

    // Base URL for your Supabase project
    private let supabaseURL: String

    // The anon key used to authenticate API requests
    private let supabaseKey: String

    // A JSON decoder configured to handle Supabase's date and key formats
    private let decoder: JSONDecoder

    // A JSON encoder configured to output snake_case keys for Supabase
    private let encoder: JSONEncoder

    // Private init so nobody can create a second instance
    private init() {
        self.supabaseURL = Config.supabaseURL
        self.supabaseKey = Config.supabaseAnonKey

        // -- Configure the JSON decoder --
        self.decoder = JSONDecoder()

        // Supabase returns dates in ISO 8601 format (e.g. "2026-04-12T10:30:00.000Z").
        // This formatter handles the optional fractional seconds (.000).
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        // Also prepare a plain date formatter for "yyyy-MM-dd" date-only fields (like release_date)
        let dateOnlyFormatter = DateFormatter()
        dateOnlyFormatter.dateFormat = "yyyy-MM-dd"
        dateOnlyFormatter.locale = Locale(identifier: "en_US_POSIX")
        dateOnlyFormatter.timeZone = TimeZone(identifier: "UTC")

        // Custom date decoding: try ISO 8601 with fractional seconds first,
        // then ISO 8601 without fractional seconds, then date-only format.
        self.decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let dateString = try container.decode(String.self)

            // Try ISO 8601 with fractional seconds
            if let date = isoFormatter.date(from: dateString) {
                return date
            }

            // Try ISO 8601 without fractional seconds
            let plainISO = ISO8601DateFormatter()
            plainISO.formatOptions = [.withInternetDateTime]
            if let date = plainISO.date(from: dateString) {
                return date
            }

            // Try date-only format (yyyy-MM-dd) for fields like release_date
            if let date = dateOnlyFormatter.date(from: dateString) {
                return date
            }

            // If nothing works, throw an error
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Cannot decode date: \(dateString)"
            )
        }

        // -- Configure the JSON encoder --
        self.encoder = JSONEncoder()

        // Encode dates as ISO 8601 strings
        self.encoder.dateEncodingStrategy = .iso8601
    }

    // MARK: - Helper: Build a URLRequest with Supabase headers
    // Every Supabase REST call needs the same headers; this saves repetition.
    private func makeRequest(
        path: String,
        method: String = "GET",
        body: Data? = nil,
        extraHeaders: [String: String] = [:]
    ) -> URLRequest {
        let url = URL(string: "\(supabaseURL)\(path)")!
        var request = URLRequest(url: url)
        request.httpMethod = method

        // Required headers for Supabase REST API
        request.setValue(supabaseKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(supabaseKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        // For POST/PATCH, tell Supabase to return the created/updated row
        if method == "POST" || method == "PATCH" {
            request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        }

        // Apply any extra headers the caller needs
        for (key, value) in extraHeaders {
            request.setValue(value, forHTTPHeaderField: key)
        }

        // Attach the JSON body if provided
        request.httpBody = body

        return request
    }

    // MARK: - Projects

    /// Fetch all projects, newest-updated first
    func fetchProjects() async throws -> [Project] {
        let request = makeRequest(path: "/rest/v1/mb_projects?order=updated_at.desc")
        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
        return try decoder.decode([Project].self, from: data)
    }

    /// Fetch a single project by its ID
    func fetchProject(id: UUID) async throws -> Project {
        let request = makeRequest(path: "/rest/v1/mb_projects?id=eq.\(id.uuidString)")
        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
        let projects = try decoder.decode([Project].self, from: data)
        guard let project = projects.first else {
            throw SupabaseError.notFound("Project \(id) not found")
        }
        return project
    }

    /// Create a new project with a title and optional genre / BPM
    func createProject(title: String, genre: String?, bpm: Int?) async throws -> Project {
        // Build a dictionary of the fields to send
        var fields: [String: Any] = [
            "title": title
        ]
        if let genre = genre { fields["genre"] = genre }
        if let bpm = bpm { fields["bpm"] = bpm }

        let body = try JSONSerialization.data(withJSONObject: fields)
        let request = makeRequest(path: "/rest/v1/mb_projects", method: "POST", body: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
        let projects = try decoder.decode([Project].self, from: data)
        guard let project = projects.first else {
            throw SupabaseError.decodingFailed("Failed to decode created project")
        }
        return project
    }

    /// Update an existing project (sends the full object)
    func updateProject(_ project: Project) async throws {
        let body = try encoder.encode(project)
        let request = makeRequest(
            path: "/rest/v1/mb_projects?id=eq.\(project.id.uuidString)",
            method: "PATCH",
            body: body
        )
        let (_, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
    }

    // MARK: - Versions

    /// Fetch all versions for a given project, ordered by version number
    func fetchVersions(projectId: UUID) async throws -> [Version] {
        let path = "/rest/v1/mb_versions?project_id=eq.\(projectId.uuidString)&order=version_number.asc"
        let request = makeRequest(path: path)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
        return try decoder.decode([Version].self, from: data)
    }

    /// Create a new version for a project
    func createVersion(
        projectId: UUID,
        versionNumber: Int,
        audioUrl: String,
        label: String?
    ) async throws -> Version {
        var fields: [String: Any] = [
            "project_id": projectId.uuidString,
            "version_number": versionNumber,
            "audio_url": audioUrl,
            "status": "WIP",
            "allow_download": false
        ]
        if let label = label { fields["label"] = label }

        let body = try JSONSerialization.data(withJSONObject: fields)
        let request = makeRequest(path: "/rest/v1/mb_versions", method: "POST", body: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
        let versions = try decoder.decode([Version].self, from: data)
        guard let version = versions.first else {
            throw SupabaseError.decodingFailed("Failed to decode created version")
        }
        return version
    }

    /// Update just the status of a version (e.g. "WIP" -> "Final")
    func updateVersionStatus(id: UUID, status: String) async throws {
        let fields: [String: Any] = ["status": status]
        let body = try JSONSerialization.data(withJSONObject: fields)
        let request = makeRequest(
            path: "/rest/v1/mb_versions?id=eq.\(id.uuidString)",
            method: "PATCH",
            body: body
        )
        let (_, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
    }

    // MARK: - Releases

    /// Fetch all releases, ordered by release date (newest first)
    func fetchReleases() async throws -> [Release] {
        let request = makeRequest(path: "/rest/v1/mb_releases?order=release_date.desc.nullslast")
        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
        return try decoder.decode([Release].self, from: data)
    }

    /// Fetch a single release by its ID
    func fetchRelease(id: UUID) async throws -> Release {
        let request = makeRequest(path: "/rest/v1/mb_releases?id=eq.\(id.uuidString)")
        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
        let releases = try decoder.decode([Release].self, from: data)
        guard let release = releases.first else {
            throw SupabaseError.notFound("Release \(id) not found")
        }
        return release
    }

    /// Create a new release
    func createRelease(title: String, projectId: UUID?, releaseDate: Date?) async throws -> Release {
        var fields: [String: Any] = [
            "title": title,
            // Default all checklist items to false
            "mixing_done": false,
            "mastering_done": false,
            "artwork_ready": false,
            "dsp_submitted": false,
            "social_posts_done": false,
            "press_release_done": false,
            "dsp_spotify": false,
            "dsp_apple_music": false,
            "dsp_tidal": false,
            "dsp_bandcamp": false,
            "dsp_soundcloud": false,
            "dsp_youtube": false,
            "dsp_amazon": false
        ]
        if let projectId = projectId { fields["project_id"] = projectId.uuidString }
        if let releaseDate = releaseDate {
            // Format as "yyyy-MM-dd" since the column is a date, not a timestamp
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"
            formatter.locale = Locale(identifier: "en_US_POSIX")
            fields["release_date"] = formatter.string(from: releaseDate)
        }

        let body = try JSONSerialization.data(withJSONObject: fields)
        let request = makeRequest(path: "/rest/v1/mb_releases", method: "POST", body: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
        let releases = try decoder.decode([Release].self, from: data)
        guard let release = releases.first else {
            throw SupabaseError.decodingFailed("Failed to decode created release")
        }
        return release
    }

    /// Update an existing release (sends the full object)
    func updateRelease(_ release: Release) async throws {
        let body = try encoder.encode(release)
        let request = makeRequest(
            path: "/rest/v1/mb_releases?id=eq.\(release.id.uuidString)",
            method: "PATCH",
            body: body
        )
        let (_, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
    }

    // MARK: - Feedback

    /// Fetch all feedback for a specific version
    func fetchFeedback(versionId: UUID) async throws -> [Feedback] {
        let path = "/rest/v1/mb_feedback?version_id=eq.\(versionId.uuidString)&order=created_at.desc"
        let request = makeRequest(path: path)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
        return try decoder.decode([Feedback].self, from: data)
    }

    // MARK: - Activity

    /// Fetch recent activity entries, limited to a certain count
    func fetchActivities(limit: Int = 20) async throws -> [Activity] {
        let path = "/rest/v1/mb_activity?order=created_at.desc&limit=\(limit)"
        let request = makeRequest(path: path)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
        return try decoder.decode([Activity].self, from: data)
    }

    // MARK: - Storage: Audio Upload

    /// Upload an audio file to the "mf-audio" bucket in Supabase Storage.
    /// Returns the public URL of the uploaded file.
    func uploadAudio(data: Data, filename: String) async throws -> String {
        return try await uploadFile(data: data, filename: filename, bucket: "mf-audio")
    }

    // MARK: - Storage: Artwork Upload

    /// Upload an artwork image to the "mf-artwork" bucket in Supabase Storage.
    /// Returns the public URL of the uploaded file.
    func uploadArtwork(data: Data, filename: String) async throws -> String {
        return try await uploadFile(data: data, filename: filename, bucket: "mf-artwork")
    }

    // MARK: - Storage Helper

    /// Generic file upload to a Supabase Storage bucket.
    /// The file is uploaded at the root of the bucket with the given filename.
    private func uploadFile(data: Data, filename: String, bucket: String) async throws -> String {
        let path = "/storage/v1/object/\(bucket)/\(filename)"
        let url = URL(string: "\(supabaseURL)\(path)")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"

        // Storage API still needs the same auth headers
        request.setValue(supabaseKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(supabaseKey)", forHTTPHeaderField: "Authorization")

        // Guess content type from file extension
        let contentType = guessContentType(for: filename)
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")

        // If the file already exists, allow overwriting it
        request.setValue("true", forHTTPHeaderField: "x-upsert")

        request.httpBody = data

        let (_, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)

        // Build and return the public URL for the uploaded file
        let publicURL = "\(supabaseURL)/storage/v1/object/public/\(bucket)/\(filename)"
        return publicURL
    }

    // MARK: - Response Validation

    /// Check that the HTTP response is in the 200-299 "success" range.
    /// If not, throw an error with the status code.
    private func validateResponse(_ response: URLResponse) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw SupabaseError.invalidResponse
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw SupabaseError.httpError(statusCode: httpResponse.statusCode)
        }
    }

    // MARK: - Content Type Helper

    /// Returns a MIME type string based on the file extension.
    private func guessContentType(for filename: String) -> String {
        let ext = (filename as NSString).pathExtension.lowercased()
        switch ext {
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        case "aac": return "audio/aac"
        case "flac": return "audio/flac"
        case "m4a": return "audio/mp4"
        case "ogg": return "audio/ogg"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        default: return "application/octet-stream"
        }
    }
}

// MARK: - SupabaseError
// Custom error types so we can give clear error messages throughout the app.

enum SupabaseError: LocalizedError {
    case notFound(String)
    case httpError(statusCode: Int)
    case invalidResponse
    case decodingFailed(String)

    var errorDescription: String? {
        switch self {
        case .notFound(let message):
            return message
        case .httpError(let code):
            return "HTTP error: \(code)"
        case .invalidResponse:
            return "Invalid response from server"
        case .decodingFailed(let message):
            return message
        }
    }
}
