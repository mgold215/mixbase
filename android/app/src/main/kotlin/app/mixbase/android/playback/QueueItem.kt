package app.mixbase.android.playback

import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import app.mixbase.core.model.FeedItem
import app.mixbase.core.model.OlderMix
import app.mixbase.core.model.Project
import app.mixbase.core.model.Version

/**
 * One playable entry — everything the player and the notification need to
 * start a track. Built from your own projects (Home/Projects/Player) or from
 * another artist's feed entry (synthetic, `isOwn = false`).
 */
data class QueueItem(
    /** mb_versions.id — the MediaItem id. */
    val versionId: String,
    val projectId: String,
    val trackName: String,
    val versionName: String,
    val artist: String,
    val audioUrl: String,
    val artworkUrl: String?,
    /** The project's pinned Spotify-Canvas-style loop, if any. */
    val visualizerUrl: String?,
    /** Version share token, else the project token (resolves to the latest mix). */
    val shareToken: String?,
    val isOwn: Boolean,
) {
    val shareUrl: String? get() = shareToken?.let { "https://mixbase.app/share/$it" }

    fun toMediaItem(): MediaItem {
        val extras = Bundle().apply {
            putString(EXTRA_PROJECT_ID, projectId)
            putString(EXTRA_VERSION_NAME, versionName)
            putString(EXTRA_VISUALIZER_URL, visualizerUrl)
            putString(EXTRA_SHARE_TOKEN, shareToken)
            putString(EXTRA_AUDIO_URL, audioUrl)
            putBoolean(EXTRA_IS_OWN, isOwn)
        }
        val metadata = MediaMetadata.Builder()
            .setTitle(trackName)
            .setArtist(artist.ifEmpty { "mixBase" })
            .setAlbumTitle(versionName)
            .setArtworkUri(artworkUrl?.let { Uri.parse(it) })
            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
            .setIsBrowsable(false)
            .setIsPlayable(true)
            .setExtras(extras)
            .build()
        return MediaItem.Builder()
            .setMediaId(versionId)
            .setUri(audioUrl)
            // localConfiguration (the URI) is not bundled across the session
            // boundary; the service rebuilds it from requestMetadata.mediaUri.
            .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(Uri.parse(audioUrl)).build())
            .setMediaMetadata(metadata)
            .build()
    }

    companion object {
        private const val EXTRA_PROJECT_ID = "projectId"
        private const val EXTRA_VERSION_NAME = "versionName"
        private const val EXTRA_VISUALIZER_URL = "visualizerUrl"
        private const val EXTRA_SHARE_TOKEN = "shareToken"
        private const val EXTRA_AUDIO_URL = "audioUrl"
        private const val EXTRA_IS_OWN = "isOwn"

        fun fromVersion(project: Project, version: Version, artist: String): QueueItem = QueueItem(
            versionId = version.id,
            projectId = project.id,
            trackName = project.title,
            versionName = version.displayName,
            artist = artist,
            audioUrl = version.audioUrl,
            artworkUrl = project.artworkUrl,
            visualizerUrl = project.visualizerUrl,
            shareToken = version.shareToken ?: project.shareToken,
            isOwn = true,
        )

        fun fromFeed(item: FeedItem): QueueItem = QueueItem(
            versionId = item.versionId,
            projectId = item.projectId,
            trackName = item.title,
            versionName = item.versionLabel,
            artist = item.artist,
            audioUrl = item.audioUrl,
            artworkUrl = item.artworkUrl,
            visualizerUrl = null,
            shareToken = null,
            isOwn = false,
        )

        fun fromOlderMix(item: FeedItem, older: OlderMix): QueueItem = fromFeed(item).copy(
            versionId = older.versionId,
            versionName = older.versionLabel,
            audioUrl = older.audioUrl,
        )

        /** Rebuilds the item from a MediaItem coming back out of the player. */
        fun fromMediaItem(item: MediaItem): QueueItem? {
            val md = item.mediaMetadata
            val extras = md.extras ?: return null
            val audioUrl = extras.getString(EXTRA_AUDIO_URL)
                ?: item.requestMetadata.mediaUri?.toString()
                ?: item.localConfiguration?.uri?.toString()
                ?: return null
            return QueueItem(
                versionId = item.mediaId,
                projectId = extras.getString(EXTRA_PROJECT_ID) ?: "",
                trackName = md.title?.toString() ?: "Unknown Track",
                versionName = extras.getString(EXTRA_VERSION_NAME) ?: md.albumTitle?.toString() ?: "",
                artist = md.artist?.toString() ?: "",
                audioUrl = audioUrl,
                artworkUrl = md.artworkUri?.toString(),
                visualizerUrl = extras.getString(EXTRA_VISUALIZER_URL),
                shareToken = extras.getString(EXTRA_SHARE_TOKEN),
                isOwn = extras.getBoolean(EXTRA_IS_OWN, false),
            )
        }
    }
}
