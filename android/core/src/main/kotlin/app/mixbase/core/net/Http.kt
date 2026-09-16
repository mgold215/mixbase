package app.mixbase.core.net

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Response
import okio.BufferedSink
import okio.source
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

/** Suspend on an OkHttp call without blocking a thread; cancels the call on coroutine cancellation. */
suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            cont.resume(response)
        }
    })
    cont.invokeOnCancellation { runCatching { cancel() } }
}

/** Status + body of a completed response, with the body already read and closed. */
data class HttpResult(val code: Int, val body: String) {
    val isSuccess: Boolean get() = code in 200..299
}

suspend fun Call.awaitResult(): HttpResult = await().use { HttpResult(it.code, it.body?.string() ?: "") }

/** Default client for JSON calls (PostgREST, auth). */
fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(20, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .writeTimeout(60, TimeUnit.SECONDS)
    .build()

/**
 * Generation routes block while the server polls the AI provider — artwork
 * up to 2 min, free visualizer renders up to ~1 min — so this client allows
 * far more than the default per-request timeout.
 */
fun OkHttpClient.forLongRequests(): OkHttpClient = newBuilder()
    .readTimeout(6, TimeUnit.MINUTES)
    .writeTimeout(6, TimeUnit.MINUTES)
    .callTimeout(8, TimeUnit.MINUTES)
    .build()

/** Uploads: a WAV master can be hundreds of MB on a slow uplink. */
fun OkHttpClient.forUploads(): OkHttpClient = newBuilder()
    .readTimeout(2, TimeUnit.MINUTES)
    .writeTimeout(60, TimeUnit.MINUTES)
    .callTimeout(60, TimeUnit.MINUTES)
    .build()

/**
 * A request body that streams from a freshly opened InputStream on every
 * write (OkHttp may retry), reporting progress as a fraction 0..1.
 */
class StreamingRequestBody(
    private val contentType: okhttp3.MediaType,
    private val contentLength: Long,
    private val open: () -> InputStream,
    private val onProgress: ((Double) -> Unit)? = null,
) : okhttp3.RequestBody() {

    override fun contentType(): okhttp3.MediaType = contentType

    override fun contentLength(): Long = contentLength

    override fun writeTo(sink: BufferedSink) {
        open().use { input ->
            val source = input.source()
            var written = 0L
            var lastPercent = -1
            val bufferSize = 256L * 1024
            while (true) {
                val read = source.read(sink.buffer, bufferSize)
                if (read == -1L) break
                sink.emitCompleteSegments()
                written += read
                if (contentLength > 0 && onProgress != null) {
                    val percent = ((written * 100) / contentLength).toInt()
                    if (percent != lastPercent) {
                        lastPercent = percent
                        onProgress.invoke(percent / 100.0)
                    }
                }
            }
            sink.flush()
        }
    }
}

/** Content type for a storage upload, guessed from the file extension. */
fun guessContentType(filename: String): String = when (filename.substringAfterLast('.', "").lowercase()) {
    "mp3" -> "audio/mpeg"
    "wav" -> "audio/wav"
    "aac" -> "audio/aac"
    "flac" -> "audio/flac"
    "m4a", "mp4" -> "audio/mp4"
    "ogg" -> "audio/ogg"
    "aiff", "aif" -> "audio/aiff"
    "png" -> "image/png"
    "jpg", "jpeg" -> "image/jpeg"
    "webp" -> "image/webp"
    else -> "application/octet-stream"
}
