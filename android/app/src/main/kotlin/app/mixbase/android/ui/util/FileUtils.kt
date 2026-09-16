package app.mixbase.android.ui.util

import android.content.Context
import android.content.Intent
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.OpenableColumns
import app.mixbase.core.net.StreamingRequestBody
import app.mixbase.core.net.guessContentType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import java.io.InputStream

/** What we know about a file the user picked. */
data class PickedFile(val uri: Uri, val name: String, val sizeBytes: Long)

/** Display name + size from a content Uri (SAF / Photo Picker). */
fun Context.describeFile(uri: Uri): PickedFile {
    var name: String? = null
    var size: Long = -1
    contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
            val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (nameIdx >= 0) name = cursor.getString(nameIdx)
            if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) size = cursor.getLong(sizeIdx)
        }
    }
    if (size < 0) {
        size = runCatching { contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L }.getOrDefault(-1L)
    }
    return PickedFile(uri, name ?: uri.lastPathSegment ?: "audio", size)
}

/**
 * Duration in whole seconds, rounded like the web (`Math.round(audio.duration)`)
 * so both upload paths agree. Null when the probe fails — a version whose
 * duration can't be read must still upload.
 */
fun Context.probeDurationSeconds(uri: Uri): Int? = runCatching {
    val retriever = MediaMetadataRetriever()
    try {
        retriever.setDataSource(this, uri)
        val ms = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: return null
        if (ms <= 0) null else Math.round(ms / 1000.0).toInt()
    } finally {
        retriever.release()
    }
}.getOrNull()

/** A streaming upload body for a content Uri, re-openable for OkHttp retries. */
fun Context.uploadBody(file: PickedFile, onProgress: ((Double) -> Unit)? = null): RequestBody {
    val open: () -> InputStream = {
        contentResolver.openInputStream(file.uri) ?: throw java.io.IOException("Couldn't open the selected file")
    }
    return StreamingRequestBody(guessContentType(file.name).toMediaType(), file.sizeBytes, open, onProgress)
}

/** Read a picked image fully (covers are small). */
fun Context.readBytes(uri: Uri): ByteArray =
    contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: throw java.io.IOException("Couldn't open the selected image")

/** System share sheet for a share link. */
fun Context.shareText(text: String, title: String = "Share") {
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    startActivity(Intent.createChooser(intent, title).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}
