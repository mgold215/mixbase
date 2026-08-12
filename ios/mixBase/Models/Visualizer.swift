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

// (RunwayModel/RunwayRatio removed with the in-app generator — visualizer
// generation is web-only; see MixbaseAPI's Visualizers note re Guideline 3.1.1.)
