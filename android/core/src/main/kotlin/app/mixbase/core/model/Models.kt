package app.mixbase.core.model

import app.mixbase.core.json.DateOnly
import app.mixbase.core.json.Timestamp
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Row models for the Supabase tables the app reads directly over PostgREST.
// Column names are snake_case on the wire (see @SerialName); ids are plain
// lowercase UUID strings — exactly how Postgres returns them and the one
// spelling a Supabase Storage key may use (see ios/…/SupabaseService.swift
// "Storage key components" for why case matters there).

/** A music project (a track you're working on). Table: mb_projects. */
@Serializable
data class Project(
    val id: String,
    val title: String,
    @SerialName("artwork_url") val artworkUrl: String? = null,
    val genre: String? = null,
    val bpm: Int? = null,
    @SerialName("key_signature") val keySignature: String? = null,
    /** Pinned Spotify-Canvas-style visualizer loop. */
    @SerialName("visualizer_url") val visualizerUrl: String? = null,
    /** Pinned no-vocals file (owner-private, migration 035). */
    @SerialName("instrumental_url") val instrumentalUrl: String? = null,
    /** Project-level share token — /share/<token> resolves to the LATEST mix. */
    @SerialName("share_token") val shareToken: String? = null,
    @SerialName("created_at") val createdAt: Timestamp,
    @SerialName("updated_at") val updatedAt: Timestamp,
)

/**
 * One version (iteration) of a project. Table: mb_versions.
 *
 * `status` is one of [MixStatus.ALL] ("Mix", "Master", "Finished", "Released")
 * and is detected from the filename by the SERVER on upload — the app never
 * decides it (see [app.mixbase.core.api.MixbaseApi.createVersion]).
 */
@Serializable
data class Version(
    val id: String,
    @SerialName("project_id") val projectId: String,
    @SerialName("version_number") val versionNumber: Int,
    val label: String? = null,
    @SerialName("audio_url") val audioUrl: String,
    @SerialName("audio_filename") val audioFilename: String? = null,
    @SerialName("duration_seconds") val durationSeconds: Int? = null,
    @SerialName("file_size_bytes") val fileSizeBytes: Long? = null,
    val status: String = "Mix",
    @SerialName("private_notes") val privateNotes: String? = null,
    @SerialName("public_notes") val publicNotes: String? = null,
    @SerialName("change_log") val changeLog: String? = null,
    @SerialName("share_token") val shareToken: String? = null,
    /** Consent signal for share-link downloads — NOT an access control. */
    @SerialName("allow_download") val allowDownload: Boolean = false,
    @SerialName("created_at") val createdAt: Timestamp,
    @SerialName("loudness_lufs") val loudnessLufs: Double? = null,
    @SerialName("loudness_short_term_lufs") val loudnessShortTermLufs: Double? = null,
    @SerialName("sample_peak_db") val samplePeakDb: Double? = null,
) {
    /** "Mix" or "Master" — the artist's own naming wins, then status. */
    val kindName: String get() = MixStatus.kindName(label, audioFilename, status)

    /** What this row is called everywhere in the app (never "v3"). */
    val displayName: String get() = MixStatus.displayName(label, audioFilename, status, versionNumber)
}

/** A planned or completed release with its checklist. Table: mb_releases. */
@Serializable
data class Release(
    val id: String,
    val title: String,
    @SerialName("release_date") val releaseDate: DateOnly? = null,
    @SerialName("project_id") val projectId: String? = null,
    val genre: String? = null,
    val label: String? = null,
    val isrc: String? = null,
    val notes: String? = null,
    @SerialName("mixing_done") val mixingDone: Boolean = false,
    @SerialName("mastering_done") val masteringDone: Boolean = false,
    @SerialName("artwork_ready") val artworkReady: Boolean = false,
    @SerialName("dsp_submitted") val dspSubmitted: Boolean = false,
    @SerialName("social_posts_done") val socialPostsDone: Boolean = false,
    @SerialName("press_release_done") val pressReleaseDone: Boolean = false,
    @SerialName("dsp_spotify") val dspSpotify: Boolean = false,
    @SerialName("dsp_apple_music") val dspAppleMusic: Boolean = false,
    @SerialName("dsp_tidal") val dspTidal: Boolean = false,
    @SerialName("dsp_bandcamp") val dspBandcamp: Boolean = false,
    @SerialName("dsp_soundcloud") val dspSoundcloud: Boolean = false,
    @SerialName("dsp_youtube") val dspYoutube: Boolean = false,
    @SerialName("dsp_amazon") val dspAmazon: Boolean = false,
    @SerialName("created_at") val createdAt: Timestamp,
    @SerialName("updated_at") val updatedAt: Timestamp,
) {
    /** Checklist completion 0..1 — the six workflow steps. */
    val progress: Float
        get() {
            val steps = listOf(mixingDone, masteringDone, artworkReady, dspSubmitted, socialPostsDone, pressReleaseDone)
            return steps.count { it }.toFloat() / steps.size
        }
}

