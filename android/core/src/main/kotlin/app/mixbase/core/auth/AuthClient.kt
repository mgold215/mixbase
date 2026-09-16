package app.mixbase.core.auth

import app.mixbase.core.Config
import app.mixbase.core.json.AppJson
import app.mixbase.core.net.JSON_MEDIA_TYPE
import app.mixbase.core.net.awaitResult
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/** A signed-in Supabase session as persisted by [SessionManager]. */
data class Session(
    val accessToken: String,
    val refreshToken: String,
    val userId: String,
    val email: String,
    /** Epoch seconds when the access token expires. */
    val expiresAt: Long?,
)

sealed class AuthOutcome {
    data class Success(val session: Session) : AuthOutcome()

    /** Supabase answered, and said no. 400/401 on a refresh means the refresh token is dead. */
    data class Rejected(val status: Int, val message: String) : AuthOutcome()

    /** Transient: network failure, 5xx, 429. Keep the existing session. */
    data class Transient(val message: String) : AuthOutcome()
}

/**
 * Supabase Auth over plain REST (`/auth/v1/…`). Stateless: [SessionManager]
 * owns persistence and refresh policy.
 */
class AuthClient(
    private val http: OkHttpClient,
    private val baseUrl: String = Config.SUPABASE_URL,
    private val anonKey: String = Config.SUPABASE_ANON_KEY,
    private val now: () -> Long = { System.currentTimeMillis() / 1000 },
) {

    suspend fun signInWithPassword(email: String, password: String): AuthOutcome =
        post("/auth/v1/token?grant_type=password", buildJsonObject {
            put("email", email)
            put("password", password)
        }, fallbackEmail = email, fallbackError = "Invalid email or password")

    /**
     * Creates the account. With email confirmation disabled (mixBase's
     * setting) Supabase returns the session directly; otherwise the caller
     * should sign in afterwards.
     */
    suspend fun signUp(email: String, password: String): AuthOutcome {
        val outcome = post("/auth/v1/signup", buildJsonObject {
            put("email", email)
            put("password", password)
        }, fallbackEmail = email, fallbackError = "Sign up failed")
        if (outcome is AuthOutcome.Rejected && outcome.message.contains("already registered", ignoreCase = true)) {
            return AuthOutcome.Rejected(outcome.status, "An account with that email already exists.")
        }
        return outcome
    }

    /** OAuth provider id-token exchange (Sign in with Google on Android). */
    suspend fun signInWithIdToken(provider: String, idToken: String, nonce: String?): AuthOutcome =
        post("/auth/v1/token?grant_type=id_token", buildJsonObject {
            put("provider", provider)
            put("id_token", idToken)
            if (nonce != null) put("nonce", nonce)
        }, fallbackEmail = "", fallbackError = "Sign in failed")

    suspend fun refresh(refreshToken: String, knownEmail: String): AuthOutcome =
        post("/auth/v1/token?grant_type=refresh_token", buildJsonObject {
            put("refresh_token", refreshToken)
        }, fallbackEmail = knownEmail, fallbackError = "Session expired")

    private suspend fun post(path: String, body: JsonObject, fallbackEmail: String, fallbackError: String): AuthOutcome {
        val request = Request.Builder()
            .url(baseUrl + path)
            .header("apikey", anonKey)
            .header("Content-Type", "application/json")
            .post(body.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        val result = try {
            http.newCall(request).awaitResult()
        } catch (e: IOException) {
            return AuthOutcome.Transient("Network error. Check your connection.")
        }

        val json = runCatching { AppJson.parseToJsonElement(result.body).jsonObject }.getOrNull()

        if (result.isSuccess) {
            val session = json?.let { parseSession(it, fallbackEmail) }
                ?: return AuthOutcome.Rejected(result.code, "Unexpected response from server")
            return AuthOutcome.Success(session)
        }

        val message = json?.let { j ->
            listOf("error_description", "msg", "message", "error")
                .firstNotNullOfOrNull { key -> j[key]?.jsonPrimitive?.contentOrNull }
        } ?: fallbackError

        return if (result.code in 500..599 || result.code == 429) {
            AuthOutcome.Transient(message)
        } else {
            AuthOutcome.Rejected(result.code, message)
        }
    }

    /** Pulls tokens + user out of a Supabase token/signup response, or null when it carries no session. */
    fun parseSession(json: JsonObject, fallbackEmail: String): Session? {
        val access = json["access_token"]?.jsonPrimitive?.contentOrNull ?: return null
        val refresh = json["refresh_token"]?.jsonPrimitive?.contentOrNull ?: return null
        val user = json["user"]?.jsonObject ?: return null
        val uid = user["id"]?.jsonPrimitive?.contentOrNull ?: return null
        val email = user["email"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() } ?: fallbackEmail

        val expiresAt: Long? = json["expires_at"]?.jsonPrimitive?.doubleOrNull?.toLong()
            ?: json["expires_in"]?.jsonPrimitive?.doubleOrNull?.let { now() + it.toLong() }
            ?: Jwt.expiry(access)

        return Session(access, refresh, uid, email, expiresAt)
    }
}
