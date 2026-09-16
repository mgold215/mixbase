package app.mixbase.core.model

/**
 * The version workflow: Mix → Master → Finished → Released.
 *
 * DISPLAY-ONLY mirror of src/lib/mix-status.ts (and the Swift copy in
 * ios/mixBase/Models/Version.swift). The upload path sends no label or
 * status — the SERVER parses the filename and is the one authority for what
 * a row IS. This exists so a "MASTER 2.wav" reads as "MASTER 2" in lists.
 */
object MixStatus {

    val ALL: List<String> = listOf("Mix", "Master", "Finished", "Released")

    data class ParsedName(val kind: String, val number: String?) {
        /** Canonical label ("MASTER 2"), or null for a bare token ("master.wav"). */
        val label: String? get() = number?.let { "${kind.uppercase()} $it" }
    }

    // Standalone-word tokens: "remaster"/"mixdown" must not match, "MASTER2",
    // "mix_3" and "Mix 3.1" must. Master is tested first so a name carrying
    // both ("mix master 2") reads as the master it is.
    private val kindTokens: List<Pair<String, Regex>> = listOf(
        "Master" to Regex("""(?:^|[^a-z])master(?:[\s._#-]*(\d+(?:\.\d+)*))?(?![a-z])""", RegexOption.IGNORE_CASE),
        "Mix" to Regex("""(?:^|[^a-z])mix(?:[\s._#-]*(\d+(?:\.\d+)*))?(?![a-z])""", RegexOption.IGNORE_CASE),
    )

    /** "MASTER 2.wav" → (Master, "2"); "master.wav" → (Master, null); unparseable → null. */
    fun parseName(name: String?): ParsedName? {
        if (name.isNullOrEmpty()) return null
        val base = name.replace(Regex("""\.[^.]+$"""), "")
        for ((kind, regex) in kindTokens) {
            val match = regex.find(base) ?: continue
            val number = match.groupValues.getOrNull(1)?.takeIf { it.isNotEmpty() }
            return ParsedName(kind, number)
        }
        return null
    }

    /** Collapse retired spellings ('WIP', 'Mix/Master') onto the current set. */
    fun normalize(status: String?): String = when (status) {
        "Master", "Mix/Master" -> "Master"
        "Finished", "Released" -> status
        else -> "Mix"
    }

    /** "Mix" or "Master": the artist's naming wins, then status (anything past Mix is master-stage). */
    fun kindName(label: String?, audioFilename: String?, status: String?): String {
        val parsed = parseName(label) ?: parseName(audioFilename)
        if (parsed != null) return parsed.kind
        return if (normalize(status) == "Mix") "Mix" else "Master"
    }

    /** Stored label → parsed filename ("MASTER 2") → "Mix N"/"Master N". */
    fun displayName(label: String?, audioFilename: String?, status: String?, versionNumber: Int): String {
        if (!label.isNullOrEmpty()) return label
        parseName(audioFilename)?.label?.let { return it }
        return "${kindName(label, audioFilename, status)} $versionNumber"
    }
}