/** A playlist, EP, or album grouping projects. Table: mb_collections. */
@Serializable
data class Collection(
    val id: String,
    val title: String,
    val type: String = "playlist",
    @SerialName("artwork_url") val artworkUrl: String? = null,
    @SerialName("cover_url") val coverUrl: String? = null,
    @SerialName("release_date") val releaseDate: DateOnly? = null,
    val notes: String? = null,
    @SerialName("created_at") val createdAt: Timestamp,
    @SerialName("updated_at") val updatedAt: Timestamp,
)

/** Links a project into a collection. Table: mb_collection_items. */
@Serializable
data class CollectionItem(
    val id: String,
    @SerialName("collection_id") val collectionId: String,
    @SerialName("project_id") val projectId: String,
    val position: Int = 0,
    @SerialName("created_at") val createdAt: Timestamp,
)

/** Feedback / mix note on one version. Table: mb_feedback. */
@Serializable
data class Feedback(
    val id: String,
    @SerialName("version_id") val versionId: String,
    @SerialName("reviewer_name") val reviewerName: String = "",
    val rating: Int? = null,
    val comment: String? = null,
    @SerialName("timestamp_seconds") val timestampSeconds: Int? = null,
    @SerialName("created_at") val createdAt: Timestamp,
)

/**
 * One activity-timeline event. Table: mb_activity. `projectId` is nullable
 * on purpose: the web writes account-level rows with no project, and a
 * non-null field here would make the whole dashboard fail to decode.
 */
@Serializable
data class Activity(
    val id: String,
    val type: String,
    @SerialName("project_id") val projectId: String? = null,
    @SerialName("version_id") val versionId: String? = null,
    @SerialName("release_id") val releaseId: String? = null,
    val description: String? = null,
    @SerialName("created_at") val createdAt: Timestamp,
)

/** A saved visualizer video (GET /api/visualizer). Table: mb_visualizers. */
@Serializable
data class Visualizer(
    val id: String,
    @SerialName("video_url") val videoUrl: String,
    val title: String? = null,
    /** "ai" for generated loops, "youtube"/"shorts" for finished renders. */
    val kind: String? = null,
    @SerialName("project_id") val projectId: String? = null,
    @SerialName("source_image_url") val sourceImageUrl: String? = null,
    @SerialName("created_at") val createdAt: Timestamp,
)

// ── Community feed (GET /api/feed — src/lib/feed.ts) ────────────────────────

/** One feed entry: a project's newest mix from any artist on the platform. */
@Serializable
data class FeedItem(
    @SerialName("version_id") val versionId: String,
    @SerialName("project_id") val projectId: String,
    @SerialName("user_id") val userId: String,
    val title: String,
    val artist: String,
    @SerialName("version_label") val versionLabel: String,
    @SerialName("artwork_url") val artworkUrl: String? = null,
    @SerialName("audio_url") val audioUrl: String,
    @SerialName("created_at") val createdAt: Timestamp,
    val comments: List<FeedComment> = emptyList(),
    val older: List<OlderMix> = emptyList(),
)

@Serializable
data class FeedComment(
    val id: String,
    @SerialName("version_id") val versionId: String,
    @SerialName("user_id") val userId: String,
    val artist: String,
    val comment: String,
    @SerialName("created_at") val createdAt: Timestamp,
)

/** An earlier mix of a feed item's project. */
@Serializable
data class OlderMix(
    @SerialName("version_id") val versionId: String,
    @SerialName("version_label") val versionLabel: String,
    @SerialName("audio_url") val audioUrl: String,
    @SerialName("created_at") val createdAt: Timestamp,
)
