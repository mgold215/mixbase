package app.mixbase.core.auth

import app.mixbase.core.json.AppJson
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.util.Base64

object Jwt {
    /** Reads the `exp` claim (epoch seconds) WITHOUT verifying the signature — for refresh scheduling only. */
    fun expiry(token: String): Long? {
        val segments = token.split('.')
        if (segments.size != 3) return null
        return runCatching {
            val payload = Base64.getUrlDecoder().decode(padBase64(segments[1]))
            val json = AppJson.parseToJsonElement(String(payload, Charsets.UTF_8)).jsonObject
            json["exp"]?.jsonPrimitive?.longOrNull
        }.getOrNull()
    }

    private fun padBase64(s: String): String {
        var out = s.replace('-', '+').replace('_', '/')
        while (out.length % 4 != 0) out += "="
        return out
    }
}
