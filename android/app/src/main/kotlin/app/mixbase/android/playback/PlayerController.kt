package app.mixbase.android.playback

import android.content.ComponentName
import android.content.Context
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Repeat behaviour for the queue — mirrors the iOS LoopMode. */
enum class LoopMode { OFF, ALL, ONE }

data class PlayerState(
    val current: QueueItem? = null,
    /** User intends playback (drives the play/pause icon). */
    val isPlaying: Boolean = false,
    /** Loading/stalling with intent to play — show a spinner, not a fake "playing". */
    val buffering: Boolean = false,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val loopMode: LoopMode = LoopMode.OFF,
    val isShuffled: Boolean = false,
    val queue: List<QueueItem> = emptyList(),
    val currentIndex: Int = -1,
    val connected: Boolean = false,
) {
    val progress: Float get() = if (durationMs > 0) (positionMs.toFloat() / durationMs).coerceIn(0f, 1f) else 0f
}

/**
 * The app-side face of playback: a MediaController bound to [PlaybackService],
 * exposed as one StateFlow the UI observes. Port of the iOS AudioService,
 * minus the queue bookkeeping that ExoPlayer's playlist now owns.
 */
class PlayerController(private val context: Context, private val scope: CoroutineScope) {

    private val _state = MutableStateFlow(PlayerState())
    val state: StateFlow<PlayerState> = _state.asStateFlow()

    /** The profile's artist name — the notification/Bluetooth artist slot for your own tracks. */
    var artistName: String = ""

    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private var ticker: Job? = null

    /** Work queued while the controller is still connecting. */
    private val pending = ArrayDeque<(MediaController) -> Unit>()

