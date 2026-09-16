package app.mixbase.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.mixbase.android.ui.theme.MbColors
import coil.compose.AsyncImage

/** "mix" + teal "BASE" wordmark. */
@Composable
fun BrandWordmark(size: Int = 28, modifier: Modifier = Modifier) {
    Row(modifier = modifier, verticalAlignment = Alignment.Bottom) {
        Text("mix", fontSize = size.sp, fontWeight = FontWeight.Bold, color = MbColors.Text)
        Text("BASE", fontSize = size.sp, fontWeight = FontWeight.Bold, color = MbColors.Teal)
    }
}

/** Standard dark top bar with an optional back arrow and trailing actions. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MbTopBar(
    title: String,
    onBack: (() -> Unit)? = null,
    actions: @Composable () -> Unit = {},
) {
    TopAppBar(
        title = { Text(title, color = MbColors.Text, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        navigationIcon = {
            if (onBack != null) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = MbColors.Text)
                }
            }
        },
        actions = { actions() },
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = MbColors.Background,
            titleContentColor = MbColors.Text,
        ),
    )
}

/** Artwork thumbnail with the grey music-note placeholder used everywhere. */
@Composable
fun ArtworkImage(
    url: String?,
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(8.dp),
    placeholderIconSize: Dp = 20.dp,
) {
    Box(modifier = modifier.clip(shape).background(MbColors.SurfaceHigh), contentAlignment = Alignment.Center) {
        if (url != null) {
            AsyncImage(
                model = url,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Icon(Icons.Default.MusicNote, contentDescription = null, tint = MbColors.TextMuted, modifier = Modifier.size(placeholderIconSize))
        }
    }
}

/**
 * Pill badge for a version status: Mix → blue, Master → violet, Finished →
 * emerald, Released → teal (retired "WIP"/"Mix/Master" fold onto the same).
 */
@Composable
fun StatusBadge(status: String, modifier: Modifier = Modifier) {
    val color = when (status.lowercase()) {
        "mix", "wip", "mixing" -> MbColors.Blue
        "master", "mix/master", "mastering" -> MbColors.Violet
        "finished" -> MbColors.Emerald
        "released" -> MbColors.Teal
        else -> MbColors.TextMuted
    }
    Text(
        text = status,
        fontSize = 10.sp,
        fontWeight = FontWeight.SemiBold,
        color = Color.White,
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(color.copy(alpha = 0.85f))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

/** Home-screen stat tile. */
@Composable
fun StatCard(value: Int, label: String, color: Color, modifier: Modifier = Modifier, onClick: () -> Unit = {}) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(MbColors.Surface)
            .clickable(onClick = onClick)
            .padding(vertical = 14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(value.toString(), fontSize = 24.sp, fontWeight = FontWeight.Bold, color = color)
        Text(label, fontSize = 12.sp, color = MbColors.TextMuted)
    }
}

@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier, trailing: @Composable () -> Unit = {}) {
    Row(modifier = modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = MaterialTheme.typography.titleMedium, color = MbColors.Text, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.weight(1f))
        trailing()
    }
}

@Composable
fun TealLabel(text: String, modifier: Modifier = Modifier) {
    Text(text, color = MbColors.Teal, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = modifier)
}

@Composable
fun MutedText(text: String, modifier: Modifier = Modifier, size: Int = 13) {
    Text(text, color = MbColors.TextMuted, fontSize = size.sp, modifier = modifier)
}

@Composable
fun ErrorText(text: String?, modifier: Modifier = Modifier) {
    if (!text.isNullOrBlank()) Text(text, color = MbColors.Red, fontSize = 12.sp, modifier = modifier)
}

/** Centered spinner for loading states. */
@Composable
fun LoadingBox(modifier: Modifier = Modifier.fillMaxWidth().padding(vertical = 48.dp)) {
    Box(modifier = modifier, contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = MbColors.Teal)
    }
}

/** "Couldn't load … / Retry" card. */
@Composable
fun LoadErrorCard(message: String, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MbColors.Surface)
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(message, color = MbColors.Text, fontSize = 14.sp)
        PrimaryButton("Retry", onClick = onRetry)
    }
}

@Composable
fun EmptyState(title: String, subtitle: String? = null, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxWidth().padding(vertical = 60.dp, horizontal = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(title, color = MbColors.TextMuted, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        if (subtitle != null) Text(subtitle, color = MbColors.TextMuted.copy(alpha = 0.7f), fontSize = 13.sp)
    }
}

/** Teal pill button — the primary action style. */
@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, loading: Boolean = false) {
    Button(
        onClick = onClick,
        enabled = enabled && !loading,
        modifier = modifier,
        shape = RoundedCornerShape(50),
        colors = ButtonDefaults.buttonColors(
            containerColor = MbColors.Teal,
            contentColor = MbColors.Background,
            disabledContainerColor = MbColors.SurfaceHigh,
            disabledContentColor = MbColors.TextMuted,
        ),
        contentPadding = PaddingValues(horizontal = 24.dp, vertical = 10.dp),
    ) {
        if (loading) {
            CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = MbColors.Background)
        } else {
            Text(text, fontWeight = FontWeight.SemiBold)
        }
    }
}

/** Dark text field with the app's colours. */
@Composable
fun MbTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    label: String? = null,
    singleLine: Boolean = true,
    minLines: Int = 1,
    keyboardType: KeyboardType = KeyboardType.Text,
    password: Boolean = false,
    enabled: Boolean = true,
) {
    val labelSlot: (@Composable () -> Unit)? = if (label != null) { { Text(label) } } else null
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth(),
        label = labelSlot,
        placeholder = { Text(placeholder, color = MbColors.TextMuted) },
        singleLine = singleLine,
        minLines = minLines,
        enabled = enabled,
        visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = keyboardType),
        shape = RoundedCornerShape(10.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedTextColor = MbColors.Text,
            unfocusedTextColor = MbColors.Text,
            focusedContainerColor = MbColors.SurfaceRaised,
            unfocusedContainerColor = MbColors.SurfaceRaised,
            focusedBorderColor = MbColors.Teal,
            unfocusedBorderColor = MbColors.Divider,
            cursorColor = MbColors.Teal,
            focusedLabelColor = MbColors.Teal,
            unfocusedLabelColor = MbColors.TextMuted,
        ),
    )
}

/** A rounded card row (settings-style). */
@Composable
fun CardRow(modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, content: @Composable RowScope.() -> Unit) {
    val base = modifier
        .fillMaxWidth()
        .clip(RoundedCornerShape(10.dp))
        .background(MbColors.Surface)
    Row(
        modifier = (if (onClick != null) base.clickable(onClick = onClick) else base).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        content()
    }
}

/** Small round play/pause affordance used on list rows. */
@Composable
fun RoundIconButton(onClick: () -> Unit, size: Dp = 36.dp, background: Color = MbColors.Teal, content: @Composable () -> Unit) {
    Box(
        modifier = Modifier.size(size).clip(CircleShape).background(background).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

@Composable
fun VSpace(height: Dp) = Spacer(Modifier.height(height))
