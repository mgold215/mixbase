package app.mixbase.core.api

import app.mixbase.core.Config
import app.mixbase.core.MixbaseException
import app.mixbase.core.auth.SessionManager
import app.mixbase.core.json.AppJson
import app.mixbase.core.model.FeedComment
import app.mixbase.core.model.FeedItem
import app.mixbase.core.model.Feedback
import app.mixbase.core.model.Version
import app.mixbase.core.model.Visualizer
import app.mixbase.core.net.HttpResult
import app.mixbase.core.net.JSON_MEDIA_TYPE
import app.mixbase.core.net.awaitResult
import app.mixbase.core.net.forLongRequests
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/**
 * Client for the web app's authenticated API routes (mixbase.app). These
 * run the paid AI generation server-side (Replicate) with the monthly
 * allowance enforced where the keys live, serve the cross-user community
 * feed, and own the writes that need server judgement. The middleware
 * accepts `Authorization: Bearer <supabase access token>`.
 *
 * Port of ios/mixBase/Services/MixbaseAPI.swift.
 */
class MixbaseApi(
    http: OkHttpClient,
    private val session: SessionManager,
    private val baseUrl: String = Config.API_BASE_URL,
) {
    private val http: OkHttpClient = http.forLongRequests()

    data class ImageModel(val id: String, val label: String)

    // ── Artwork ─────────────────────────────────────────────────────────────

    /**
     * Generate AI artwork for a project. The server generates the image,
     * uploads it to storage AND applies it as the project's artwork.
     * Returns the public URL of the applied artwork.
     */
    suspend fun generateArtwork(projectId: String, prompt: String, model: String, vary: Boolean): String {
        val json = requestJson("/api/generate-artwork", "POST", buildJsonObject {
            put("project_id", projectId)
            put("prompt", prompt)
            put("model", model)
            put("vary", vary)
        })
        return json["artwork_url"]?.jsonPrimitive?.contentOrNull
            ?: throw MixbaseException.InvalidResponse("No artwork URL in response")
    }

    /** Set an existing artwork image as a project's cover (must be a Supabase storage URL). */
    suspend fun assignArtworkToProject(projectId: String, artworkUrl: String) {
        requestJson("/api/projects/$projectId", "PATCH", buildJsonObject { put("artwork_url", artworkUrl) })
    }

    // ── Visualizers (view / pin / delete only — generation is web-only) ────

    suspend fun fetchVisualizers(): List<Visualizer> =
        decode(ListSerializer(Visualizer.serializer()), requestData("/api/visualizer", "GET"))

    suspend fun deleteVisualizer(id: String) { requestData("/api/visualizer/$id", "DELETE") }

    /** Pin (or clear, with null) a video as a project's visualizer. */
    suspend fun pinVisualizer(projectId: String, videoUrl: String?) {
        requestJson("/api/projects/$projectId", "PATCH", buildJsonObject {
            if (videoUrl == null) put("visualizer_url", JsonNull) else put("visualizer_url", videoUrl)
        })
    }

    // ── Versions ────────────────────────────────────────────────────────────

    /**
     * Create the mb_versions row for a mix that has just finished uploading.
     *
     * Goes through the web route rather than PostgREST because three columns
     * are the SERVER's decision: `allow_download` (a consent signal the route
     * inherits from the artist's previous choice ONLY when absent — never send
     * it), `status`/`label` (parsed from the filename), and `version_number`
     * (max+1, retried on conflict). No fallback to a direct insert.
     */
    suspend fun createVersion(
        projectId: String,
        audioUrl: String,
        audioFilename: String? = null,
        durationSeconds: Int? = null,
        fileSizeBytes: Long? = null,
    ): Version {
        val body = buildJsonObject {
            put("project_id", projectId)
            put("audio_url", audioUrl)
            // Omit rather than send null: the route forwards these into the insert.
            if (audioFilename != null) put("audio_filename", audioFilename)
            if (durationSeconds != null) put("duration_seconds", durationSeconds)
            if (fileSizeBytes != null) put("file_size_bytes", fileSizeBytes)
        }
        return decode(Version.serializer(), requestData("/api/versions", "POST", body))
    }

    /** Share-link download consent — a signal, not an access control (src/lib/version-defaults.ts). */
    suspend fun setAllowDownload(versionId: String, allow: Boolean) {
        requestJson("/api/versions/$versionId", "PATCH", buildJsonObject { put("allow_download", allow) })
    }

    /** Owner-only timestamped note on one of your own mixes (same route as the web player). */
    suspend fun postMixNote(versionId: String, comment: String, timestampSeconds: Int): Feedback =
        decode(Feedback.serializer(), requestData("/api/mix-notes", "POST", buildJsonObject {
            put("version_id", versionId)
            put("comment", comment)
            put("timestamp_seconds", timestampSeconds)
        }))

    // ── Community feed (cross-user by design) ───────────────────────────────

    /** Recent uploads across ALL artists. One malformed row is dropped, not the whole feed. */
    suspend fun fetchFeed(): List<FeedItem> {
        val result = requestData("/api/feed", "GET")
        val array = runCatching { AppJson.parseToJsonElement(result.body).jsonArray }.getOrNull()
            ?: throw MixbaseException.InvalidResponse("Couldn't read the feed")
        return array.mapNotNull { element ->
            runCatching { AppJson.decodeFromJsonElement(FeedItem.serializer(), element) }.getOrNull()
        }
    }

    suspend fun postFeedComment(versionId: String, comment: String): FeedComment =
        decode(FeedComment.serializer(), requestData("/api/feed/comments", "POST", buildJsonObject {
            put("version_id", versionId)
            put("comment", comment)
        }))

    /** Report objectionable feed content; type is "version" or "comment". */
    suspend fun reportContent(type: String, id: String, reason: String? = null) {
        requestData("/api/feed/report", "POST", buildJsonObject {
            put("content_type", type)
            put("content_id", id)
            if (!reason.isNullOrBlank()) put("reason", reason)
        })
    }

    /** Block another artist — their uploads and comments disappear from this account's feed. */
    suspend fun blockUser(userId: String) {
        requestData("/api/feed/block", "POST", buildJsonObject { put("user_id", userId) })
    }

    // ── Account ─────────────────────────────────────────────────────────────

    /** Permanently delete the signed-in account and all its data. */
    suspend fun deleteAccount() { requestData("/api/auth/delete-account", "POST") }

    // ── Plumbing ────────────────────────────────────────────────────────────

    private suspend fun requestJson(path: String, method: String, body: JsonObject? = null): JsonObject {
        val result = requestData(path, method, body)
        return runCatching { AppJson.parseToJsonElement(result.body).jsonObject }.getOrNull()
            ?: throw MixbaseException.InvalidResponse("Response was not a JSON object")
    }

    private fun <T> decode(serializer: kotlinx.serialization.KSerializer<T>, result: HttpResult): T = try {
        AppJson.decodeFromString(serializer, result.body)
    } catch (e: Exception) {
        throw MixbaseException.InvalidResponse("Couldn't read the server's response")
    }

    /**
     * Authenticated request. On 401, refreshes the Supabase session (coalesced
     * in [SessionManager]) and retries once. Non-2xx surfaces the server's own
     * `error` message.
     */
    internal suspend fun requestData(path: String, method: String, body: JsonObject? = null): HttpResult {
        fun build(token: String?): Request {
            val builder = Request.Builder().url(baseUrl + path)
            if (token != null) builder.header("Authorization", "Bearer $token")
            val requestBody = body?.let {
                builder.header("Content-Type", "application/json")
                it.toString().toRequestBody(JSON_MEDIA_TYPE)
            }
            return builder.method(method, requestBody ?: if (method == "GET") null else "".toRequestBody(null)).build()
        }

        var result = execute(build(session.accessToken))
        if (result.code == 401) {
            if (!session.refreshSession()) throw MixbaseException.NotAuthenticated()
            result = execute(build(session.accessToken))
        }
        if (result.isSuccess) return result
        if (result.code == 401) throw MixbaseException.NotAuthenticated()

        val json = runCatching { AppJson.parseToJsonElement(result.body).jsonObject }.getOrNull()
        if (json != null) {
            // Monthly allowance exhausted. There are no paid plans anywhere in
            // mixBase, so the copy stays purchase-free.
            if (json["upgrade"]?.jsonPrimitive?.booleanOrNull == true) {
                throw MixbaseException.Server(result.code, LIMIT_MESSAGE)
            }
            val message = json["error"]?.jsonPrimitive?.contentOrNull
            if (message != null) throw MixbaseException.Server(result.code, scrubPurchaseWords(message))
        }
        throw MixbaseException.Http(result.code)
    }

    private suspend fun execute(request: Request): HttpResult = try {
        http.newCall(request).awaitResult()
    } catch (e: IOException) {
        throw MixbaseException.Network(e)
    }

    companion object {
        /** Mirrors IMAGE_MODELS in src/lib/artwork-models.ts — ids must match the server registry. */
        val IMAGE_MODELS: List<ImageModel> = listOf(
            ImageModel("flux-ultra", "FLUX Ultra Raw"),
            ImageModel("nano-pro", "Nano Banana Pro"),
            ImageModel("flux-krea", "FLUX Krea"),
            ImageModel("seedream", "Seedream 4"),
            ImageModel("flux", "Flux 2 Pro"),
            ImageModel("nano", "Nano Banana 2"),
        )

        const val LIMIT_MESSAGE = "You've reached this month's limit for AI generations. It resets at the start of next month."
        const val NEUTRAL_MESSAGE = "This action isn't available right now. Please try again later."

        private val purchaseWords = listOf("upgrade", "plan", "tier", "subscri", "purchase", "billing", "pricing", "credit", "buy ")

        /** Never show copy that steers to a purchase — there is nothing to buy. */
        fun scrubPurchaseWords(message: String): String {
            val lowered = message.lowercase()
            return if (purchaseWords.any { lowered.contains(it) }) NEUTRAL_MESSAGE else message
        }
    }
}