    private val listener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            syncFromPlayer(player)
        }
    }

    /** Connect to the playback service. Idempotent; call from the Activity. */
    fun connect() {
        if (controllerFuture != null) return
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val future = MediaController.Builder(context, token).buildAsync()
        controllerFuture = future
        future.addListener({
            val c = try { future.get() } catch (e: Exception) { controllerFuture = null; return@addListener }
            controller = c
            c.addListener(listener)
            syncFromPlayer(c)
            _state.value = _state.value.copy(connected = true)
            startTicker()
            while (pending.isNotEmpty()) pending.removeFirst().invoke(c)
        }, ContextCompat.getMainExecutor(context))
    }

    fun release() {
        ticker?.cancel()
        ticker = null
        controller?.removeListener(listener)
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controller = null
        controllerFuture = null
        _state.value = _state.value.copy(connected = false)
    }

    private fun withController(block: (MediaController) -> Unit) {
        val c = controller
        if (c != null) block(c) else { pending.addLast(block); connect() }
    }

    // ── Playback controls ───────────────────────────────────────────────────

    /**
     * Play [item]. With [queue] the whole list becomes the playlist (the
     * Player screen's order); without it, an item from a project already in
     * the queue REPLACES that project's entry (play an older mix without
     * losing your place), otherwise it's appended.
     */
    fun play(item: QueueItem, queue: List<QueueItem>? = null) = withController { c ->
        if (queue != null && queue.isNotEmpty()) {
            val items = if (queue.any { it.versionId == item.versionId }) queue else listOf(item) + queue
            val index = items.indexOfFirst { it.versionId == item.versionId }
            c.setMediaItems(items.map { it.toMediaItem() }, index, 0L)
        } else {
            val existing = currentQueue(c)
            val sameVersion = existing.indexOfFirst { it.versionId == item.versionId }
            val sameProject = existing.indexOfFirst { it.projectId == item.projectId && item.isOwn && it.isOwn }
            when {
                sameVersion >= 0 -> c.seekTo(sameVersion, 0L)
                sameProject >= 0 -> { c.replaceMediaItem(sameProject, item.toMediaItem()); c.seekTo(sameProject, 0L) }
                existing.isEmpty() -> c.setMediaItems(listOf(item.toMediaItem()), 0, 0L)
                else -> { c.addMediaItem(item.toMediaItem()); c.seekTo(c.mediaItemCount - 1, 0L) }
            }
        }
        c.prepare()
        c.play()
        _state.value = _state.value.copy(current = item, isPlaying = true, buffering = true, positionMs = 0, durationMs = 0)
    }

    /** Replace the playlist without changing what's playing (e.g. after the library reloads). */
    fun setQueue(items: List<QueueItem>) = withController { c ->
        val current = _state.value.current
        val index = items.indexOfFirst { it.versionId == current?.versionId }
        if (index >= 0 && current != null) {
            val position = c.currentPosition
            val wasPlaying = c.playWhenReady
            c.setMediaItems(items.map { it.toMediaItem() }, index, position)
            c.prepare()
            c.playWhenReady = wasPlaying
        } else if (current == null) {
            c.setMediaItems(items.map { it.toMediaItem() })
            c.prepare()
        }
    }

    fun togglePlayPause() = withController { c -> if (c.isPlaying || c.playWhenReady) pause() else resume() }

    fun pause() = withController { c ->
        c.pause()
        _state.value = _state.value.copy(isPlaying = false, buffering = false)
    }

    fun resume() = withController { c ->
        if (c.mediaItemCount == 0) return@withController
        if (c.playbackState == Player.STATE_IDLE) c.prepare()
        if (c.playbackState == Player.STATE_ENDED) c.seekTo(0L)
        c.play()
        _state.value = _state.value.copy(isPlaying = true)
    }

    fun next() = withController { c ->
        if (c.hasNextMediaItem()) c.seekToNextMediaItem() else if (c.mediaItemCount > 0) c.seekTo(0, 0L)
        c.play()
    }

    /** Restart when more than 3s in (like every music app), otherwise the previous track. */
    fun prev() = withController { c ->
        if (c.currentPosition > 3_000 || !c.hasPreviousMediaItem()) c.seekTo(0L) else c.seekToPreviousMediaItem()
        c.play()
    }

    fun seekTo(positionMs: Long) = withController { c ->
        c.seekTo(positionMs.coerceIn(0, maxOf(0, c.duration.takeIf { it != C.TIME_UNSET } ?: positionMs)))
        _state.value = _state.value.copy(positionMs = positionMs)
    }

    fun seekToFraction(fraction: Float) {
        val d = _state.value.durationMs
        if (d > 0) seekTo((d * fraction.coerceIn(0f, 1f)).toLong())
    }

    fun cycleLoopMode() = withController { c ->
        c.repeatMode = when (c.repeatMode) {
            Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
            Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
            else -> Player.REPEAT_MODE_OFF
        }
    }

    fun toggleShuffle() = withController { c -> c.shuffleModeEnabled = !c.shuffleModeEnabled }

    fun moveQueueItem(from: Int, to: Int) = withController { c -> c.moveMediaItem(from, to) }

    fun removeQueueItem(index: Int) = withController { c -> c.removeMediaItem(index) }

    /** Stop and forget everything (sign-out). */
    fun stopAndClear() {
        controller?.let { c ->
            c.stop()
            c.clearMediaItems()
        }
        _state.value = PlayerState(connected = _state.value.connected)
    }

    // ── State sync ──────────────────────────────────────────────────────────

    private fun currentQueue(c: Player): List<QueueItem> =
        (0 until c.mediaItemCount).mapNotNull { QueueItem.fromMediaItem(c.getMediaItemAt(it)) }

    private fun syncFromPlayer(p: Player) {
        val duration = p.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: 0L
        val current = p.currentMediaItem?.let { QueueItem.fromMediaItem(it) }
        _state.value = _state.value.copy(
            current = current,
            isPlaying = p.playWhenReady && p.playbackState != Player.STATE_ENDED && p.playbackState != Player.STATE_IDLE,
            buffering = p.playWhenReady && p.playbackState == Player.STATE_BUFFERING,
            positionMs = p.currentPosition.coerceAtLeast(0),
            durationMs = duration,
            loopMode = when (p.repeatMode) {
                Player.REPEAT_MODE_ALL -> LoopMode.ALL
                Player.REPEAT_MODE_ONE -> LoopMode.ONE
                else -> LoopMode.OFF
            },
            isShuffled = p.shuffleModeEnabled,
            queue = currentQueue(p),
            currentIndex = p.currentMediaItemIndex,
        )
    }

    private fun startTicker() {
        ticker?.cancel()
        ticker = scope.launch {
            while (isActive) {
                controller?.let { c ->
                    if (c.mediaItemCount > 0) {
                        val duration = c.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: 0L
                        _state.value = _state.value.copy(positionMs = c.currentPosition.coerceAtLeast(0), durationMs = duration)
                    }
                }
                delay(500)
            }
        }
    }
}
