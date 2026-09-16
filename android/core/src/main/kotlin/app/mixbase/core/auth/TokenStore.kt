package app.mixbase.core.auth

/**
 * Persistent, private key/value storage for session tokens. The Android app
 * backs this with EncryptedSharedPreferences (the Keychain equivalent); tests
 * use [InMemoryTokenStore].
 */
interface TokenStore {
    fun get(key: String): String?
    fun put(key: String, value: String)
    fun remove(key: String)

    companion object {
        const val ACCESS_TOKEN = "access_token"
        const val REFRESH_TOKEN = "refresh_token"
        const val USER_ID = "user_id"
        const val USER_EMAIL = "user_email"
        const val EXPIRES_AT = "expires_at"
        val ALL_KEYS = listOf(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, USER_EMAIL, EXPIRES_AT)
    }
}

class InMemoryTokenStore : TokenStore {
    private val map = mutableMapOf<String, String>()
    override fun get(key: String): String? = synchronized(map) { map[key] }
    override fun put(key: String, value: String) = synchronized(map) { map[key] = value }
    override fun remove(key: String) { synchronized(map) { map.remove(key) } }
}
