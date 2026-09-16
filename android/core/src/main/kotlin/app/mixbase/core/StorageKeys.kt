package app.mixbase.core

/**
 * Object keys for uploads. Supabase Storage keys are stored VERBATIM, so
 * project ids must be lowercase here and everywhere (see the iOS note on
 * UUID casing). Layout matches the iOS app so both platforms' files sit
 * side by side in the bucket.
 */
object StorageKeys {

    /** First mix of a brand-new project: "<project-id>-v1.<ext>". */
    fun firstVersionAudio(projectId: String, originalFilename: String): String =
        "${projectId.lowercase()}-v1.${extension(originalFilename, "wav")}"

    /** A later mix: "<project-id>-v<n>-<epoch>.<ext>". */
    fun versionAudio(projectId: String, nextVersionNumber: Int, originalFilename: String, epochSeconds: Long): String =
        "${projectId.lowercase()}-v$nextVersionNumber-$epochSeconds.${extension(originalFilename, "wav")}"

    /** Project cover uploaded from the device: "<project-id>-<epoch>.jpg". */
    fun projectArtwork(projectId: String, epochSeconds: Long): String = "${projectId.lowercase()}-$epochSeconds.jpg"

    fun extension(filename: String, fallback: String): String {
        val ext = filename.substringAfterLast('.', "").lowercase().filter { it.isLetterOrDigit() }
        return ext.ifEmpty { fallback }
    }
}
