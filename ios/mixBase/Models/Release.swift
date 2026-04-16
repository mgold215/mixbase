import Foundation

// MARK: - Release
// Represents a planned or completed music release.
// Tracks the release checklist (mastering, artwork, DSP submissions, etc.).
// Maps to the "mb_releases" table in Supabase.

struct Release: Codable, Identifiable {

    // Unique identifier for this release
    let id: UUID

    // Title of the release (single name, EP name, etc.)
    var title: String

    // The planned or actual release date (just a date, no time)
    // Stored as "yyyy-MM-dd" in the database
    var releaseDate: Date?

    // Optional link to a project — a release might be tied to one project
    var projectId: UUID?

    // Genre for this release
    var genre: String?

    // Record label name (if any)
    var label: String?

    // International Standard Recording Code — unique ID for the recording
    var isrc: String?

    // Free-form notes about this release
    var notes: String?

    // MARK: - Checklist flags
    // These booleans track whether each step in the release process is done.
    var mixingDone: Bool
    var masteringDone: Bool
    var artworkReady: Bool
    var dspSubmitted: Bool
    var socialPostsDone: Bool
    var pressReleaseDone: Bool

    // MARK: - DSP (Digital Service Provider) submission flags
    // Track which platforms you've submitted to.
    var dspSpotify: Bool
    var dspAppleMusic: Bool
    var dspTidal: Bool
    var dspBandcamp: Bool
    var dspSoundcloud: Bool
    var dspYoutube: Bool
    var dspAmazon: Bool

    // When this release record was created
    let createdAt: Date

    // When this release record was last updated
    var updatedAt: Date

    // MARK: - CodingKeys
    // Maps camelCase Swift names to snake_case Supabase column names.
    enum CodingKeys: String, CodingKey {
        case id
        case title
        case releaseDate = "release_date"
        case projectId = "project_id"
        case genre
        case label
        case isrc
        case notes
        case mixingDone = "mixing_done"
        case masteringDone = "mastering_done"
        case artworkReady = "artwork_ready"
        case dspSubmitted = "dsp_submitted"
        case socialPostsDone = "social_posts_done"
        case pressReleaseDone = "press_release_done"
        case dspSpotify = "dsp_spotify"
        case dspAppleMusic = "dsp_apple_music"
        case dspTidal = "dsp_tidal"
        case dspBandcamp = "dsp_bandcamp"
        case dspSoundcloud = "dsp_soundcloud"
        case dspYoutube = "dsp_youtube"
        case dspAmazon = "dsp_amazon"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}
