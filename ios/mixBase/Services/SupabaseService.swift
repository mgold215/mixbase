import Foundation
import AVFoundation

// MARK: - Audio file metadata

/// Size and duration for a local audio file, probed just before upload.
///
/// Both are best-effort and return nil rather than throwing: a version whose
/// duration could not be read must still upload. `createVersion` omits nil
/// fields entirely, so a failed probe leaves the column absent rather than
/// writing a null over something real.
enum AudioFileMetadata {
    /// Size on disk in bytes.
    static func fileSize(of url: URL) -> Int? {
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey]) else { return nil }
        return values.fileSize
    }

    /// Duration in whole seconds. Rounded, to match what the web app writes
    /// (`Math.round(audio.duration)`), so the two upload paths agree.
    static func durationSeconds(of url: URL) async -> Int? {
        let asset = AVURLAsset(url: url)
        guard let duration = try? await asset.load(.duration) else { return nil }
        let seconds = CMTimeGetSeconds(duration)
        // A non-finite or zero duration means the probe failed, not that the
        // mix is empty — an indeterminate CMTime is exactly what a still-copying
        // or unsupported file yields.
        guard seconds.isFinite, seconds > 0 else { return nil }
        return Int(seconds.rounded())
    }
}

// MARK: - Storage key components

extension UUID {
    /// This id, spelled the one way a Supabase Storage KEY may spell it.
    ///
    /// WHY THIS EXISTS
    /// `UUID.uuidString` is UPPERCASE on Apple platforms. Postgres compares
    /// `uuid` columns by VALUE, so an uppercase id passes every ownership gate
    /// and every `?id=eq.…` filter identically to the lowercase one. Supabase
    /// Storage does not: object keys are plain text stored VERBATIM.
    ///
    /// Compose those two facts and an uppercase id in a key mints a real,
    /// billed object that ownership checks accept but that NO cleanup path can
    /// ever name — every reaper, prefix census and orphan scan starts from an
    /// id read back OUT of Postgres, which always renders lowercase, and then
    /// matches it as TEXT. Production carries 5 such objects in mf-audio today.
    ///
    /// So: canonicalise the UUID COMPONENT, here, at the point where an id
    /// crosses from the case-insensitive world into the case-sensitive one.
    /// Deliberately NOT done by lowercasing the whole filename inside
    /// `uploadRequest` — a filename is not guaranteed to be UUID-only forever,
    /// and a blanket `.lowercased()` there would silently corrupt any future
    /// caller that puts user text or a case-sensitive token in a key.
    ///
    /// Reads are unaffected: existing rows store a full public URL and keep
    /// working untouched. This is a write-path rule only.
    var storageKeyComponent: String { uuidString.lowercased() }

