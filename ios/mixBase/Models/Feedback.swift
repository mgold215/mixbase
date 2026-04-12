import Foundation

// MARK: - Feedback
// Represents a piece of feedback left on a specific version of a track.
// Reviewers (collaborators, A&R, friends) can rate and comment.
// Maps to the "mb_feedback" table in Supabase.

struct Feedback: Codable, Identifiable {

    // Unique identifier for this feedback entry
    let id: UUID

    // Which version this feedback is about
    let versionId: UUID

    // Name of the person who left the feedback
    var reviewerName: String

    // Optional rating (e.g. 1-5 stars)
    var rating: Int?

    // The actual feedback text
    var comment: String?

    // Optional timestamp in the audio (in seconds) the feedback refers to
    // e.g. "At 0:42, the kick drum is too loud"
    var timestampSeconds: Int?

    // When this feedback was submitted
    let createdAt: Date

    // MARK: - CodingKeys
    // Maps camelCase Swift names to snake_case Supabase column names.
    enum CodingKeys: String, CodingKey {
        case id
        case versionId = "version_id"
        case reviewerName = "reviewer_name"
        case rating
        case comment
        case timestampSeconds = "timestamp_seconds"
        case createdAt = "created_at"
    }
}
