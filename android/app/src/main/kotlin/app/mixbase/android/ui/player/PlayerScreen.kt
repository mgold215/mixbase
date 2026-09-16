package app.mixbase.android.ui.player

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.QueueMusic
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.RepeatOne
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.mixbase.android.appContainer
import app.mixbase.android.playback.LoopMode
import app.mixbase.android.playback.QueueItem
import app.mixbase.android.ui.components.ArtworkImage
import app.mixbase.android.ui.components.EmptyState
import app.mixbase.android.ui.components.LoadingBox
import app.mixbase.android.ui.components.MbTopBar
import app.mixbase.android.ui.components.MutedText
import app.mixbase.android.ui.components.RoundIconButton
import app.mixbase.android.ui.theme.MbColors
import app.mixbase.android.ui.util.shareText
import app.mixbase.core.model.formatClock
import coil.compose.AsyncImage

/**
 * The Player tab. With nothing loaded it lists every track (newest mix per
 * project) so you can start listening; once a track plays it becomes the
 * Now Playing screen with the queue reachable from the top bar.
 */
@Composable
fun PlayerScreen() {
    val context = LocalContext.current
    val container = context.appContainer
    val player = container.player
    val state by player.state.collectAsState()
    val library by container.library.state.collectAsState()
    var showQueue by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { container.library.refreshIfStale() }

    val allTracks = remember(library.projects, library.versionsByProject, player.artistName) { container.library.queueItems(player.artistName) }

    Box(Modifier.fillMaxSize().background(MbColors.Background)) {
        val current = state.current
        when {
            showQueue -> QueueList(state.queue, state.currentIndex, onClose = { showQueue = false }, onPlay = { player.play(it) }, onRemove = { player.removeQueueItem(it) })
            current == null -> TrackList(allTracks, library.isLoading && !library.hasLoaded, onPlay = { item -> player.play(item, allTracks) })
            else -> NowPlaying(current, state.isPlaying, state.buffering, state.positionMs, state.durationMs, state.loopMode, state.isShuffled, onShowQueue = { showQueue = true })
        }
    }
}

@Composable
private fun TrackList(tracks: List<QueueItem>, loading: Boolean, onPlay: (QueueItem) -> Unit) {
    Column(Modifier.fillMaxSize()) {
        MbTopBar("Player")
        when {
            loading -> LoadingBox()
            tracks.isEmpty() -> EmptyState("Nothing to play yet", "Upload a mix from Projects and it appears here")
            else -> LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                itemsIndexed(tracks, key = { _, it -> it.versionId }) { _, item ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(MbColors.Surface).clickable { onPlay(item) }.padding(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        ArtworkImage(item.artworkUrl, Modifier.size(52.dp))
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(item.trackName, color = MbColors.Text, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            MutedText(item.versionName, size = 12)
                        }
                        Icon(Icons.Default.PlayArrow, contentDescription = "Play", tint = MbColors.Teal)
                    }
                }
            }
        }
    }
}

