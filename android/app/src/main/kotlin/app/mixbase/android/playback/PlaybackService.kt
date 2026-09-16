package app.mixbase.android.playback

import android.app.PendingIntent
import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import app.mixbase.android.MainActivity
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * Background playback host. ExoPlayer + a MediaSession gives us the lock
 * screen / notification controls, Bluetooth (AVRCP) metadata, audio focus
 * (pause for calls, duck for notifications) and "becoming noisy" handling
 * (pause when headphones are unplugged) — the AVAudioSession work the iOS
 * AudioService does by hand.
 *
 * Playback POLICY (queue, repeat, shuffle) lives in ExoPlayer's playlist, so
 * it keeps working on every screen and after the activity is gone.
 */
class PlaybackService : MediaSessionService() {

    private var mediaSession: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        val player = ExoPlayer.Builder(this)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()

        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                action = Intent.ACTION_VIEW
                data = android.net.Uri.parse("mixbase://player")
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        mediaSession = MediaSession.Builder(this, player)
            .setCallback(SessionCallback())
            .setSessionActivity(openApp)
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    /** Swiped away from Recents: keep playing if we are, otherwise shut down. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = mediaSession?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        mediaSession?.run {
            player.release()
            release()
        }
        mediaSession = null
        super.onDestroy()
    }

    private class SessionCallback : MediaSession.Callback {
        /**
         * MediaItems arrive from the controller WITHOUT their URI (Media3 does
         * not bundle localConfiguration across the session boundary), so
         * rebuild each one from the requestMetadata.mediaUri we set in
         * [QueueItem.toMediaItem].
         */
        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>,
        ): ListenableFuture<MutableList<MediaItem>> {
            val resolved = mediaItems.map { item ->
                val uri = item.requestMetadata.mediaUri
                if (item.localConfiguration == null && uri != null) item.buildUpon().setUri(uri).build() else item
            }.toMutableList()
            return Futures.immediateFuture(resolved)
        }
    }
}
