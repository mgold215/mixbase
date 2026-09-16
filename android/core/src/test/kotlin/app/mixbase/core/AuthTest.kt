package app.mixbase.core

import app.mixbase.core.auth.AuthClient
import app.mixbase.core.auth.AuthOutcome
import app.mixbase.core.auth.InMemoryTokenStore
import app.mixbase.core.auth.Jwt
import app.mixbase.core.auth.SessionManager
import app.mixbase.core.auth.TokenStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.Base64

class AuthTest {

    private lateinit var server: MockWebServer
    private val http = OkHttpClient()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Before fun setUp() { server = MockWebServer(); server.start() }
    @After fun tearDown() { server.shutdown(); scope.cancel() }

    private fun jwt(exp: Long): String {
        val enc = Base64.getUrlEncoder().withoutPadding()
        val header = enc.encodeToString("""{"alg":"HS256","typ":"JWT"}""".toByteArray())
        val payload = enc.encodeToString("""{"sub":"u1","exp":$exp}""".toByteArray())
        return "$header.$payload.sig"
    }

    private fun sessionJson(access: String, refresh: String = "r1", email: String = "a@b.c") =
        """{"access_token":"$access","refresh_token":"$refresh","expires_in":3600,"token_type":"bearer","user":{"id":"u1","email":"$email"}}"""

    @Test
    fun `jwt expiry decodes unverified exp claim`() {
        assertEquals(1_800_000_000L, Jwt.expiry(jwt(1_800_000_000L)))
        assertNull(Jwt.expiry("garbage"))
    }

    @Test
    fun `sign in sends apikey and parses session`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(sessionJson(jwt(9_999_999_999L))))
        val client = AuthClient(http, server.url("/").toString().trimEnd('/'), "anon", now = { 1000 })

        val outcome = client.signInWithPassword("a@b.c", "pw")
        val recorded = server.takeRequest()

        assertEquals("/auth/v1/token?grant_type=password", recorded.path)
        assertEquals("anon", recorded.getHeader("apikey"))
        assertTrue(recorded.body.readUtf8().contains("\"email\":\"a@b.c\""))
        val session = (outcome as AuthOutcome.Success).session
        assertEquals("u1", session.userId)
        assertEquals(1000L + 3600L, session.expiresAt)
    }

    @Test
    fun `rejected sign in surfaces supabase error_description`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"invalid_grant","error_description":"Invalid login credentials"}"""))
        val client = AuthClient(http, server.url("/").toString().trimEnd('/'), "anon")
        val outcome = client.signInWithPassword("a@b.c", "pw")
        assertEquals(AuthOutcome.Rejected(400, "Invalid login credentials"), outcome)
    }

    @Test
    fun `5xx is transient not a rejection`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"msg":"down"}"""))
        val client = AuthClient(http, server.url("/").toString().trimEnd('/'), "anon")
        assertTrue(client.refresh("r", "") is AuthOutcome.Transient)
    }

    @Test
    fun `session manager restores optimistically and signs out only on 400 or 401`() = runBlocking {
        val store = InMemoryTokenStore()
        store.put(TokenStore.ACCESS_TOKEN, jwt(0))
        store.put(TokenStore.REFRESH_TOKEN, "r-old")
        store.put(TokenStore.USER_ID, "u1")
        store.put(TokenStore.USER_EMAIL, "a@b.c")
        // A healthy stored expiry keeps restore() off the network, so every
        // refresh below is the explicit one this test drives.
        store.put(TokenStore.EXPIRES_AT, "9999999999")

        val client = AuthClient(http, server.url("/").toString().trimEnd('/'), "anon", now = { 1000 })
        val manager = SessionManager(client, store, scope, now = { 1000 })
        manager.restore()
        assertTrue(manager.isAuthenticated)
        assertEquals("a@b.c", manager.state.value.email)

        // Transient failure keeps the session.
        server.enqueue(MockResponse().setResponseCode(500).setBody("{}"))
        assertTrue(manager.refreshSession())
        assertTrue(manager.isAuthenticated)
        assertEquals("r-old", store.get(TokenStore.REFRESH_TOKEN))

        // Successful refresh rotates tokens.
        server.enqueue(MockResponse().setResponseCode(200).setBody(sessionJson(jwt(5000), refresh = "r-new")))
        assertTrue(manager.refreshSession())
        assertEquals("r-new", store.get(TokenStore.REFRESH_TOKEN))
        assertEquals("4600", store.get(TokenStore.EXPIRES_AT)) // now(1000) + expires_in(3600)

        // Definitive rejection clears everything.
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error_description":"Invalid Refresh Token"}"""))
        assertFalse(manager.refreshSession())
        assertFalse(manager.isAuthenticated)
        assertNull(store.get(TokenStore.ACCESS_TOKEN))
        assertEquals(3, server.requestCount)
    }

    @Test
    fun `concurrent refreshes coalesce into one network call`() = runBlocking {
        val store = InMemoryTokenStore()
        store.put(TokenStore.ACCESS_TOKEN, jwt(0))
        store.put(TokenStore.REFRESH_TOKEN, "r1")
        store.put(TokenStore.USER_ID, "u1")
        store.put(TokenStore.EXPIRES_AT, "9999999999")
        val client = AuthClient(http, server.url("/").toString().trimEnd('/'), "anon", now = { 1000 })
        val manager = SessionManager(client, store, scope, now = { 1000 })
        manager.restore()

        server.enqueue(MockResponse().setResponseCode(200).setBody(sessionJson(jwt(1000), refresh = "r3")).setBodyDelay(200, java.util.concurrent.TimeUnit.MILLISECONDS))
        val results = (1..5).map { async { manager.refreshSession() } }.awaitAll()
        assertTrue(results.all { it })
        assertEquals(1, server.requestCount)
        assertEquals("r3", store.get(TokenStore.REFRESH_TOKEN))
    }
}
