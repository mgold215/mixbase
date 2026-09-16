package app.mixbase.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.mixbase.android.playback.PlayerState
import app.mixbase.android.ui.theme.MbColors

/**
 * Compact now-playing bar floating above the tab bar on every tab except the
 * full Player — leaving the Player "minimizes" playback like the web's mini
 * bar. A thin progress hairline runs along the top edge.
 */
@Composable
fun MiniPlayerBar(state: PlayerState, onTap: () -> Unit, onTogglePlay: () -> Unit, onNext: () -> Unit, modifier: Modifier = Modifier) {
    val item = state.current ?: return
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MbColors.SurfaceRaised.copy(alpha = 0.98f))
            .border(1.dp, MbColors.Text.copy(alpha = 0.08f), RoundedCornerShape(12.dp))
            .clickable(onClick = onTap),
    ) {
        Box(Modifier.fillMaxWidth().height(2.dp).background(MbColors.Divider)) {
            Box(Modifier.fillMaxWidth(state.progress).height(2.dp).background(MbColors.Teal))
        }
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ArtworkImage(item.artworkUrl, modifier = Modifier.size(38.dp), shape = RoundedCornerShape(6.dp))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(item.trackName, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = MbColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    if (item.isOwn) item.versionName else "${item.artist} · ${item.versionName}",
                    fontSize = 11.sp, color = MbColors.TextMuted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            IconButton(onClick = onTogglePlay) {
                if (state.buffering) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = MbColors.Teal)
                } else {
                    Icon(if (state.isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow, contentDescription = "Play/Pause", tint = MbColors.Text)
                }
            }
            IconButton(onClick = onNext) {
                Icon(Icons.Default.SkipNext, contentDescription = "Next", tint = MbColors.Text.copy(alpha = 0.7f))
            }
        }
    }
}
