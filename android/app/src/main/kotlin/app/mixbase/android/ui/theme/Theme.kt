package app.mixbase.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// mixBASE palette — the same hex values the iOS app and the web use.
object MbColors {
    val Background = Color(0xFF080808)
    val Surface = Color(0xFF111111)
    val SurfaceRaised = Color(0xFF161616)
    val SurfaceHigh = Color(0xFF222222)
    val Divider = Color(0xFF333333)
    val Teal = Color(0xFF2DD4BF)
    val Text = Color(0xFFF0F0F0)
    val TextMuted = Color(0xFF9A9A9A)
    val TextBody = Color(0xFFC9C4BB)
    val Cream = Color(0xFFEDE4D0)
    val Mint = Color(0xFF86EFAC)
    val Violet = Color(0xFFA78BFA)
    val Blue = Color(0xFF5B8DEF)
    val Emerald = Color(0xFF33CC66)
    val Amber = Color(0xFFF5C451)
    val Red = Color(0xFFEF5350)
}

private val DarkScheme = darkColorScheme(
    primary = MbColors.Teal,
    onPrimary = MbColors.Background,
    secondary = MbColors.Mint,
    onSecondary = MbColors.Background,
    background = MbColors.Background,
    onBackground = MbColors.Text,
    surface = MbColors.Surface,
    onSurface = MbColors.Text,
    surfaceVariant = MbColors.SurfaceRaised,
    onSurfaceVariant = MbColors.TextMuted,
    surfaceContainer = MbColors.Surface,
    surfaceContainerHigh = MbColors.SurfaceRaised,
    surfaceContainerHighest = MbColors.SurfaceHigh,
    outline = MbColors.Divider,
    error = MbColors.Red,
    onError = MbColors.Text,
)

/** The app is dark by design on every platform — the system setting is ignored on purpose. */
@Composable
fun MixbaseTheme(content: @Composable () -> Unit) {
    @Suppress("UNUSED_VARIABLE") val ignoredSystemTheme = isSystemInDarkTheme()
    MaterialTheme(
        colorScheme = DarkScheme,
        typography = Typography(),
        content = content,
    )
}