@Composable
private fun NowPlaying(
    item: QueueItem,
    isPlaying: Boolean,
    buffering: Boolean,
    positionMs: Long,
    durationMs: Long,
    loopMode: LoopMode,
    shuffled: Boolean,
    onShowQueue: () -> Unit,
) {
    val context = LocalContext.current
    val player = context.appContainer.player
    var dragging by remember { mutableStateOf(false) }
    var dragValue by remember { mutableFloatStateOf(0f) }
    val progress = if (durationMs > 0) positionMs.toFloat() / durationMs else 0f

    Box(Modifier.fillMaxSize()) {
        // Ambient backdrop: the artwork blurred behind everything.
        if (item.artworkUrl != null) {
            AsyncImage(
                model = item.artworkUrl, contentDescription = null, contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize().blur(60.dp).alpha(0.35f),
            )
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Transparent, MbColors.Background))))
        }

        Column(Modifier.fillMaxSize()) {
            MbTopBar(if (item.isOwn) "Now Playing" else "From the Feed") {
                item.shareUrl?.let { url ->
                    IconButton(onClick = { context.shareText(url, "Share ${item.trackName}") }) {
                        Icon(Icons.Default.Share, contentDescription = "Share", tint = MbColors.Text)
                    }
                }
                IconButton(onClick = onShowQueue) { Icon(Icons.Default.QueueMusic, contentDescription = "Up next", tint = MbColors.Text) }
            }

            Column(
                Modifier.fillMaxSize().padding(horizontal = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                ArtworkImage(item.artworkUrl, Modifier.fillMaxWidth().aspectRatio(1f), shape = RoundedCornerShape(20.dp), placeholderIconSize = 72.dp)
                Spacer(Modifier.height(28.dp))
                Text(item.trackName, color = MbColors.Text, fontSize = 22.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
                MutedText(listOf(item.artist.ifEmpty { "mixBase" }, item.versionName).joinToString(" · "), size = 14)
                Spacer(Modifier.height(20.dp))

                Slider(
                    value = if (dragging) dragValue else progress,
                    onValueChange = { dragging = true; dragValue = it },
                    onValueChangeFinished = { player.seekToFraction(dragValue); dragging = false },
                    colors = SliderDefaults.colors(thumbColor = MbColors.Teal, activeTrackColor = MbColors.Teal, inactiveTrackColor = MbColors.Divider),
                )
                Row(Modifier.fillMaxWidth()) {
                    MutedText(formatClock(((if (dragging) dragValue * durationMs else positionMs.toFloat()) / 1000).toLong()), size = 12)
                    Spacer(Modifier.weight(1f))
                    MutedText(formatClock(durationMs / 1000), size = 12)
                }
                Spacer(Modifier.height(12.dp))

                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { player.toggleShuffle() }) {
                        Icon(Icons.Default.Shuffle, contentDescription = "Shuffle", tint = if (shuffled) MbColors.Teal else MbColors.TextMuted)
                    }
                    IconButton(onClick = { player.prev() }) { Icon(Icons.Default.SkipPrevious, contentDescription = "Previous", tint = MbColors.Text, modifier = Modifier.size(34.dp)) }
                    RoundIconButton(onClick = { player.togglePlayPause() }, size = 68.dp) {
                        if (buffering) {
                            CircularProgressIndicator(Modifier.size(28.dp), color = MbColors.Background, strokeWidth = 3.dp)
                        } else {
                            Icon(if (isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow, contentDescription = "Play/Pause", tint = MbColors.Background, modifier = Modifier.size(38.dp))
                        }
                    }
                    IconButton(onClick = { player.next() }) { Icon(Icons.Default.SkipNext, contentDescription = "Next", tint = MbColors.Text, modifier = Modifier.size(34.dp)) }
                    IconButton(onClick = { player.cycleLoopMode() }) {
                        Icon(
                            if (loopMode == LoopMode.ONE) Icons.Default.RepeatOne else Icons.Default.Repeat,
                            contentDescription = "Repeat",
                            tint = if (loopMode == LoopMode.OFF) MbColors.TextMuted else MbColors.Teal,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun QueueList(queue: List<QueueItem>, currentIndex: Int, onClose: () -> Unit, onPlay: (QueueItem) -> Unit, onRemove: (Int) -> Unit) {
    Column(Modifier.fillMaxSize()) {
        MbTopBar("Up Next", onBack = onClose)
        if (queue.isEmpty()) {
            EmptyState("Queue is empty")
        } else {
            LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                itemsIndexed(queue, key = { i, it -> "${it.versionId}-$i" }) { index, item ->
                    val isCurrent = index == currentIndex
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                            .background(if (isCurrent) MbColors.Teal.copy(alpha = 0.10f) else MbColors.Surface)
                            .clickable { onPlay(item) }.padding(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        ArtworkImage(item.artworkUrl, Modifier.size(44.dp))
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(item.trackName, color = if (isCurrent) MbColors.Teal else MbColors.Text, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            MutedText(item.versionName, size = 12)
                        }
                        if (!isCurrent) {
                            IconButton(onClick = { onRemove(index) }) { Icon(Icons.Default.Close, contentDescription = "Remove", tint = MbColors.TextMuted) }
                        }
                    }
                }
            }
        }
    }
}
