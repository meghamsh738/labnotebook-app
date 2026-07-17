package com.easylab.labnotebook.ui

import com.easylab.labnotebook.data.local.ProtocolEntity
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

data class ProtocolSection(
    val id: String,
    val title: String,
    val body: String = "",
    val guide: String? = null,
)

enum class ProtocolTemplate { Blank, Guided }

data class ProtocolEditorDraft(
    val title: String,
    val sections: List<ProtocolSection>,
) {
    companion object {
        fun from(protocol: ProtocolEntity) = ProtocolEditorDraft(
            title = protocol.title,
            sections = ProtocolContentCodec.decode(protocol.contentJson),
        )
    }
}

object ProtocolContentCodec {
    const val MAX_CONTENT_CHARS = 1_000_000

    fun template(template: ProtocolTemplate): List<ProtocolSection> = when (template) {
        ProtocolTemplate.Blank -> emptyList()
        ProtocolTemplate.Guided -> listOf(
            ProtocolSection(
                id = sectionId(),
                title = "Aim",
                guide = "Summarize the purpose, scope, and expected outcome.",
            ),
            ProtocolSection(
                id = sectionId(),
                title = "Materials",
                guide = "List reagents, equipment, concentrations, and preparation notes.",
            ),
            ProtocolSection(
                id = sectionId(),
                title = "Procedure",
                guide = "Record each step with timing, temperature, and critical settings.",
            ),
            ProtocolSection(
                id = sectionId(),
                title = "Notes",
                guide = "Capture troubleshooting advice, checkpoints, and safety considerations.",
            ),
        )
    }

    /**
     * The bounded native editor only rewrites heading/paragraph documents it fully understands.
     * Richer web blocks remain readable but are never silently flattened or discarded on save.
     */
    fun isSafelyEditable(raw: String): Boolean {
        if (raw.length > MAX_CONTENT_CHARS) return false
        val blocks = runCatching { Json.parseToJsonElement(raw) as? JsonArray }.getOrNull() ?: return false
        if (blocks.size % 2 != 0) return false

        val sectionIds = mutableSetOf<String>()
        return blocks.chunked(2).all { (headingElement, paragraphElement) ->
            val heading = headingElement as? JsonObject ?: return@all false
            val paragraph = paragraphElement as? JsonObject ?: return@all false
            val headingId = heading.requiredString("id") ?: return@all false
            val headingText = heading.requiredString("text") ?: return@all false
            val paragraphId = paragraph.requiredString("id") ?: return@all false

            heading.keys == HEADING_FIELDS &&
                heading.requiredString("type") == "heading" &&
                heading.primitiveInt("level") == 2 &&
                headingId.isNotBlank() &&
                headingText.isNotBlank() &&
                headingText == headingText.trim() &&
                heading.requiredString("updatedAt")?.isNotBlank() == true &&
                heading.requiredString("updatedBy")?.isNotBlank() == true &&
                sectionIds.add(headingId) &&
                paragraph.keys.let { it == PARAGRAPH_FIELDS || it == PARAGRAPH_FIELDS_WITH_GUIDE } &&
                paragraph.requiredString("type") == "paragraph" &&
                paragraphId == "$headingId-body" &&
                paragraph.requiredString("text") != null &&
                paragraph.requiredString("updatedAt")?.isNotBlank() == true &&
                paragraph.requiredString("updatedBy")?.isNotBlank() == true &&
                (!paragraph.containsKey("guide") || paragraph.requiredString("guide")?.isNotBlank() == true)
        }
    }

    fun decode(raw: String): List<ProtocolSection> {
        if (raw.length > MAX_CONTENT_CHARS) return emptyList()
        val blocks = runCatching { Json.parseToJsonElement(raw) as? JsonArray }.getOrNull() ?: return emptyList()
        val sections = mutableListOf<ProtocolSection>()

        fun appendText(text: String, guide: String? = null) {
            if (text.isBlank() && guide.isNullOrBlank()) return
            val current = sections.lastOrNull()
            if (current == null) {
                sections += ProtocolSection(sectionId(), "Overview", text, guide)
            } else {
                sections[sections.lastIndex] = current.copy(
                    body = listOf(current.body, text).filter { it.isNotBlank() }.joinToString("\n\n"),
                    guide = current.guide ?: guide,
                )
            }
        }

        blocks.forEach { element ->
            val block = element as? JsonObject ?: return@forEach
            val type = block["type"]?.jsonPrimitive?.contentOrNull ?: return@forEach
            val id = block["id"]?.jsonPrimitive?.contentOrNull ?: sectionId()
            when (type) {
                "heading" -> {
                    val level = block["level"]?.jsonPrimitive?.intOrNull ?: 2
                    val text = block["text"]?.jsonPrimitive?.contentOrNull.orEmpty()
                    if (level == 2) sections += ProtocolSection(id, text.ifBlank { "Untitled section" })
                    else appendText(text)
                }
                "paragraph", "quote" -> appendText(
                    block["text"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    block["guide"]?.jsonPrimitive?.contentOrNull,
                )
                "checklist", "list" -> {
                    val lines = runCatching { block["items"]?.jsonArray }.getOrNull().orEmpty().mapNotNull { item ->
                        val itemObject = item as? JsonObject ?: return@mapNotNull null
                        itemObject["text"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank)
                    }
                    appendText(lines.joinToString("\n") { "• $it" })
                }
            }
        }
        return sections
    }

    fun encode(sections: List<ProtocolSection>, updatedAt: String): String = buildJsonArray {
        sections.forEach { section ->
            add(buildJsonObject {
                put("id", section.id)
                put("type", "heading")
                put("level", 2)
                put("text", section.title.trim().ifBlank { "Untitled section" })
                put("updatedAt", updatedAt)
                put("updatedBy", "native")
            })
            add(buildJsonObject {
                put("id", "${section.id}-body")
                put("type", "paragraph")
                put("text", section.body)
                section.guide?.takeIf(String::isNotBlank)?.let { put("guide", it) }
                put("updatedAt", updatedAt)
                put("updatedBy", "native")
            })
        }
    }.toString()

    fun newSection() = ProtocolSection(sectionId(), "New section")

    private fun sectionId() = "protocol-section-${UUID.randomUUID()}"

    private val HEADING_FIELDS = setOf("id", "type", "level", "text", "updatedAt", "updatedBy")
    private val PARAGRAPH_FIELDS = setOf("id", "type", "text", "updatedAt", "updatedBy")
    private val PARAGRAPH_FIELDS_WITH_GUIDE = PARAGRAPH_FIELDS + "guide"

    private fun JsonObject.requiredString(name: String): String? {
        val primitive = this[name] as? JsonPrimitive ?: return null
        return primitive.takeIf { it.isString }?.contentOrNull
    }

    private fun JsonObject.primitiveInt(name: String): Int? {
        val primitive = this[name] as? JsonPrimitive ?: return null
        return primitive.takeUnless { it.isString }?.intOrNull
    }
}
