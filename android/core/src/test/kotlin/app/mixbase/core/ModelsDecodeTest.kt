package app.mixbase.core

import app.mixbase.core.json.AppJson
import app.mixbase.core.json.parseFlexibleInstant
import app.mixbase.core.model.Activity
import app.mixbase.core.model.FeedItem
import app.mixbase.core.model.Project
import app.mixbase.core.model.Release
import app.mixbase.core.model.Version
import app.mixbase.core.model.formatBytes
import app.mixbase.core.model.formatClock
import kotlinx.serialization.builtins.ListSerializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

class ModelsDecodeTest {

    @Test
    fun `parses every timestamp spelling PostgREST and Next emit`() {
        assertEquals(Instant.parse("2026-01-02T03:04:05.123456Z"), parseFlexibleInstant("2026-01-02T03:04:05.123456+00:00"))
        assertEquals(Instant.parse("2026-01-02T03:04:05Z"), parseFlexibleInstant("2026-01-02T03:04:05Z"))
        assertEquals(Instant.parse("2026-01-02T03:04:05Z"), parseFlexibleInstant("2026-01-02T03:04:05"))
        assertEquals(Instant.parse("2026-01-02T00:00:00Z"), parseFlexibleInstant("2026-01-02"))
        assertNull(parseFlexibleInstant("not a date"))
    }

    @Test
    fun `project row decodes with unknown columns and nulls`() {
        val json = """
            [{"id":"11111111-1111-1111-1111-111111111111","user_id":"u","title":"Song","artwork_url":null,
              "genre":"House","bpm":128,"key_signature":null,"visualizer_url":null,"finalized_artwork_url":"x",
              "share_token":"tok","created_at":"2026-05-01T10:00:00.5+00:00","updated_at":"2026-05-02T10:00:00+00:00"}]
        """.trimIndent()
        val projects = AppJson.decodeFromString(ListSerializer(Project.serializer()), json)
        assertEquals(1, projects.size)
        assertEquals("Song", projects[0].title)
        assertEquals(128, projects[0].bpm)
        assertNull(projects[0].artworkUrl)
        assertEquals("tok", projects[0].shareToken)
    }

    @Test
    fun `version row decodes with loudness nulls and missing allow_download`() {
        val json = """
            {"id":"v1","project_id":"p1","version_number":2,"label":null,"audio_url":"https://s/a.wav",
             "audio_filename":"MASTER 2.wav","duration_seconds":201,"file_size_bytes":52428800,"status":"Master",
             "share_token":null,"created_at":"2026-05-01T10:00:00+00:00","loudness_lufs":null}
        """.trimIndent()
        val v = AppJson.decodeFromString(Version.serializer(), json)
        assertEquals("MASTER 2", v.displayName)
        assertEquals(52428800L, v.fileSizeBytes)
        assertFalse(v.allowDownload)
        assertNull(v.loudnessLufs)
    }

    @Test
    fun `release decodes date-only release_date and computes progress`() {
        val json = """
            {"id":"r","title":"EP","release_date":"2026-09-30","project_id":null,"mixing_done":true,"mastering_done":true,
             "artwork_ready":false,"dsp_submitted":false,"social_posts_done":false,"press_release_done":false,
             "dsp_spotify":true,"created_at":"2026-05-01T10:00:00Z","updated_at":"2026-05-01T10:00:00Z"}
        """.trimIndent()
        val r = AppJson.decodeFromString(Release.serializer(), json)
        assertEquals(LocalDate.of(2026, 9, 30), r.releaseDate)
        assertEquals(2f / 6f, r.progress, 0.0001f)
        assertTrue(r.dspSpotify)
        assertFalse(r.dspTidal)
    }

    @Test
    fun `activity with null project_id decodes`() {
        val a = AppJson.decodeFromString(Activity.serializer(), """{"id":"a","type":"project_created","project_id":null,"created_at":"2026-05-01T10:00:00Z"}""")
        assertNull(a.projectId)
        assertEquals("project_created", a.type)
    }

    @Test
    fun `feed item decodes nested comments and older mixes`() {
        val json = """
            {"version_id":"v","project_id":"p","user_id":"u","title":"T","artist":"A","version_label":"MIX 2",
             "artwork_url":null,"audio_url":"https://s/a.mp3","created_at":"2026-05-01T10:00:00Z",
             "comments":[{"id":"c","version_id":"v","user_id":"u2","artist":"B","comment":"nice","created_at":"2026-05-01T11:00:00Z"}],
             "older":[{"version_id":"v0","version_label":"MIX 1","audio_url":"https://s/b.mp3","created_at":"2026-04-01T10:00:00Z"}]}
        """.trimIndent()
        val item = AppJson.decodeFromString(FeedItem.serializer(), json)
        assertEquals(1, item.comments.size)
        assertEquals("MIX 1", item.older[0].versionLabel)
        assertNotNull(item.createdAt)
    }

    @Test
    fun `formatting helpers`() {
        assertEquals("2:05", formatClock(125L))
        assertEquals("1:02:05", formatClock(3725L))
        assertEquals("0:00", formatClock(-3L))
        assertEquals("50.0 MB", formatBytes(52428800L))
        assertEquals("512 B", formatBytes(512L))
    }
}
