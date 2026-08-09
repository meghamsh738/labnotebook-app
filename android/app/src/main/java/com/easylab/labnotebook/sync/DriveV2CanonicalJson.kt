package com.easylab.labnotebook.sync

import java.math.BigDecimal
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

internal class DriveV2ContractException(
    val code: String,
    cause: Throwable? = null,
) : IllegalArgumentException(code, cause)

internal object DriveV2CanonicalJson {
    private val parser = Json {
        ignoreUnknownKeys = false
        isLenient = false
        explicitNulls = true
    }

    fun decodeCanonicalObject(bytes: ByteArray): JsonObject {
        if (
            bytes.size >= 3 &&
            bytes[0] == 0xef.toByte() &&
            bytes[1] == 0xbb.toByte() &&
            bytes[2] == 0xbf.toByte()
        ) {
            fail("noncanonical-json-bytes")
        }
        val text = decodeUtf8(bytes)
        if (!text.toByteArray(StandardCharsets.UTF_8).contentEquals(bytes)) {
            fail("noncanonical-json-bytes")
        }
        val element = try {
            parser.parseToJsonElement(text)
        } catch (error: Throwable) {
            fail("malformed-json", error)
        }
        val objectValue = element as? JsonObject ?: fail("artifact-schema-mismatch")
        if (encode(objectValue) != text) fail("noncanonical-json-bytes")
        return objectValue
    }

    fun encode(value: JsonElement): String {
        requireUnicodeScalars(value)
        return when (value) {
            JsonNull -> "null"
            is JsonArray -> value.joinToString(prefix = "[", postfix = "]", separator = ",") { encode(it) }
            is JsonObject -> value.entries
                .sortedBy(Map.Entry<String, JsonElement>::key)
                .joinToString(prefix = "{", postfix = "}", separator = ",") { (key, nested) ->
                    "${encodeString(key)}:${encode(nested)}"
                }
            is JsonPrimitive -> when {
                value.isString -> encodeString(value.content)
                value.booleanOrNull != null -> value.content
                else -> encodeNumber(value.content)
            }
        }
    }

    fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

    fun sha256(value: JsonElement): String = sha256(encode(value).toByteArray(StandardCharsets.UTF_8))

    private fun decodeUtf8(bytes: ByteArray): String = try {
        StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (error: Throwable) {
        fail("invalid-utf8", error)
    }

    private fun encodeString(value: String): String = JsonPrimitive(value).toString()

    /**
     * JCS uses ECMAScript number formatting. EasyLab's persisted domain payloads
     * use integers; the exponent forms below are retained for the shared JCS
     * vectors. Values that cannot be represented as finite IEEE-754 numbers are
     * rejected instead of being hashed differently by another client.
     */
    private fun encodeNumber(raw: String): String {
        val value = raw.toDoubleOrNull() ?: fail("invalid-json-number")
        if (!value.isFinite()) fail("invalid-json-number")
        if (value == 0.0) return "0"
        val decimal = BigDecimal.valueOf(value).stripTrailingZeros()
        val magnitude = kotlin.math.abs(value)
        return if (magnitude >= 1e21 || magnitude < 1e-6) {
            if (magnitude < java.lang.Double.MIN_NORMAL) fail("unsupported-rfc8785-number")
            val scientific = decimal.toString().lowercase()
            val (coefficient, exponentText) = scientific.split('e', limit = 2)
                .takeIf { it.size == 2 }
                ?: fail("unsupported-rfc8785-number")
            val coefficientValue = coefficient.removeSuffix(".0")
            if (coefficientValue.count(Char::isDigit) > 15) fail("unsupported-rfc8785-number")
            val exponent = exponentText.toIntOrNull() ?: fail("unsupported-rfc8785-number")
            val candidate = "$coefficientValue" + "e" + (if (exponent >= 0) "+" else "") + exponent
            requireStableNumber(candidate, value)
        } else {
            requireStableNumber(decimal.toPlainString(), value)
        }
    }

    private fun requireStableNumber(candidate: String, expected: Double): String {
        if (candidate.toDoubleOrNull() != expected) fail("unsupported-rfc8785-number")
        return candidate
    }

    private fun requireUnicodeScalars(value: JsonElement) {
        when (value) {
            is JsonArray -> value.forEach(::requireUnicodeScalars)
            is JsonObject -> value.forEach { (key, nested) ->
                requireUnicodeScalars(key)
                requireUnicodeScalars(nested)
            }
            is JsonPrimitive -> if (value.isString) requireUnicodeScalars(value.content)
        }
    }

    private fun requireUnicodeScalars(value: String) {
        var index = 0
        while (index < value.length) {
            val current = value[index]
            when {
                current.isHighSurrogate() -> {
                    if (index + 1 >= value.length || !value[index + 1].isLowSurrogate()) {
                        fail("invalid-unicode-scalar")
                    }
                    index += 2
                }
                current.isLowSurrogate() -> fail("invalid-unicode-scalar")
                else -> index += 1
            }
        }
    }

    private fun fail(code: String, cause: Throwable? = null): Nothing =
        throw DriveV2ContractException(code, cause)
}
