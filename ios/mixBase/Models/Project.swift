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

    // Optional pinned visualizer video URL (Spotify-Canvas-style loop)
    var visualizerUrl: String?

    // Optional pinned instrumental (no-vocals) audio URL — one per project,
    // stored beside the mixes in mf-audio (migration 035). Owner-private:
    // never part of share pages or the feed.
    var instrumentalUrl: String?

    // Project-level share token — /share/<token> resolves it to the LATEST
    // mix, which is why the web player shares this rather than a version
    // token. The Now Playing share button falls back to it when the playing
    // Version carries no token of its own (feed playback builds synthetic
    // Versions with shareToken nil, even for your own songs).
    var shareToken: String?

    // When this project was first created
    let createdAt: Date

    // When this project was last updated
    var updatedAt: Date

    // ── Decode-only columns ────────────────────────────────────────────────
    // Read from PostgREST but NEVER written back: SupabaseService.updateProject
    // PATCHes the whole encoded Project, and both of these are owned by the
    // server (see encode(to:) below).

    // The lettered cover (artist/title baked in) — written by the web's
    // Finalize step and by Cassette Studio; cleared server-side whenever
    // artwork_url changes through PATCH /api/projects/[id].
    var finalizedArtworkUrl: String?

    // Optional horizontal (16:9) visualizer pin (migration 020). Pinned via
    // PATCH /api/projects/[id], which verifies the video is the user's own.
    var visualizerWideUrl: String?

    /// The cover to SHOW: the lettered render when there is one, else the raw
    /// source. Generators keep using `artworkUrl` (the clean source image).
    var displayArtworkUrl: String? {
        finalizedArtworkUrl ?? artworkUrl
    }

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
        case visualizerUrl = "visualizer_url"
        case instrumentalUrl = "instrumental_url"
        case shareToken = "share_token"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case finalizedArtworkUrl = "finalized_artwork_url"
        case visualizerWideUrl = "visualizer_wide_url"
    }

    // MARK: - Encoding
    // Decoding stays synthesized (every key above; the optionals tolerate a
    // missing column). Encoding is written out so it reproduces EXACTLY what
    // the synthesized encoder sent before the two decode-only columns existed
    // — encode for non-optionals, encodeIfPresent for optionals, same order —
    // and deliberately leaves out finalized_artwork_url and visualizer_wide_url.
    // A whole-object PATCH must never write those: a stale local copy would
    // resurrect a cleared finalized cover or overwrite a wide pin set elsewhere.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(title, forKey: .title)
        try container.encodeIfPresent(artworkUrl, forKey: .artworkUrl)
        try container.encodeIfPresent(genre, forKey: .genre)
        try container.encodeIfPresent(bpm, forKey: .bpm)
        try container.encodeIfPresent(keySignature, forKey: .keySignature)
        try container.encodeIfPresent(visualizerUrl, forKey: .visualizerUrl)
        try container.encodeIfPresent(instrumentalUrl, forKey: .instrumentalUrl)
        try container.encodeIfPresent(shareToken, forKey: .shareToken)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
    }
}
