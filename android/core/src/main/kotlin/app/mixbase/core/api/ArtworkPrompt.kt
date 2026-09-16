package app.mixbase.core.api

/**
 * Builds a rich visual prompt from a track's metadata locally — no API call,
 * instant, works offline. Genre drives palette/mood, BPM drives energy, and a
 * rotating set of compositions keeps repeat taps fresh.
 * Port of ArtworkService.buildPrompt (iOS).
 */
object ArtworkPrompt {

    private val compositions = listOf(
        "centered symmetrical composition with generous negative space",
        "dramatic low-angle perspective with strong leading lines",
        "extreme close-up with shallow depth of field",
        "wide establishing shot with a lone focal subject",
        "overhead top-down composition with graphic repetition",
    )

    fun build(title: String, genre: String?, bpm: Int?, random: kotlin.random.Random = kotlin.random.Random.Default): String {
        val g = (genre ?: "").lowercase()
        val (palette, scene) = when {
            listOf("house", "techno", "edm", "dance").any { g.contains(it) } ->
                "neon teal and magenta against deep black" to "an abstract nightclub lightscape with volumetric beams and haze"
            listOf("hip", "rap", "trap").any { g.contains(it) } ->
                "high-contrast gold and charcoal" to "a moody urban scene at night, wet streets reflecting city lights"
            listOf("ambient", "chill", "lo-fi", "lofi").any { g.contains(it) } ->
                "soft pastel gradients of dusk blue and warm peach" to "a dreamlike minimal landscape dissolving into fog"
            listOf("rock", "metal", "punk").any { g.contains(it) } ->
                "gritty monochrome with a single blood-red accent" to "raw textured surfaces, torn paper and analog grain"
            listOf("jazz", "soul", "funk").any { g.contains(it) } ->
                "rich amber, burgundy and brass tones" to "a smoky intimate stage lit by a single warm spotlight"
            g.contains("pop") ->
                "vivid candy colors with glossy highlights" to "a bold playful studio set with clean geometric shapes"
            listOf("folk", "acoustic", "country").any { g.contains(it) } ->
                "earthy ochre, sage and cream" to "golden-hour light over an open natural landscape"
            else -> "a striking duotone palette" to "an evocative abstract composition with strong depth"
        }

        val energy = when (bpm ?: 0) {
            in 1..89 -> "slow, contemplative atmosphere"
            in 90..119 -> "steady, confident energy"
            in 120..139 -> "driving, kinetic energy"
            in 140..Int.MAX_VALUE -> "frenetic, high-voltage intensity"
            else -> "balanced, cinematic mood"
        }

        val composition = compositions[random.nextInt(compositions.size)]
        return "Album artwork evoking \"$title\": $scene, $palette, $energy, $composition. No text or typography."
    }
}
