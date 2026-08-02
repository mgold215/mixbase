import Foundation

// MARK: - Visualizer
// A saved visualizer video (mb_visualizers table) — AI loops generated from
// artwork plus finished YouTube/Shorts renders. Anything in this library can be
// pinned to a project as its Spotify-Canvas-style visualizer.

struct Visualizer: Codable, Identifiable {

    let id: UUID

    // Public URL of the video in the mf-video bucket
    let videoUrl: String

    // Display title, e.g. "Gen-4 Turbo · 5s"
    let title: String?

    // "ai" for generated loops, "youtube"/"shorts" for finished renders
    let kind: String?

    // The project the video was generated for (it can be pinned to any project)
    let projectId: UUID?

    // The artwork image the video was generated from
    let sourceImageUrl: String?

    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case videoUrl = "video_url"
        case title
        case kind
        case projectId = "project_id"
        case sourceImageUrl = "source_image_url"
        case createdAt = "created_at"
    }
}

// MARK: - RunwayModel
// An available image-to-video model, as returned by GET /api/visualizer/runway.

struct RunwayModel: Codable, Identifiable {
    let id: String
    let label: String
    let durations: [Int]
    let ratios: [RunwayRatio]
}

struct RunwayRatio: Codable, Hashable {
    let value: String   // e.g. "720:1280"
    let label: String   // e.g. "9:16 portrait"
}
