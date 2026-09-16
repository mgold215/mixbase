package app.mixbase.android.auth

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import app.mixbase.core.auth.TokenStore

/**
 * Keychain equivalent: session tokens in EncryptedSharedPreferences (AES-256,
 * key in the Android Keystore). If the Keystore is unavailable or corrupted
 * (it happens after some OS restores) we fall back to a plain private prefs
 * file rather than crash-looping at launch — and the fallback file is
 * separate, so a later successful encrypted open never reads plaintext.
 */
class EncryptedTokenStore(context: Context) : TokenStore {

    private val prefs: SharedPreferences = try {
        val masterKey = MasterKey.Builder(context, MasterKey.DEFAULT_MASTER_KEY_ALIAS)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "mixbase_session",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (e: Exception) {
        Log.w("EncryptedTokenStore", "Encrypted prefs unavailable, using private prefs", e)
        context.getSharedPreferences("mixbase_session_fallback", Context.MODE_PRIVATE)
    }

    override fun get(key: String): String? = prefs.getString(key, null)

    override fun put(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }

    override fun remove(key: String) {
        prefs.edit().remove(key).apply()
    }
}
