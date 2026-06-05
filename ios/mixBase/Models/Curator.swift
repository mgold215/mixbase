import Foundation

// MARK: - Curator
// A playlist curator, label, blog, or other contact that accepts submissions.
// Maps to the `sb_curators` table in Supabase.

struct Curator: Codable, Identifiable {
    let id: UUID
    let userId: String?
    var name: String
    var type: String?          // playlist, label, blog, radio, influencer, other
    var platform: String?
    var genres: [String]?
    var contactMethod: String?  // email, instagram, twitter, soundcloud, form, other
    var contactValue: String?
    var audienceSize: Int?
    var acceptsSubmissions: Bool
    var guidelines: String?
    var confidence: String      // VERIFIED or UNVERIFIED
    var sourceUrl: String?
    var notes: String?
    var lastContacted: Date?
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case name, type, platform, genres
        case contactMethod = "contact_method"
        case contactValue = "contact_value"
        case audienceSize = "audience_size"
        case acceptsSubmissions = "accepts_submissions"
        case guidelines, confidence
        case sourceUrl = "source_url"
        case notes
        case lastContacted = "last_contacted"
        case createdAt = "created_at"
    }
}

// MARK: - Submission
// A record of a song pitched to a curator.
// Maps to the `sb_submissions` table in Supabase.

struct Submission: Codable, Identifiable {
    let id: UUID
    let userId: String
    var projectId: String?
    var versionId: String?
    var curatorId: String?
    var channel: String?       // email, form, social, spotify
    var message: String?
    var shareUrl: String?
    var status: String         // draft, sent, opened, responded, accepted, rejected, no_response
    var responseNotes: String?
    var sentAt: Date?
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case projectId = "project_id"
        case versionId = "version_id"
        case curatorId = "curator_id"
        case channel, message
        case shareUrl = "share_url"
        case status
        case responseNotes = "response_notes"
        case sentAt = "sent_at"
        case createdAt = "created_at"
    }
}
