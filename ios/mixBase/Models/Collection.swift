import Foundation

// MARK: - Collection
// Represents a playlist, EP, or album that groups multiple projects together.
// Maps to the "mb_collections" table in Supabase.

struct Collection: Codable, Identifiable {

    let id: UUID
    var title: String
    var type: String         // "playlist", "ep", "album"
    var artworkUrl: String?
    // The collection's cover image (what the web app sets via "Set as collection
    // cover" — a different column from the legacy artwork_url).
    var coverUrl: String?
    var releaseDate: Date?
    var notes: String?
    let createdAt: Date
    var updatedAt: Date
    // True for the account's THUMB DRIVE: the built-in playlist the server keeps
    // filled with every song (each playing its newest mix) — see
    // src/lib/thumb-drive.ts. Optional so a row from before migration 042
    // still decodes; read it through `isThumbDriveCollection`.
    var isThumbDrive: Bool?

    /// The account's THUMB DRIVE — can't be deleted, renamed or retyped.
    var isThumbDriveCollection: Bool { isThumbDrive == true }

    enum CodingKeys: String, CodingKey {
        case id, title, type, notes
        case artworkUrl = "artwork_url"
        case coverUrl = "cover_url"
        case releaseDate = "release_date"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case isThumbDrive = "is_thumb_drive"
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
