package app.mixbase.core.auth

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

data class AuthState(
    val isAuthenticated: Boolean = false,
    val userId: String? = null,
    val email: String? = null,
) {
    companion object {
        val SIGNED_OUT = AuthState()
    }
}

/**
 * Owns the Supabase session: persistence, restore, proactive refresh, and
 * sign-out. Port of ios/mixBase/Services/AuthService.swift.
 *
 * Policy, in order of importance:
 *  1. Restore OPTIMISTICALLY from storage without a network call — refresh
 *     tokens are long-lived, so holding one means the user has a session even
 *     if the ~1h access token is stale or the network is momentarily down.
 *  2. Only sign the user out when Supabase DEFINITIVELY rejects the refresh
 *     token (400/401). Network errors, 5xx and 429 keep the session.
 *  3. Coalesce concurrent refreshes (launch + foreground + a 401 retry) into
 *     one network call, and make every caller WAIT for it — two concurrent
 *     refreshes race over Supabase's rotating refresh tokens and invalidate
 *     the session.
 */
class SessionManager(
    private val auth: AuthClient,
    private val store: TokenStore,
    private val scope: CoroutineScope,
    private val now: () -> Long = { System.currentTimeMillis() / 1000 },
) {
    private val _state = MutableStateFlow(AuthState.SIGNED_OUT)
    val state: StateFlow<AuthState> = _state.asStateFlow()

    val isAuthenticated: Boolean get() = _state.value.isAuthenticated
    val userId: String? get() = _state.value.userId
    val accessToken: String? get() = store.get(TokenStore.ACCESS_TOKEN)

    /** Refresh once the access token is within this window of expiring. */
    private val refreshLeewaySeconds = 5 * 60L

    private val refreshMutex = Mutex()
    private var inFlight: Deferred<Boolean>? = null
    private var proactiveJob: Job? = null

    /** Fires after a successful sign-in / restore so the UI can prefetch (artist name etc.). */
    var onSessionEstablished: ((AuthState) -> Unit)? = null

    // ── Restore ─────────────────────────────────────────────────────────────

    /** Call once at app start. Restores from storage, then tops up the token in the background. */
    fun restore() {
        val token = store.get(TokenStore.ACCESS_TOKEN)
        val uid = store.get(TokenStore.USER_ID)
        val refresh = store.get(TokenStore.REFRESH_TOKEN)
        if (token == null || uid == null || refresh == null) return

        _state.value = AuthState(true, uid, store.get(TokenStore.USER_EMAIL))
        onSessionEstablished?.invoke(_state.value)
        scope.launch { ensureFreshToken() }
    }

    // ── Sign in / up ────────────────────────────────────────────────────────

    /** Returns null on success, otherwise the message to show. */
    suspend fun signIn(email: String, password: String): String? =
        handle(auth.signInWithPassword(email.trim(), password))

    suspend fun signUp(email: String, password: String): String? {
        val trimmed = email.trim()
        return when (val outcome = auth.signUp(trimmed, password)) {
            is AuthOutcome.Success -> { applySession(outcome.session); null }
            // Account created but no session returned (email confirmation on) — sign in.
            is AuthOutcome.Rejected -> if (outcome.status in 200..299) signIn(trimmed, password) else outcome.message
            is AuthOutcome.Transient -> outcome.message
        }
    }

    suspend fun signInWithIdToken(provider: String, idToken: String, nonce: String?): String? =
        handle(auth.signInWithIdToken(provider, idToken, nonce))

    private fun handle(outcome: AuthOutcome): String? = when (outcome) {
        is AuthOutcome.Success -> { applySession(outcome.session); null }
        is AuthOutcome.Rejected -> outcome.message
        is AuthOutcome.Transient -> outcome.message
    }

    // ── Keep the session warm ───────────────────────────────────────────────

    /** On launch and on every return to the foreground. A healthy token is left untouched. */
    suspend fun ensureFreshToken() {
        if (!isAuthenticated) return
        val exp = currentTokenExpiry()
        if (exp != null && exp - now() > refreshLeewaySeconds) {
            scheduleProactiveRefresh()
            return
        }
        refreshSession()
    }

    private fun scheduleProactiveRefresh() {
        proactiveJob?.cancel()
        val exp = currentTokenExpiry() ?: return
        val delaySeconds = maxOf(30L, exp - now() - refreshLeewaySeconds)
        proactiveJob = scope.launch {
            delay(delaySeconds * 1000)
            refreshSession()
        }
    }

    private fun currentTokenExpiry(): Long? =
        store.get(TokenStore.EXPIRES_AT)?.toLongOrNull()
            ?: store.get(TokenStore.ACCESS_TOKEN)?.let { Jwt.expiry(it) }

    /** Refreshes (coalesced). Returns true if the session is still valid afterwards. */
    suspend fun refreshSession(): Boolean {
        var owner = false
        val deferred = refreshMutex.withLock {
            inFlight ?: scope.async { performRefresh() }.also { inFlight = it; owner = true }
        }
        try {
            return deferred.await()
        } finally {
            if (owner) {
                withContext(NonCancellable) {
                    refreshMutex.withLock { if (inFlight === deferred) inFlight = null }
                }
            }
        }
    }

    private suspend fun performRefresh(): Boolean {
        val refreshToken = store.get(TokenStore.REFRESH_TOKEN)
        if (refreshToken == null) {
            signOut()
            return false
        }
        return when (val outcome = auth.refresh(refreshToken, store.get(TokenStore.USER_EMAIL) ?: "")) {
            is AuthOutcome.Success -> { applySession(outcome.session); true }
            // 400/401 = the refresh token itself is invalid/revoked. Only then bounce to login.
            is AuthOutcome.Rejected -> {
                if (outcome.status == 400 || outcome.status == 401) { signOut(); false } else isAuthenticated
            }
            is AuthOutcome.Transient -> isAuthenticated
        }
    }

    // ── Apply / clear ───────────────────────────────────────────────────────

    private fun applySession(session: Session) {
        store.put(TokenStore.ACCESS_TOKEN, session.accessToken)
        store.put(TokenStore.REFRESH_TOKEN, session.refreshToken)
        store.put(TokenStore.USER_ID, session.userId)
        store.put(TokenStore.USER_EMAIL, session.email)
        session.expiresAt?.let { store.put(TokenStore.EXPIRES_AT, it.toString()) } ?: store.remove(TokenStore.EXPIRES_AT)

        _state.value = AuthState(true, session.userId, session.email)
        scheduleProactiveRefresh()
        onSessionEstablished?.invoke(_state.value)
    }

    fun signOut() {
        proactiveJob?.cancel()
        proactiveJob = null
        TokenStore.ALL_KEYS.forEach { store.remove(it) }
        _state.value = AuthState.SIGNED_OUT
    }
}
