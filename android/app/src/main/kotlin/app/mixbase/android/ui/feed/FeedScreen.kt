package app.mixbase.android.ui.feed

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.mixbase.android.appContainer
import app.mixbase.android.playback.QueueItem
import app.mixbase.android.ui.components.ArtworkImage
import app.mixbase.android.ui.components.EmptyState
import app.mixbase.android.ui.components.ErrorText
import app.mixbase.android.ui.components.LoadErrorCard
import app.mixbase.android.ui.components.LoadingBox
import app.mixbase.android.ui.components.MbTextField
import app.mixbase.android.ui.components.MbTopBar
import app.mixbase.android.ui.components.MutedText
import app.mixbase.android.ui.components.RoundIconButton
import app.mixbase.android.ui.theme.MbColors
import app.mixbase.core.displayMessage
import app.mixbase.core.model.FeedItem
import app.mixbase.core.model.formatRelative
import kotlinx.coroutines.launch

/**
 * The mixBASE community feed — recent uploads across every artist: listen,
 * browse a project's older mixes, and leave comments. Cross-user by design.
 * Report / block are the UGC moderation tools (same routes as iOS).
 */
@Composable
fun FeedScreen(onBack: () -> Unit) {
    val container = LocalContext.current.appContainer
    val scope = rememberCoroutineScope()
    val playerState by container.player.state.collectAsState()
    val myUserId = container.session.userId

    var items by remember { mutableStateOf<List<FeedItem>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var expanded by remember { mutableStateOf<Set<String>>(emptySet()) }
    var drafts by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var postingFor by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        loading = true
        try { items = container.api.fetchFeed(); error = null } catch (e: Exception) { error = e.displayMessage }
        loading = false
    }

    LaunchedEffect(Unit) { load() }

    Column(Modifier.fillMaxSize().background(MbColors.Background)) {
        MbTopBar("mixBASE Feed", onBack = onBack) {
            IconButton(onClick = { scope.launch { load() } }) { Icon(Icons.Default.Refresh, contentDescription = "Refresh", tint = MbColors.TextMuted) }
        }
        if (notice != null) Text(notice ?: "", color = MbColors.Teal, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp))
        when {
            loading && items.isEmpty() -> LoadingBox()
            error != null && items.isEmpty() -> LoadErrorCard("Couldn't load the feed", { scope.launch { load() } }, Modifier.padding(16.dp))
            items.isEmpty() -> EmptyState("Nothing in the feed yet", "Uploads from every artist land here")
            else -> LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item { ErrorText(error) }
                items(items, key = { it.versionId }) { item ->
                    val isCurrent = playerState.current?.versionId == item.versionId
                    val isMine = item.userId == myUserId
                    var menu by remember { mutableStateOf(false) }
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(MbColors.Surface).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            ArtworkImage(item.artworkUrl, Modifier.size(56.dp), RoundedCornerShape(8.dp))
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text(item.title, color = MbColors.Text, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(item.artist, color = MbColors.Teal, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                MutedText("${item.versionLabel} · ${formatRelative(item.createdAt)}", size = 11)
                            }
                            RoundIconButton(onClick = {
                                if (isCurrent) container.player.togglePlayPause() else container.player.play(QueueItem.fromFeed(item))
                            }) {
                                Icon(if (isCurrent && playerState.isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow, contentDescription = "Play", tint = MbColors.Background)
                            }
                            if (!isMine) {
                                Box {
                                    IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "More", tint = MbColors.TextMuted) }
                                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                        DropdownMenuItem(text = { Text("Report this track") }, leadingIcon = { Icon(Icons.Default.Flag, null) }, onClick = {
                                            menu = false
                                            scope.launch {
                                                try {
                                                    container.api.reportContent("version", item.versionId)
                                                    items = items.filterNot { it.versionId == item.versionId }
                                                    notice = "Thanks — we'll review it. You won't see this track again."
                                                } catch (e: Exception) { error = e.displayMessage }
                                            }
                                        })
                                        DropdownMenuItem(text = { Text("Block ${item.artist}") }, leadingIcon = { Icon(Icons.Default.Block, null) }, onClick = {
                                            menu = false
                                            scope.launch {
                                                try {
                                                    container.api.blockUser(item.userId)
                                                    items = items.filterNot { it.userId == item.userId }
                                                    notice = "${item.artist} is blocked. Their uploads and comments are hidden."
                                                } catch (e: Exception) { error = e.displayMessage }
                                            }
                                        })
                                    }
                                }
                            }
                        }

                        if (item.older.isNotEmpty()) {
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                MutedText("Older mixes:", size = 11)
                                item.older.take(4).forEach { older ->
                                    Text(
                                        older.versionLabel, color = MbColors.Text, fontSize = 11.sp,
                                        modifier = Modifier.clip(RoundedCornerShape(50)).background(MbColors.SurfaceHigh)
                                            .clickable { container.player.play(QueueItem.fromOlderMix(item, older)) }
                                            .padding(horizontal = 8.dp, vertical = 3.dp),
                                    )
                                }
                            }
                        }

                        val isExpanded = expanded.contains(item.versionId)
                        Row(
                            Modifier.clickable { expanded = if (isExpanded) expanded - item.versionId else expanded + item.versionId },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Default.ChatBubbleOutline, contentDescription = null, tint = MbColors.TextMuted, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(6.dp))
                            MutedText("${item.comments.size} comment${if (item.comments.size == 1) "" else "s"}", size = 12)
                        }

                        if (isExpanded) {
                            item.comments.forEach { c ->
                                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(MbColors.SurfaceRaised).padding(8.dp)) {
                                    Row {
                                        Text(c.artist, color = MbColors.Teal, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                                        Spacer(Modifier.weight(1f))
                                        MutedText(formatRelative(c.createdAt), size = 10)
                                    }
                                    Text(c.comment, color = MbColors.TextBody, fontSize = 13.sp)
                                }
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                MbTextField(
                                    drafts[item.versionId] ?: "",
                                    { drafts = drafts + (item.versionId to it) },
                                    placeholder = "Leave a comment…",
                                    modifier = Modifier.weight(1f),
                                    enabled = postingFor != item.versionId,
                                )
                                IconButton(
                                    enabled = !(drafts[item.versionId].isNullOrBlank()) && postingFor == null,
                                    onClick = {
                                        val text = drafts[item.versionId]?.trim().orEmpty()
                                        if (text.isEmpty()) return@IconButton
                                        postingFor = item.versionId
                                        scope.launch {
                                            try {
                                                val saved = container.api.postFeedComment(item.versionId, text)
                                                items = items.map { if (it.versionId == item.versionId) it.copy(comments = it.comments + saved) else it }
                                                drafts = drafts - item.versionId
                                            } catch (e: Exception) { error = e.displayMessage }
                                            postingFor = null
                                        }
                                    },
                                ) { Icon(Icons.Default.Send, contentDescription = "Post", tint = MbColors.Teal) }
                            }
                        }
                    }
                }
            }
        }
    }
}
