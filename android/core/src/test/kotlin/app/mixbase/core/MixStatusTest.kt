package app.mixbase.core

import app.mixbase.core.model.MixStatus
import app.mixbase.core.model.Version
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

class MixStatusTest {

    @Test
    fun `parses numbered master and mix tokens`() {
        assertEquals(MixStatus.ParsedName("Master", "2"), MixStatus.parseName("MASTER 2.wav"))
        assertEquals("MASTER 2", MixStatus.parseName("MASTER 2.wav")?.label)
        assertEquals(MixStatus.ParsedName("Mix", "3.1"), MixStatus.parseName("Mix 3.1.aiff"))
        assertEquals(MixStatus.ParsedName("Master", "2"), MixStatus.parseName("MASTER2.wav"))
        assertEquals(MixStatus.ParsedName("Mix", "3"), MixStatus.parseName("song_mix_3.mp3"))
    }

    @Test
    fun `bare tokens carry no number and no label`() {
        val parsed = MixStatus.parseName("master.wav")
        assertEquals("Master", parsed?.kind)
        assertNull(parsed?.number)
        assertNull(parsed?.label)
    }

    @Test
    fun `remaster mixdown and mastering do not match`() {
        assertNull(MixStatus.parseName("remaster.wav"))
        assertNull(MixStatus.parseName("mixdown.wav"))
        assertNull(MixStatus.parseName("mastering session.wav"))
        assertNull(MixStatus.parseName(null))
        assertNull(MixStatus.parseName(""))
    }

    @Test
    fun `master wins when a name carries both tokens`() {
        assertEquals("Master", MixStatus.parseName("mix master 2.wav")?.kind)
    }

    @Test
    fun `display name chain - label, then filename, then kind and number`() {
        assertEquals("Rough Mix", MixStatus.displayName("Rough Mix", "MASTER 2.wav", "Mix", 4))
        assertEquals("MASTER 2", MixStatus.displayName(null, "MASTER 2.wav", "Mix", 4))
        assertEquals("Master 4", MixStatus.displayName(null, "master.wav", "Mix", 4))
        assertEquals("Mix 1", MixStatus.displayName(null, "bounce.wav", "Mix", 1))
        assertEquals("Master 7", MixStatus.displayName(null, null, "Released", 7))
        assertEquals("Master 2", MixStatus.displayName(null, null, "Mix/Master", 2))
    }

    @Test
    fun `version exposes the same chain`() {
        val v = Version(
            id = "a", projectId = "p", versionNumber = 3, label = null, audioUrl = "https://x/y.wav",
            audioFilename = "MIX 3.wav", status = "Mix", createdAt = Instant.EPOCH,
        )
        assertEquals("MIX 3", v.displayName)
        assertEquals("Mix", v.kindName)
    }

    @Test
    fun `normalize folds retired spellings`() {
        assertEquals("Master", MixStatus.normalize("Mix/Master"))
        assertEquals("Mix", MixStatus.normalize("WIP"))
        assertEquals("Released", MixStatus.normalize("Released"))
        assertEquals("Mix", MixStatus.normalize(null))
    }
}