    /// This id, spelled the way POSTGRES renders it.
    ///
    /// WHY THIS IS SEPARATE FROM storageKeyComponent
    /// Both lowercase, for opposite reasons, and merging them would make one of
    /// the two comments a lie:
    ///
    ///   * `storageKeyComponent` exists because Supabase Storage does NOT
    ///     normalise. A key is bytes, so the uppercase spelling mints a second,
    ///     unreachable object.
    ///   * `postgresString` exists because Postgres DOES normalise. A `uuid`
    ///     column always renders lowercase (RFC 4122 canonical form), so any id
    ///     that has round-tripped through PostgREST comes back lowercase.
    ///
    /// The bug that follows is a TEXT comparison. Swift renders uuids uppercase,
    /// so `someUUID.uuidString == rowValueFromPostgREST` is not "usually right";
    /// it is ALWAYS FALSE whenever the row value came from a `uuid` column. That
    /// shipped in SubmitView: every submission rendered a nil curator and a nil
    /// project because the join was a case-sensitive string compare.
    ///
    /// Use this for BOTH sides of the rule — the value written into an id field,
    /// and the value compared against one read back — so the two halves cannot
    /// drift apart the way they did there.
    ///
    /// NOT needed for `?id=eq.\(uuid)` REST filters: those are parsed by
    /// Postgres as a uuid literal, which is case-insensitive, so both spellings
    /// select the same row. Left alone deliberately rather than churned.
    var postgresString: String { uuidString.lowercased() }
}

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

    // The authenticated user's JWT access token (set by AuthService after sign-in)
    private var accessToken: String? = nil

    // The authenticated user's ID (set by AuthService after sign-in)
    private(set) var currentUserId: String? = nil

    // Called by AuthService whenever the session changes
    func setAccessToken(_ token: String?) {
        self.accessToken = token
    }

    func setUserId(_ uid: String?) {
        self.currentUserId = uid
    }

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
        // Use the user's JWT when available so RLS policies apply; fall back to anon key
        let bearerToken = accessToken ?? supabaseKey
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
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

    // MARK: - Profile

    /// Fetch the user's artist name from the profiles table
    func fetchArtistName(userId: String) async -> String {
        let path = "/rest/v1/profiles?id=eq.\(userId)&select=artist_name"
        let request = makeRequest(path: path)
        guard let (data, _) = try? await authenticatedData(for: request),
              let json = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              let name = json.first?["artist_name"] as? String,
              !name.isEmpty
        else { return "" }
        return name
    }

    /// Update the profile's artist name (RLS `users_update_own_profile` limits
    /// the write to the caller's own row).
    func updateArtistName(userId: String, name: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["artist_name": name])
        let request = makeRequest(path: "/rest/v1/profiles?id=eq.\(userId)", method: "PATCH", body: body)
        let (data, response) = try await authenticatedData(for: request)
        try validateResponse(response, body: data)
        // A PATCH whose filter matches no rows still returns 200 with an empty
        // array — surface that instead of pretending the save landed.
        let rows = (try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]) ?? []
        guard !rows.isEmpty else {
            throw SupabaseError.notFound("No profile found for this account")
        }
    }

    // MARK: - Projects

    /// Fetch all projects, newest-updated first
    func fetchProjects() async throws -> [Project] {
        let request = makeRequest(path: "/rest/v1/mb_projects?order=updated_at.desc")
        let (data, response) = try await authenticatedData(for: request)
        try validateResponse(response)
        return try decoder.decode([Project].self, from: data)
    }

    /// Fetch a single project by its ID
    func fetchProject(id: UUID) async throws -> Project {
        let request = makeRequest(path: "/rest/v1/mb_projects?id=eq.\(id.uuidString)")
        let (data, response) = try await authenticatedData(for: request)
        try validateResponse(response)
        let projects = try decoder.decode([Project].self, from: data)
        guard let project = projects.first else {
            throw SupabaseError.notFound("Project \(id) not found")
        }
        return project
    }

    /// Create a new project with a title and optional genre / BPM
    func createProject(title: String, genre: String?, bpm: Int?) async throws -> Project {
        // The owner MUST be sent explicitly. `mb_projects.user_id` is nullable
        // with no database default, and this path writes straight to PostgREST
        // rather than through `POST /api/projects` (which sets it server-side
        // from the X-User-Id header). A row that lands with a null owner is
        // invisible to its creator everywhere afterwards: the web list filters
        // `.eq('user_id', userId)`, and the `users_own_projects` RLS policy
        // matches on `user_id = auth.uid()`, which a null can never satisfy.
        // 33 of 85 production projects are currently in that state.
        guard let ownerId = currentUserId else {
            throw SupabaseError.notFound("Not signed in — cannot create a project without an owner")
        }
        // Build a dictionary of the fields to send
        var fields: [String: Any] = [
            "title": title,
            "user_id": ownerId
        ]
        if let genre = genre { fields["genre"] = genre }
        if let bpm = bpm { fields["bpm"] = bpm }

        let body = try JSONSerialization.data(withJSONObject: fields)
        let request = makeRequest(path: "/rest/v1/mb_projects", method: "POST", body: body)
        let (data, response) = try await authenticatedData(for: request)
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
        let (_, response) = try await authenticatedData(for: request)
        try validateResponse(response)
    }

    // MARK: - Versions

    /// Fetch all versions for a given project, ordered by version number
    func fetchVersions(projectId: UUID) async throws -> [Version] {
        let path = "/rest/v1/mb_versions?project_id=eq.\(projectId.uuidString)&order=version_number.asc"
        let request = makeRequest(path: path)
        let (data, response) = try await authenticatedData(for: request)
        try validateResponse(response)
        return try decoder.decode([Version].self, from: data)
    }

    // Version ROWS are created by MixbaseAPI.createVersion, not here. A direct
    // PostgREST insert has to invent `allow_download`, `status`, `label` and
    // `version_number` client-side; POST /api/versions decides all four
    // server-side — most importantly inheriting the artist's download consent
    // instead of resetting it to false on every upload from the phone.

    /// Update just the status of a version (e.g. "Mix" -> "Master")
    func updateVersionStatus(id: UUID, status: String) async throws {
        let fields: [String: Any] = ["status": status]
        let body = try JSONSerialization.data(withJSONObject: fields)
        let request = makeRequest(
            path: "/rest/v1/mb_versions?id=eq.\(id.uuidString)",
            method: "PATCH",
            body: body
        )
        let (_, response) = try await authenticatedData(for: request)
        try validateResponse(response)
    }

    // MARK: - Releases

    /// Fetch all releases, ordered by release date (newest first)
    func fetchReleases() async throws -> [Release] {
        let request = makeRequest(path: "/rest/v1/mb_releases?order=release_date.desc.nullslast")
        let (data, response) = try await authenticatedData(for: request)
        try validateResponse(response)
        return try decoder.decode([Release].self, from: data)
    }

    /// Fetch a single release by its ID
    func fetchRelease(id: UUID) async throws -> Release {
        let request = makeRequest(path: "/rest/v1/mb_releases?id=eq.\(id.uuidString)")
        let (data, response) = try await authenticatedData(for: request)
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
        if let projectId = projectId { fields["project_id"] = projectId.postgresString }
        if let releaseDate = releaseDate {
            // Format as "yyyy-MM-dd" since the column is a date, not a timestamp
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"
            formatter.locale = Locale(identifier: "en_US_POSIX")
            fields["release_date"] = formatter.string(from: releaseDate)
        }

        let body = try JSONSerialization.data(withJSONObject: fields)
        let request = makeRequest(path: "/rest/v1/mb_releases", method: "POST", body: body)
        let (data, response) = try await authenticatedData(for: request)
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
        let (_, response) = try await authenticatedData(for: request)
        try validateResponse(response)
    }

    // MARK: - Collections

    /// Fetch all collections, newest first
    func fetchCollections() async throws -> [Collection] {
        let request = makeRequest(path: "/rest/v1/mb_collections?order=updated_at.desc")
        let (data, response) = try await authenticatedData(for: request)
        try validateResponse(response)
        return try decoder.decode([Collection].self, from: data)
    }

    /// Create a new collection (playlist, EP, or album)
    func createCollection(title: String, type: String) async throws -> Collection {
        let fields: [String: Any] = ["title": title, "type": type]
        let body = try JSONSerialization.data(withJSONObject: fields)
        let request = makeRequest(path: "/rest/v1/mb_collections", method: "POST", body: body)
        let (data, response) = try await authenticatedData(for: request)
        try validateResponse(response)
        let collections = try decoder.decode([Collection].self, from: data)
        guard let collection = collections.first else {
            throw SupabaseError.decodingFailed("Failed to decode created collection")
        }
        return collection
    }

    /// Update arbitrary collection fields (title, type, cover_url, release_date,
    /// notes). Pass NSNull() to clear a nullable column (e.g. remove the cover).
    /// updated_at is bumped so fetchCollections' newest-first order stays honest.
    func updateCollectionFields(id: UUID, fields: [String: Any]) async throws {
        var allFields = fields
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        allFields["updated_at"] = isoFormatter.string(from: Date())
        let body = try JSONSerialization.data(withJSONObject: allFields)
        let request = makeRequest(
            path: "/rest/v1/mb_collections?id=eq.\(id.uuidString)",
            method: "PATCH",
            body: body
        )
        let (_, response) = try await authenticatedData(for: request)
        try validateResponse(response)
    }

    /// Delete a collection and its item links. Items go first so this works
    /// whether or not the FK cascades.
    func deleteCollection(id: UUID) async throws {
        let itemsRequest = makeRequest(
            path: "/rest/v1/mb_collection_items?collection_id=eq.\(id.uuidString)",
            method: "DELETE"
        )
        let (_, itemsResponse) = try await authenticatedData(for: itemsRequest)
        try validateResponse(itemsResponse)

        let request = makeRequest(
            path: "/rest/v1/mb_collections?id=eq.\(id.uuidString)",
            method: "DELETE"
        )
        let (_, response) = try await authenticatedData(for: request)
        try validateResponse(response)
    }

    /// Fetch every collection item across all collections in one query — the
    /// collections list uses this for fallback covers and track counts without
    /// a query per collection.
    func fetchAllCollectionItems() async throws -> [CollectionItem] {
        let request = makeRequest(path: "/rest/v1/mb_collection_items?order=position.asc")
        let (data, response) = try await authenticatedData(for: request)
        try validateResponse(response)
        return try decoder.decode([CollectionItem].self, from: data)
    }

    /// Upload a collection cover image to mf-artwork; returns the public URL.
    func uploadCollectionCover(data: Data, collectionId: UUID) async throws -> String {
        let filename = "collection-\(collectionId.storageKeyComponent)-\(Int(Date().timeIntervalSince1970)).jpg"
        return try await uploadFile(data: data, filename: filename, bucket: "mf-artwork")
    }

    /// Fetch items in a collection, ordered by position
    func fetchCollectionItems(collectionId: UUID) async throws -> [CollectionItem] {
        let path = "/rest/v1/mb_collection_items?collection_id=eq.\(collectionId.uuidString)&order=position.asc"
        let request = makeRequest(path: path)
        let (data, response) = try await authenticatedData(for: request)
        try validateResponse(response)
        return try decoder.decode([CollectionItem].self, from: data)
    }

    /// Add a project to a collection at a given position
    func addToCollection(collectionId: UUID, projectId: UUID, position: Int) async throws -> CollectionItem {
        let fields: [String: Any] = [
            "collection_id": collectionId.postgresString,
            "project_id": projectId.postgresString,
            "position": position
        ]
        let body = try JSONSerialization.data(withJSONObject: fields)
        let request = makeRequest(path: "/rest/v1/mb_collection_items", method: "POST", body: body)
        let (data, response) = try await authenticatedData(for: request)
        try validateResponse(response)
        let items = try decoder.decode([CollectionItem].self, from: data)
        guard let item = items.first else {
            throw SupabaseError.decodingFailed("Failed to decode collection item")
        }
        return item
    }

    /// Remove a project from a collection
    func removeFromCollection(itemId: UUID) async throws {
        let request = makeRequest(
            path: "/rest/v1/mb_collection_items?id=eq.\(itemId.uuidString)",
            method: "DELETE"
        )
        let (_, response) = try await authenticatedData(for: request)
        try validateResponse(response)
    }

    /// Update position of items in a collection (for reordering)
    func updateCollectionItemPosition(itemId: UUID, position: Int) async throws {
        let fields: [String: Any] = ["position": position]
        let body = try JSONSerialization.data(withJSONObject: fields)
        let request = makeRequest(
            path: "/rest/v1/mb_collection_items?id=eq.\(itemId.uuidString)",
            method: "PATCH",
            body: body
        )
        let (_, response) = try await authenticatedData(for: request)
        try validateResponse(response)
    }

    // MARK: - Feedback

    /// Fetch all feedback for a specific version
    func fetchFeedback(versionId: UUID) async throws -> [Feedback] {
        let path = "/rest/v1/mb_feedback?version_id=eq.\(versionId.uuidString)&order=created_at.desc"
        let request = makeRequest(path: path)
        let (data, response) = try await authenticatedData(for: request)
        try validateResponse(response)
        return try decoder.decode([Feedback].self, from: data)
    }

    // MARK: - Activity

    /// Fetch recent activity entries, limited to a certain count
    func fetchActivities(limit: Int = 20) async throws -> [Activity] {
        let path = "/rest/v1/mb_activity?order=created_at.desc&limit=\(limit)"
        let request = makeRequest(path: path)
        let (data, response) = try await authenticatedData(for: request)
        try validateResponse(response)
        return try decoder.decode([Activity].self, from: data)
    }

    // MARK: - Curators

    /// Fetch all curators (shared directory + user's own)
    func fetchCurators() async throws -> [Curator] {
        // Shared directory (user_id is null) + user's own
        let path = "/rest/v1/sb_curators?or=(user_id.is.null,user_id.eq.\(currentUserId ?? ""))&order=name.asc"
        let request = makeRequest(path: path)
        let (data, response) = try await authenticatedData(for: request)
        try validateResponse(response)
        return try decoder.decode([Curator].self, from: data)
    }

    /// Create a new curator
    func createCurator(_ fields: [String: Any]) async throws -> Curator {
        let body = try JSONSerialization.data(withJSONObject: fields)
        let request = makeRequest(path: "/rest/v1/sb_curators", method: "POST", body: body)
        let (data, response) = try await authenticatedData(for: request)
        try validateResponse(response)
        let curators = try decoder.decode([Curator].self, from: data)
        guard let curator = curators.first else {
            throw SupabaseError.decodingFailed("Failed to decode created curator")
        }
        return curator
    }

    /// Update a curator
    func updateCurator(id: UUID, fields: [String: Any]) async throws {
        let body = try JSONSerialization.data(withJSONObject: fields)
        let request = makeRequest(
            path: "/rest/v1/sb_curators?id=eq.\(id.uuidString)&user_id=eq.\(currentUserId ?? "")",
            method: "PATCH",
            body: body
        )
        let (_, response) = try await authenticatedData(for: request)
        try validateResponse(response)
    }

    /// Delete a curator (only user-owned)
    func deleteCurator(id: UUID) async throws {
        let request = makeRequest(
            path: "/rest/v1/sb_curators?id=eq.\(id.uuidString)&user_id=eq.\(currentUserId ?? "")",
            method: "DELETE"
        )
        let (_, response) = try await authenticatedData(for: request)
        try validateResponse(response)
    }

    // MARK: - Submissions

    /// Fetch all submissions for the current user
    func fetchSubmissions() async throws -> [Submission] {
        let path = "/rest/v1/sb_submissions?order=created_at.desc"
        let request = makeRequest(path: path)
        let (data, response) = try await authenticatedData(for: request)
        try validateResponse(response)
        return try decoder.decode([Submission].self, from: data)
    }

    /// Create a submission (log a pitch to a curator)
    func createSubmission(_ fields: [String: Any]) async throws -> Submission {
        var allFields = fields
        allFields["status"] = "sent"
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        allFields["sent_at"] = isoFormatter.string(from: Date())

        let body = try JSONSerialization.data(withJSONObject: allFields)
        let request = makeRequest(path: "/rest/v1/sb_submissions", method: "POST", body: body)
        let (data, response) = try await authenticatedData(for: request)
        try validateResponse(response)
        let submissions = try decoder.decode([Submission].self, from: data)
        guard let submission = submissions.first else {
            throw SupabaseError.decodingFailed("Failed to decode created submission")
        }
        return submission
    }

    /// Update a submission's status
    func updateSubmissionStatus(id: UUID, status: String, responseNotes: String? = nil) async throws {
        var fields: [String: Any] = ["status": status]
        if let notes = responseNotes { fields["response_notes"] = notes }
        let body = try JSONSerialization.data(withJSONObject: fields)
        let request = makeRequest(
            path: "/rest/v1/sb_submissions?id=eq.\(id.uuidString)",
            method: "PATCH",
            body: body
        )
        let (_, response) = try await authenticatedData(for: request)
        try validateResponse(response)
    }

    // MARK: - Delete Project

    /// Delete a project and all its versions
    func deleteProject(id: UUID) async throws {
        let request = makeRequest(
            path: "/rest/v1/mb_projects?id=eq.\(id.uuidString)",
            method: "DELETE"
        )
        let (_, response) = try await authenticatedData(for: request)
        try validateResponse(response)
    }

    // MARK: - Storage: Audio Upload

    /// Upload an audio file to the "mf-audio" bucket by streaming it from disk.
    /// Mixes are routinely hundreds of MB — streaming avoids holding the whole
    /// file (plus URLSession's send buffer) in memory, and the delegate reports
    /// progress so the UI never looks stuck on a slow cellular uplink.
    /// Returns the public URL of the uploaded file.
    func uploadAudio(fileURL: URL, filename: String, onProgress: @escaping @Sendable (Double) -> Void) async throws -> String {
        return try await uploadFile(fileURL: fileURL, filename: filename, bucket: "mf-audio", onProgress: onProgress)
    }

    // MARK: - Storage: Artwork Upload

    /// Upload an artwork image to the "mf-artwork" bucket in Supabase Storage.
    /// Returns the public URL of the uploaded file.
    func uploadArtwork(data: Data, filename: String) async throws -> String {
        return try await uploadFile(data: data, filename: filename, bucket: "mf-artwork")
    }

    // MARK: - Storage Helpers

    // Session tuned for large uploads over cellular: a genuine 2-minute stall
    // still fails, but a slow-yet-moving upload gets a full hour before the
    // resource timeout kills it (URLSession.shared allows only 60s idle and is
    // shared with every quick REST call, so it gets no special tuning).
    private static let uploadSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 60 * 60
        return URLSession(configuration: config)
    }()

    // Forwards outgoing-byte progress for a streamed upload, throttled to
    // whole-percent changes (didSendBodyData fires per ~32 KB buffer, which
    // would otherwise flood the main actor on a 500 MB mix).
    private final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate {
        private let onProgress: @Sendable (Double) -> Void
        private var lastPercent = -1
        init(onProgress: @escaping @Sendable (Double) -> Void) { self.onProgress = onProgress }

        func urlSession(_ session: URLSession, task: URLSessionTask,
                        didSendBodyData bytesSent: Int64,
                        totalBytesSent: Int64,
                        totalBytesExpectedToSend: Int64) {
            guard totalBytesExpectedToSend > 0 else { return }
            let percent = Int(Double(totalBytesSent) / Double(totalBytesExpectedToSend) * 100)
            guard percent != lastPercent else { return }
            lastPercent = percent
            onProgress(Double(percent) / 100)
        }
    }

    /// Streamed upload from a local file. Requires a signed-in session: the
    /// storage INSERT policies are moving to authenticated-only (migration
    /// 029), so falling back to the anon key would fail with a 403 that the
    /// 401-only retry can never heal. Refreshing up front also gives the token
    /// a full hour of runway — a 401 arriving after minutes of streaming would
    /// force the whole body to be re-sent.
    private func uploadFile(fileURL: URL, filename: String, bucket: String,
                            onProgress: @escaping @Sendable (Double) -> Void) async throws -> String {
        await AuthService.shared.ensureFreshToken()
        guard let token = accessToken else { throw SupabaseError.notSignedIn }

        var request = uploadRequest(filename: filename, bucket: bucket, token: token)
        let delegate = UploadProgressDelegate(onProgress: onProgress)
        var (data, response) = try await Self.uploadSession.upload(for: request, fromFile: fileURL, delegate: delegate)

        // Token expired mid-flight: refresh and re-send once (authenticatedData
        // can't retry here because the body streams from disk, not memory).
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            await AuthService.shared.refreshSession()
            guard let newToken = accessToken else { throw SupabaseError.notSignedIn }
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            (data, response) = try await Self.uploadSession.upload(for: request, fromFile: fileURL, delegate: delegate)
        }

        try validateResponse(response, body: data)
        return "\(supabaseURL)/storage/v1/object/public/\(bucket)/\(filename)"
    }

    /// Generic in-memory upload to a Supabase Storage bucket — fine for images,
    /// wrong for audio (use the streaming variant above for anything big).
    ///
    /// Requires a signed-in session for the same reason the streaming variant
    /// does: migration 029 moves the storage INSERT policies to `authenticated`,
    /// and this used to fall back to the PUBLIC anon key when no session was
    /// loaded — which would turn into a 403 the moment 029 is applied.
    private func uploadFile(data: Data, filename: String, bucket: String) async throws -> String {
        guard let bearerToken = accessToken else { throw SupabaseError.notSignedIn }
        var request = uploadRequest(filename: filename, bucket: bucket, token: bearerToken)
        request.httpBody = data

        let (body, response) = try await authenticatedData(for: request)
        try validateResponse(response, body: body)

        // Build and return the public URL for the uploaded file
        let publicURL = "\(supabaseURL)/storage/v1/object/public/\(bucket)/\(filename)"
        return publicURL
    }

    /// Shared request shape for storage object POSTs.
    private func uploadRequest(filename: String, bucket: String, token: String) -> URLRequest {
        let path = "/storage/v1/object/\(bucket)/\(filename)"
        let url = URL(string: "\(supabaseURL)\(path)")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"

        // Storage API still needs the same auth headers
        request.setValue(supabaseKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        // Guess content type from file extension
        request.setValue(guessContentType(for: filename), forHTTPHeaderField: "Content-Type")

        // If the file already exists, allow overwriting it
        request.setValue("true", forHTTPHeaderField: "x-upsert")
        return request
    }

    // MARK: - Authenticated Request with Auto-Retry
    // Runs a request. If it gets a 401 (unauthorized), refreshes the token and retries once.
    // This prevents silent auth failures when the access token expires mid-session.
    func authenticatedData(for request: URLRequest) async throws -> (Data, URLResponse) {
        // First attempt with current token
        let (data, response) = try await URLSession.shared.data(for: request)

        // If we got a 401, the access token probably expired
        guard let http = response as? HTTPURLResponse, http.statusCode == 401 else {
            return (data, response)
        }

        // Try refreshing the token (AuthService is @MainActor)
        await AuthService.shared.refreshSession()

        // Rebuild the request with the new token
        guard let newToken = accessToken else {
            return (data, response)
        }
        var retryRequest = request
        retryRequest.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")

        // Second attempt with refreshed token
        return try await URLSession.shared.data(for: retryRequest)
    }

    // MARK: - Response Validation

    /// Check that the HTTP response is in the 200-299 "success" range.
    /// If not, throw an error with the status code — and, when the caller
    /// passes the response body, the server's own explanation (storage and
    /// PostgREST both return JSON saying exactly what was wrong; "HTTP 403"
    /// alone is undebuggable from a phone screen).
    private func validateResponse(_ response: URLResponse, body: Data? = nil) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw SupabaseError.invalidResponse
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            if let body = body,
               let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
               let message = (json["message"] ?? json["error"] ?? json["msg"]) as? String {
                throw SupabaseError.serverError(statusCode: httpResponse.statusCode, message: message)
            }
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
        case "mp4": return "audio/mp4"
        case "ogg": return "audio/ogg"
        // The version pickers allow AIFF; without this mapping those uploads
        // fell through to application/octet-stream, which the mf-audio bucket's
        // audio/* mime allow-list rejects outright.
        case "aiff", "aif": return "audio/aiff"
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
    case serverError(statusCode: Int, message: String)
    case invalidResponse
    case decodingFailed(String)
    case notSignedIn

    var errorDescription: String? {
        switch self {
        case .notFound(let message):
            return message
        case .httpError(let code):
            return "HTTP error: \(code)"
        case .serverError(let code, let message):
            return "\(message) (HTTP \(code))"
        case .invalidResponse:
            return "Invalid response from server"
        case .decodingFailed(let message):
            return message
        case .notSignedIn:
            return "Your session has expired — sign in again to upload"
        }
    }
}
