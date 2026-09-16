package app.mixbase.core.model

import java.time.Duration
import java.time.Instant

/** 125 → "2:05"; 3725 → "1:02:05". */
fun formatClock(totalSeconds: Long): String {
    val s = totalSeconds.coerceAtLeast(0)
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
}

fun formatClock(seconds: Double): String = formatClock(seconds.toLong())

/** Compact relative time for lists: "just now", "5m ago", "3h ago", "2d ago", "3w ago". */
fun formatRelative(at: Instant, now: Instant = Instant.now()): String {
    val d = Duration.between(at, now)
    val minutes = d.toMinutes()
    return when {
        minutes < 1 -> "just now"
        minutes < 60 -> "${minutes}m ago"
        d.toHours() < 24 -> "${d.toHours()}h ago"
        d.toDays() < 7 -> "${d.toDays()}d ago"
        d.toDays() < 60 -> "${d.toDays() / 7}w ago"
        else -> "${d.toDays() / 30}mo ago"
    }
}

/** 1_500_000 → "1.4 MB". */
fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val kb = bytes / 1024.0
    if (kb < 1024) return "%.0f KB".format(kb)
    val mb = kb / 1024.0
    if (mb < 1024) return "%.1f MB".format(mb)
    return "%.2f GB".format(mb / 1024.0)
}
