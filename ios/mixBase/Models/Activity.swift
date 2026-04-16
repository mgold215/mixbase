import Foundation

// MARK: - Activity
// Represents a single activity event in the app's timeline / feed.
// Examples: "New version uploaded", "Release submitted to Spotify", etc.
// Maps to the "mb_activity" table in Supabase.

struct Activity: Codable, Identifiable {

    // Unique identifier for this activity entry
    let id: UUID

    // The kind of activity — e.g. "version_created", "release_updated", "feedback_added"
    let type: String

    // Which project this activity is related to
    let projectId: UUID

    // Optional: which version this activity is about (if applicable)
    let versionId: UUID?

    // Optional: which release this activity is about (if applicable)
    let releaseId: UUID?

    // Human-readable description of what happened
    var description: String?

    // When this activity occurred
    let createdAt: Date

    // MARK: - CodingKeys
    // Maps camelCase Swift names to snake_case Supabase column names.
    enum CodingKeys: String, CodingKey {
        case id
        case type
        case projectId = "project_id"
        case versionId = "version_id"
        case releaseId = "release_id"
        case description
        case createdAt = "created_at"
    }
}
