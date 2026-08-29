import Foundation

// MARK: - MixStatus
// The version workflow: Mix → Master → Finished → Released. There is no
// hand-picked "WIP" step — a fresh upload's status is detected from its
// filename, matching the web app's parser (src/lib/mix-status.ts): the word
// "master" standing alone (so "MASTER 2.wav", "master.wav", "Master_3.aiff",
// but not "remaster" or "mastering") means the artist is mastering; anything
// else is a work-in-progress Mix.
enum MixStatus {

    static let all = ["Mix", "Master", "Finished", "Released"]

    /// Status a fresh upload should carry, from its filename alone.
    static func forUpload(filename: String?) -> String {
        guard let filename else { return "Mix" }
        let isMaster = filename.range(
            of: "(?<![a-zA-Z])master(?![a-zA-Z])",
            options: [.regularExpression, .caseInsensitive]
        ) != nil
        return isMaster ? "Master" : "Mix"
    }
}

// MARK: - Version
// Represents one version (iteration) of a music project.
// Every time you bounce a new mix, it becomes a new Version.
// Maps to the "mb_versions" table in Supabase.

struct Version: Codable, Identifiable {

    // Unique identifier for this version
    let id: UUID

    // Which project this version belongs to
    let projectId: UUID

    // Sequential number (1, 2, 3...) so you can see the order of revisions
    var versionNumber: Int

    // Optional human-readable label like "Rough Mix" or "Final Master"
    var label: String?

    // URL to the audio file stored in Supabase Storage
    var audioUrl: String

    // Original filename of the uploaded audio file
    var audioFilename: String?

    // Length of the audio in seconds
    var durationSeconds: Int?

    // File size in bytes (Int64 because audio files can be large)
    var fileSizeBytes: Int64?

    // Current status of this version — "Mix", "Master", "Finished" or
    // "Released" (see MixStatus above; detected from the filename on upload)
    var status: String

    // Notes only you can see
    var privateNotes: String?

    // Notes visible to anyone you share with
    var publicNotes: String?

    // A log of what changed in this version compared to the last
    var changeLog: String?

    // A unique token used to create shareable links
    var shareToken: String?

    // Whether the recipient of a share link can download the file
    var allowDownload: Bool

    // When this version was created
    let createdAt: Date

    // BS.1770-4 loudness columns (migration 032) — written by Master Check on
    // either platform. Optional: rows can predate the migration or simply be
    // unmeasured, and PostgREST returns null for both.
    var loudnessLufs: Double?
    var loudnessShortTermLufs: Double?
    var samplePeakDb: Double?

    // MARK: - CodingKeys
    // Maps camelCase Swift names to snake_case Supabase column names.
    enum CodingKeys: String, CodingKey {
        case id
        case projectId = "project_id"
        case versionNumber = "version_number"
        case label
        case audioUrl = "audio_url"
        case audioFilename = "audio_filename"
        case durationSeconds = "duration_seconds"
        case fileSizeBytes = "file_size_bytes"
        case status
        case privateNotes = "private_notes"
        case publicNotes = "public_notes"
        case changeLog = "change_log"
        case shareToken = "share_token"
        case allowDownload = "allow_download"
        case createdAt = "created_at"
        case loudnessLufs = "loudness_lufs"
        case loudnessShortTermLufs = "loudness_short_term_lufs"
        case samplePeakDb = "sample_peak_db"
    }
}
