package app.mixbase.core.supabase

import app.mixbase.core.Config
import app.mixbase.core.MixbaseException
import app.mixbase.core.auth.SessionManager
import app.mixbase.core.json.AppJson
import app.mixbase.core.model.Activity
import app.mixbase.core.model.Collection
import app.mixbase.core.model.CollectionItem
import app.mixbase.core.model.Feedback
import app.mixbase.core.model.Project
import app.mixbase.core.model.Release
import app.mixbase.core.model.Version
import app.mixbase.core.net.HttpResult
import app.mixbase.core.net.JSON_MEDIA_TYPE
import app.mixbase.core.net.awaitResult
import app.mixbase.core.net.forUploads
import app.mixbase.core.net.guessContentType
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.time.Instant
import java.time.LocalDate

/**
 * Direct PostgREST + Storage access, scoped by the user's access token (RLS
 * does the ownership filtering — owner-only policies throughout, migration
 * 005). Port of ios/mixBase/Services/SupabaseService.swift.
 *
 * Writes that need SERVER judgement (creating a version, generating artwork,
 * anything paid or moderated) do NOT go here — see [app.mixbase.core.api.MixbaseApi].
 */
class SupabaseClient(
    http: OkHttpClient,
    private val session: SessionManager,
    private val baseUrl: String = Config.SUPABASE_URL,
    private val anonKey: String = Config.SUPABASE_ANON_KEY,
) {
    private val http: OkHttpClient = http
    private val uploadHttp: OkHttpClient = http.forUploads()

    // ── Profile ─────────────────────────────────────────────────────────────

    /** The profile's artist_name, or "" when unset/unavailable (never throws). */
    suspend fun fetchArtistName(userId: String): String {
        val result = runCatching { get("/rest/v1/profiles?id=eq.$userId&select=artist_name") }.getOrNull() ?: return ""
        if (!result.isSuccess) return ""
        return runCatching {
            AppJson.parseToJsonElement(result.body).jsonArray.firstOrNull()?.jsonObject
                ?.get("artist_name")?.jsonPrimitive?.contentOrNull
        }.getOrNull().orEmpty()
    }

    suspend fun updateArtistName(userId: String, name: String) {
        val result = patch("/rest/v1/profiles?id=eq.$userId", buildJsonObject { put("artist_name", name) })
        validate(result)
        val rows = runCatching { AppJson.parseToJsonElement(result.body).jsonArray }.getOrNull()
        if (rows == null || rows.isEmpty()) throw MixbaseException.NotFound("No profile found for this account")
    }

    // ── Projects ────────────────────────────────────────────────────────────

    suspend fun fetchProjects(): List<Project> = decodeList(get("/rest/v1/mb_projects?order=updated_at.desc"))

    suspend fun fetchProject(id: String): Project =
        decodeList<Project>(get("/rest/v1/mb_projects?id=eq.$id")).firstOrNull()
            ?: throw MixbaseException.NotFound("Project not found")

    suspend fun createProject(title: String, genre: String?, bpm: Int?): Project {
        val ownerId = session.userId ?: throw MixbaseException.NotAuthenticated()
        val body = buildJsonObject {
            put("title", title)
            put("user_id", ownerId)
            if (genre != null) put("genre", genre)
            if (bpm != null) put("bpm", bpm)
        }
        return decodeList<Project>(validate(post("/rest/v1/mb_projects", body))).firstOrNull()
            ?: throw MixbaseException.InvalidResponse("Failed to decode created project")
    }

    /** PATCH a subset of columns (title, genre, bpm, key_signature…). Null values clear the column. */
    suspend fun updateProject(id: String, fields: Map<String, Any?>): Unit =
        validateUnit(patch("/rest/v1/mb_projects?id=eq.$id", toJson(fields)))

    suspend fun deleteProject(id: String): Unit = validateUnit(delete("/rest/v1/mb_projects?id=eq.$id"))

    // ── Versions ────────────────────────────────────────────────────────────

    suspend fun fetchVersions(projectId: String): List<Version> =
        decodeList(get("/rest/v1/mb_versions?project_id=eq.$projectId&order=version_number.asc"))

    /**
     * Every version the user can see, newest first — one round-trip for the
     * "latest mix per project" maps the Home, Projects and Player screens
     * build (RLS scopes mb_versions transitively through mb_projects).
     */
    suspend fun fetchAllVersions(): List<Version> =
        decodeList(get("/rest/v1/mb_versions?order=created_at.desc&limit=2000"))

    suspend fun updateVersionStatus(id: String, status: String): Unit =
        validateUnit(patch("/rest/v1/mb_versions?id=eq.$id", buildJsonObject { put("status", status) }))

    suspend fun updateVersionNotes(id: String, privateNotes: String?, publicNotes: String?): Unit =
        validateUnit(patch("/rest/v1/mb_versions?id=eq.$id", toJson(mapOf("private_notes" to privateNotes, "public_notes" to publicNotes))))

    suspend fun deleteVersion(id: String): Unit = validateUnit(delete("/rest/v1/mb_versions?id=eq.$id"))

    // ── Releases ────────────────────────────────────────────────────────────

    suspend fun fetchReleases(): List<Release> =
        decodeList(get("/rest/v1/mb_releases?order=release_date.desc.nullslast"))

    suspend fun createRelease(title: String, projectId: String?, releaseDate: LocalDate?): Release {
        val ownerId = session.userId ?: throw MixbaseException.NotAuthenticated()
        val body = buildJsonObject {
            put("title", title)
            put("user_id", ownerId)
            for (flag in RELEASE_FLAGS) put(flag, false)
            if (projectId != null) put("project_id", projectId)
            if (releaseDate != null) put("release_date", releaseDate.toString())
        }
        return decodeList<Release>(validate(post("/rest/v1/mb_releases", body))).firstOrNull()
            ?: throw MixbaseException.InvalidResponse("Failed to decode created release")
    }

    /** PATCH release fields; booleans, strings, LocalDate (yyyy-MM-dd) and nulls are all accepted. */
    suspend fun updateRelease(id: String, fields: Map<String, Any?>): Unit =
        validateUnit(patch("/rest/v1/mb_releases?id=eq.$id", toJson(fields)))

    suspend fun deleteRelease(id: String): Unit = validateUnit(delete("/rest/v1/mb_releases?id=eq.$id"))

    // ── Collections ─────────────────────────────────────────────────────────

    suspend fun fetchCollections(): List<Collection> = decodeList(get("/rest/v1/mb_collections?order=updated_at.desc"))

    suspend fun fetchAllCollectionItems(): List<CollectionItem> =
        decodeList(get("/rest/v1/mb_collection_items?order=position.asc"))

    // ── Feedback / activity ─────────────────────────────────────────────────

    suspend fun fetchFeedback(versionId: String): List<Feedback> =
        decodeList(get("/rest/v1/mb_feedback?version_id=eq.$versionId&order=created_at.desc"))

    suspend fun fetchActivities(limit: Int = 20): List<Activity> =
        decodeList(get("/rest/v1/mb_activity?order=created_at.desc&limit=$limit"))

    // ── Storage ─────────────────────────────────────────────────────────────

    /**
     * Upload to a bucket and return the public URL. `objectPath` is the exact
     * key (e.g. "<project-id>-v2-<epoch>.wav" — lowercase ids only). Upserts,
     * so a retry of the same key never fails as a duplicate.
     */
    suspend fun uploadFile(bucket: String, objectPath: String, body: RequestBody): String {
        session.ensureFreshToken()
        var token = session.accessToken ?: throw MixbaseException.NotAuthenticated()

        fun build(t: String) = Request.Builder()
            .url("$baseUrl/storage/v1/object/$bucket/$objectPath")
            .header("apikey", anonKey)
            .header("Authorization", "Bearer $t")
            .header("x-upsert", "true")
            .post(body)
            .build()

        var result = execute(uploadHttp, build(token))
        if (result.code == 401) {
            if (!session.refreshSession()) throw MixbaseException.NotAuthenticated()
            token = session.accessToken ?: throw MixbaseException.NotAuthenticated()
            result = execute(uploadHttp, build(token))
        }
        validate(result)
        return publicUrl(bucket, objectPath)
    }

    suspend fun uploadBytes(bucket: String, objectPath: String, bytes: ByteArray, contentType: String? = null): String {
        val type = (contentType ?: guessContentType(objectPath)).toMediaType()
        return uploadFile(bucket, objectPath, bytes.toRequestBody(type))
    }

    fun publicUrl(bucket: String, objectPath: String): String = "$baseUrl/storage/v1/object/public/$bucket/$objectPath"

    // ── Plumbing ────────────────────────────────────────────────────────────

    private suspend fun get(path: String): HttpResult = authenticated(path, "GET", null)
    private suspend fun post(path: String, body: JsonObject): HttpResult = authenticated(path, "POST", body)
    private suspend fun patch(path: String, body: JsonObject): HttpResult = authenticated(path, "PATCH", body)
    private suspend fun delete(path: String): HttpResult = authenticated(path, "DELETE", null)

    /** Performs a PostgREST request; on 401 refreshes the session (coalesced) and retries once. */
    private suspend fun authenticated(path: String, method: String, body: JsonObject?): HttpResult {
        fun build(): Request {
            val builder = Request.Builder()
                .url(baseUrl + path)
                .header("apikey", anonKey)
                .header("Authorization", "Bearer ${session.accessToken ?: anonKey}")
                .header("Content-Type", "application/json")
            if (method == "POST" || method == "PATCH") builder.header("Prefer", "return=representation")
            val requestBody = body?.toString()?.toRequestBody(JSON_MEDIA_TYPE)
            return builder.method(method, requestBody ?: if (method == "GET") null else "".toRequestBody(null)).build()
        }

        var result = execute(http, build())
        if (result.code == 401) {
            session.refreshSession()
            if (session.accessToken != null) result = execute(http, build())
        }
        return result
    }

    private suspend fun execute(client: OkHttpClient, request: Request): HttpResult = try {
        client.newCall(request).awaitResult()
    } catch (e: IOException) {
        throw MixbaseException.Network(e)
    }

    private fun validate(result: HttpResult): HttpResult {
        if (result.isSuccess) return result
        if (result.code == 401) throw MixbaseException.NotAuthenticated()
        val message = runCatching {
            val json = AppJson.parseToJsonElement(result.body).jsonObject
            listOf("message", "error", "msg").firstNotNullOfOrNull { json[it]?.jsonPrimitive?.contentOrNull }
        }.getOrNull()
        if (message != null) throw MixbaseException.Server(result.code, message)
        throw MixbaseException.Http(result.code)
    }

    private fun validateUnit(result: HttpResult) { validate(result) }

    private inline fun <reified T> decodeList(result: HttpResult): List<T> {
        validate(result)
        return try {
            AppJson.decodeFromString(kotlinx.serialization.builtins.ListSerializer(kotlinx.serialization.serializer<T>()), result.body)
        } catch (e: Exception) {
            throw MixbaseException.InvalidResponse("Couldn't read the server's response")
        }
    }

    companion object {
        val RELEASE_FLAGS = listOf(
            "mixing_done", "mastering_done", "artwork_ready", "dsp_submitted", "social_posts_done", "press_release_done",
            "dsp_spotify", "dsp_apple_music", "dsp_tidal", "dsp_bandcamp", "dsp_soundcloud", "dsp_youtube", "dsp_amazon",
        )

        /** Builds a PATCH body from plain Kotlin values. */
        fun toJson(fields: Map<String, Any?>): JsonObject = JsonObject(fields.mapValues { (_, v) -> toElement(v) })

        private fun toElement(v: Any?): JsonElement = when (v) {
            null -> JsonNull
            is String -> JsonPrimitive(v)
            is Boolean -> JsonPrimitive(v)
            is Int -> JsonPrimitive(v)
            is Long -> JsonPrimitive(v)
            is Double -> JsonPrimitive(v)
            is Float -> JsonPrimitive(v)
            is LocalDate -> JsonPrimitive(v.toString())
            is Instant -> JsonPrimitive(v.toString())
            is JsonElement -> v
            else -> JsonPrimitive(v.toString())
        }
    }
}
