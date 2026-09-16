package app.mixbase.core

import app.mixbase.core.api.MixbaseApi
import app.mixbase.core.auth.AuthClient
import app.mixbase.core.auth.InMemoryTokenStore
import app.mixbase.core.auth.SessionManager
import app.mixbase.core.auth.TokenStore
import app.mixbase.core.supabase.SupabaseClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.time.LocalDate

class ClientsTest {

    private lateinit var server: MockWebServer
    private val http = OkHttpClient()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var store: InMemoryTokenStore
    private lateinit var session: SessionManager
    private lateinit var base: String

    @Before
    fun setUp() {
        server = MockWebServer(); server.start()
        base = server.url("/").toString().trimEnd('/')
        store = InMemoryTokenStore()
        store.put(TokenStore.ACCESS_TOKEN, "tok1")
        store.put(TokenStore.REFRESH_TOKEN, "r1")
        store.put(TokenStore.USER_ID, "u1")
        store.put(TokenStore.EXPIRES_AT, "9999999999")
        session = SessionManager(AuthClient(http, base, "anon"), store, scope)
        session.restore()
    }

    @After fun tearDown() { server.shutdown(); scope.cancel() }

    private val projectRow = """{"id":"p1","title":"Song","created_at":"2026-05-01T10:00:00Z","updated_at":"2026-05-01T10:00:00Z"}"""

    @Test
    fun `postgrest requests carry apikey bearer and prefer headers`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(201).setBody("[$projectRow]"))
        val client = SupabaseClient(http, session, base, "anon")

        val project = client.createProject("Song", "House", 128)
        val req = server.takeRequest()

        assertEquals("p1", project.id)
        assertEquals("/rest/v1/mb_projects", req.path)
        assertEquals("anon", req.getHeader("apikey"))
        assertEquals("Bearer tok1", req.getHeader("Authorization"))
        assertEquals("return=representation", req.getHeader("Prefer"))
        val body = req.body.readUtf8()
        assertTrue(body.contains("\"user_id\":\"u1\""))
        assertTrue(body.contains("\"bpm\":128"))
    }

    @Test
    fun `a 401 refreshes the session and retries once with the new token`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"message":"JWT expired"}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"access_token":"tok2","refresh_token":"r2","expires_in":3600,"user":{"id":"u1","email":"a@b.c"}}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody("[$projectRow]"))
        val client = SupabaseClient(http, session, base, "anon")

        val projects = client.fetchProjects()

        assertEquals(1, projects.size)
        assertEquals("Bearer tok1", server.takeRequest().getHeader("Authorization"))
        assertEquals("/auth/v1/token?grant_type=refresh_token", server.takeRequest().path)
        assertEquals("Bearer tok2", server.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun `server errors surface the postgrest message`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"code":"23505","message":"duplicate key"}"""))
        val client = SupabaseClient(http, session, base, "anon")
        try {
            client.fetchProjects(); fail("expected failure")
        } catch (e: MixbaseException.Server) {
            assertEquals(409, e.status)
            assertEquals("duplicate key", e.displayMessage)
        }
    }

    @Test
    fun `release patch serialises dates booleans and nulls`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("[]"))
        val client = SupabaseClient(http, session, base, "anon")
        client.updateRelease("r1", mapOf("mixing_done" to true, "release_date" to LocalDate.of(2026, 9, 30), "notes" to null))
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"mixing_done\":true"))
        assertTrue(body.contains("\"release_date\":\"2026-09-30\""))
        assertTrue(body.contains("\"notes\":null"))
    }

    @Test
    fun `storage upload posts to the object path with upsert and returns the public url`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"Key":"mf-audio/p1-v1.wav"}"""))
        val client = SupabaseClient(http, session, base, "anon")
        val url = client.uploadBytes("mf-audio", "p1-v1.wav", byteArrayOf(1, 2, 3))
        val req = server.takeRequest()
        assertEquals("/storage/v1/object/mf-audio/p1-v1.wav", req.path)
        assertEquals("true", req.getHeader("x-upsert"))
        assertEquals("audio/wav", req.getHeader("Content-Type"))
        assertEquals("$base/storage/v1/object/public/mf-audio/p1-v1.wav", url)
    }

    @Test
    fun `createVersion never sends allow_download status or label`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(201).setBody(
            """{"id":"v1","project_id":"p1","version_number":1,"audio_url":"https://s/a.wav","audio_filename":"MASTER 2.wav","status":"Master","label":"MASTER 2","allow_download":true,"created_at":"2026-05-01T10:00:00Z"}"""
        ))
        val api = MixbaseApi(http, session, base)
        val version = api.createVersion("p1", "https://s/a.wav", audioFilename = "MASTER 2.wav", durationSeconds = 200, fileSizeBytes = 123L)
        val req = server.takeRequest()
        val body = req.body.readUtf8()
        assertEquals("/api/versions", req.path)
        assertEquals("Bearer tok1", req.getHeader("Authorization"))
        assertFalse(body.contains("allow_download"))
        assertFalse(body.contains("\"status\""))
        assertFalse(body.contains("\"label\""))
        assertTrue(body.contains("\"audio_filename\":\"MASTER 2.wav\""))
        assertEquals("MASTER 2", version.displayName)
        assertTrue(version.allowDownload)
    }

    @Test
    fun `allowance errors and purchase copy are neutralised`() = runBlocking {
        val api = MixbaseApi(http, session, base)

        server.enqueue(MockResponse().setResponseCode(402).setBody("""{"error":"Upgrade to generate more","upgrade":true}"""))
        try { api.generateArtwork("p1", "x", "flux-ultra", false); fail() } catch (e: MixbaseException.Server) {
            assertEquals(MixbaseApi.LIMIT_MESSAGE, e.displayMessage)
        }

        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"Your plan does not include this"}"""))
        try { api.generateArtwork("p1", "x", "flux-ultra", false); fail() } catch (e: MixbaseException.Server) {
            assertEquals(MixbaseApi.NEUTRAL_MESSAGE, e.displayMessage)
        }

        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"Prompt is required"}"""))
        try { api.generateArtwork("p1", "", "flux-ultra", false); fail() } catch (e: MixbaseException.Server) {
            assertEquals("Prompt is required", e.displayMessage)
        }
    }

    @Test
    fun `feed drops a malformed row instead of blanking the feed`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """[{"version_id":"v","project_id":"p","user_id":"u","title":"T","artist":"A","version_label":"MIX 1","audio_url":"https://s/a.mp3","created_at":"2026-05-01T10:00:00Z","comments":[],"older":[]},
                {"version_id":"broken"}]"""
        ))
        val api = MixbaseApi(http, session, base)
        val feed = api.fetchFeed()
        assertEquals(1, feed.size)
        assertEquals("T", feed[0].title)
    }

    @Test
    fun `storage keys use lowercase ids and preserve extensions`() {
        assertEquals("abc-v1.wav", StorageKeys.firstVersionAudio("ABC", "Song.WAV"))
        assertEquals("abc-v3-1700000000.mp3", StorageKeys.versionAudio("abc", 3, "final.mp3", 1700000000L))
        assertEquals("abc-v1.wav", StorageKeys.firstVersionAudio("abc", "noext"))
        assertEquals("abc-1.jpg", StorageKeys.projectArtwork("ABC", 1))
    }
}
