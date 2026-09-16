package app.mixbase.core.json

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * The one JSON configuration for every PostgREST / web-API payload.
 *
 * - unknown keys are ignored (the server adds columns without an app release)
 * - `null` for a non-nullable field with a default falls back to the default
 * - absent optional fields decode as null, and nulls are not written back
 */
val AppJson: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
    coerceInputValues = true
    explicitNulls = false
    encodeDefaults = false
}

/**
 * Parses the timestamp spellings PostgREST and Next.js actually emit:
 * `2026-01-01T00:00:00.123456+00:00`, `2026-01-01T00:00:00Z`, with or
 * without fractional seconds, a bare local date-time, or a date-only string.
 */
fun parseFlexibleInstant(raw: String): Instant? {
    val s = raw.trim()
    if (s.isEmpty()) return null
    runCatching { return OffsetDateTime.parse(s).toInstant() }
    runCatching { return Instant.parse(s) }
    runCatching { return LocalDateTime.parse(s).toInstant(ZoneOffset.UTC) }
    runCatching { return LocalDate.parse(s).atStartOfDay(ZoneOffset.UTC).toInstant() }
    return null
}

/** Parses `yyyy-MM-dd`, or the date part of a full timestamp. */
fun parseFlexibleLocalDate(raw: String): LocalDate? {
    val s = raw.trim()
    if (s.isEmpty()) return null
    runCatching { return LocalDate.parse(s) }
    return parseFlexibleInstant(s)?.atOffset(ZoneOffset.UTC)?.toLocalDate()
}

object FlexibleInstantSerializer : KSerializer<Instant> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("app.mixbase.FlexibleInstant", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): Instant {
        val raw = decoder.decodeString()
        return parseFlexibleInstant(raw) ?: throw SerializationException("Cannot decode date: $raw")
    }

    override fun serialize(encoder: Encoder, value: Instant) {
        encoder.encodeString(DateTimeFormatter.ISO_INSTANT.format(value))
    }
}

object FlexibleLocalDateSerializer : KSerializer<LocalDate> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("app.mixbase.FlexibleLocalDate", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): LocalDate {
        val raw = decoder.decodeString()
        return parseFlexibleLocalDate(raw) ?: throw SerializationException("Cannot decode date: $raw")
    }

    override fun serialize(encoder: Encoder, value: LocalDate) {
        encoder.encodeString(value.toString()) // yyyy-MM-dd — what mb_releases.release_date stores
    }
}

typealias Timestamp = @kotlinx.serialization.Serializable(with = FlexibleInstantSerializer::class) Instant
typealias DateOnly = @kotlinx.serialization.Serializable(with = FlexibleLocalDateSerializer::class) LocalDate
