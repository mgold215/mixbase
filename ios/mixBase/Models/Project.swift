import Foundation

// MARK: - Project
// Represents a music project (a track or song you're working on).
// Maps directly to the "mb_projects" table in Supabase.
// "Codable" means Swift can convert it to/from JSON automatically.
// "Identifiable" lets SwiftUI use it in lists without extra work.

struct Project: Codable, Identifiable {

    // Unique identifier for this project (matches the UUID primary key in Supabase)
    let id: UUID

    // The name of the project / track
    var title: String

    // Optional URL pointing to the cover artwork image
    var artworkUrl: String?

    // Optional genre tag (e.g. "House", "Hip-Hop")
    var genre: String?

    // Optional tempo in beats per minute
    var bpm: Int?

    // Optional musical key (e.g. "Am", "F#")
    var keySignature: String?

    // When this project was first created
    let createdAt: Date

    // When this project was last updated
    var updatedAt: Date

    // MARK: - CodingKeys
    // This tells Swift how to map our camelCase property names
    // to the snake_case column names used in Supabase / JSON.
    enum CodingKeys: String, CodingKey {
        case id
        case title
        case artworkUrl = "artwork_url"
        case genre
        case bpm
        case keySignature = "key_signature"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}
