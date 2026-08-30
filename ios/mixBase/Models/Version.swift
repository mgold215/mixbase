import Foundation

// MARK: - MixStatus
// The version workflow: Mix → Master → Finished → Released. There is no
// hand-picked "WIP" step — a fresh upload's status is detected from its
// filename by the SERVER (src/lib/mix-status.ts, applied in POST
// /api/versions): the word "master" standing alone (so "MASTER 2.wav",
// "master.wav", "Master_3.aiff", but not "remaster" or "mastering") means the
// artist is mastering; anything else is a work-in-progress Mix.
//
// That parser deliberately does NOT have a copy here. It used to, and the
// upload path called it — which is how the phone ended up deciding a row's
// status, label and download consent for itself. One authority, server-side:
// no client gets to invent a fifth status, and a rule change ships without
// waiting on an App Store review.
enum MixStatus {

    static let all = ["Mix", "Master", "Finished", "Released"]
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

    // MARK: - Display naming (mirror of src/lib/mix-status.ts — DISPLAY ONLY)
    // Nothing in the UI is called "v3" or "Version 3": the artist's stored
    // label wins, then the mix/master identity parsed from their own filename
    // ("MASTER 2.wav" → "MASTER 2"), then "Mix N"/"Master N" in upload order —
    // the same chain the web's versionDisplayLabel applies. This mirrors the
    // server parser for PRESENTATION only; the upload path still sends no
    // label or status, and the server remains the one authority for what a
    // row IS (see the MixStatus note above).

    // Standalone-word tokens: "remaster"/"mixdown" must not match, "MASTER2",
    // "mix_3" and "Mix 3.1" must. Master is tested first so a name carrying
    // both ("mix master 2") reads as the master it is.
    private static let kindTokens: [(kind: String, regex: NSRegularExpression)] = [
        ("Master", try! NSRegularExpression(pattern: "(?:^|[^a-z])master(?:[\\s._#-]*(\\d+(?:\\.\\d+)*))?(?![a-z])", options: [.caseInsensitive])),
        ("Mix", try! NSRegularExpression(pattern: "(?:^|[^a-z])mix(?:[\\s._#-]*(\\d+(?:\\.\\d+)*))?(?![a-z])", options: [.caseInsensitive])),
    ]

    // "MASTER 2.wav" → (kind: "Master", label: "MASTER 2"); a bare
    // "master.wav" → (kind: "Master", label: nil); unparseable → nil.
    private static func parseName(_ name: String?) -> (kind: String, label: String?)? {
        guard let name, !name.isEmpty else { return nil }
        let base = name.replacingOccurrences(of: "\\.[^.]+$", with: "", options: .regularExpression)
        for (kind, regex) in kindTokens {
            let range = NSRange(base.startIndex..., in: base)
            guard let match = regex.firstMatch(in: base, options: [], range: range) else { continue }
            if match.numberOfRanges > 1, let numberRange = Range(match.range(at: 1), in: base) {
                return (kind, "\(kind.uppercased()) \(base[numberRange])")
            }
            return (kind, nil)
        }
        return nil
    }

    // "Mix" or "Master" — the artist's naming wins; rows with no parseable
    // name fall back to status, where anything past Mix is master-stage work.
    var kindName: String {
        if let parsed = Version.parseName(label) ?? Version.parseName(audioFilename) {
            return parsed.kind
        }
        switch status {
        case "Master", "Mix/Master", "Finished", "Released": return "Master"
        default: return "Mix"
        }
    }

    // What this row is called everywhere in the app.
    var displayName: String {
        if let label, !label.isEmpty { return label }
        if let parsedLabel = Version.parseName(audioFilename)?.label { return parsedLabel }
        return "\(kindName) \(versionNumber)"
    }

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
