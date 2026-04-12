import Foundation

// MARK: - Collection
// Represents a playlist, EP, or album that groups multiple projects together.
// Maps to the "mb_collections" table in Supabase.

struct Collection: Codable, Identifiable {

    let id: UUID
    var title: String
    var type: String         // "playlist", "ep", "album"
    var artworkUrl: String?
    var releaseDate: Date?
    var notes: String?
    let createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id, title, type, notes
        case artworkUrl = "artwork_url"
        case releaseDate = "release_date"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

// MARK: - CollectionItem
// A single entry linking a project to a collection, with a position for ordering.
// Maps to the "mb_collection_items" table in Supabase.

struct CollectionItem: Codable, Identifiable {

    let id: UUID
    let collectionId: UUID
    let projectId: UUID
    var position: Int
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id, position
        case collectionId = "collection_id"
        case projectId = "project_id"
        case createdAt = "created_at"
    }
}
