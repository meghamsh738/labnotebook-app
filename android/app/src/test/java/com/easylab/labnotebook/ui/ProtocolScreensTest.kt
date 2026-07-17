package com.easylab.labnotebook.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextReplacement
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.ProtocolEntity
import com.easylab.labnotebook.data.repository.InMemoryProtocolRepository
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w390dp-h844dp")
class ProtocolScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private val account = AccountId("protocol-ui-account")

    @Test
    fun codecRoundTripsBoundedSectionsAndRejectsLossyEditing() {
        val sections = listOf(
            ProtocolSection("aim", "Aim", "Measure viability", "Describe the objective"),
            ProtocolSection("procedure", "Procedure", "Wash twice\nIncubate for 30 minutes"),
        )
        val encoded = ProtocolContentCodec.encode(sections, "2026-07-17T12:00:00Z")

        assertTrue(ProtocolContentCodec.isSafelyEditable(encoded))
        assertEquals(sections, ProtocolContentCodec.decode(encoded))
        assertFalse(
            ProtocolContentCodec.isSafelyEditable(
                """[{"id":"materials","type":"checklist","items":[{"id":"one","text":"PBS","done":false}]}]""",
            ),
        )
        assertFalse(
            ProtocolContentCodec.isSafelyEditable(
                """[{"id":"nested","type":"heading","level":3,"text":"Nested"}]""",
            ),
        )
        assertFalse(ProtocolContentCodec.isSafelyEditable("not-json"))
        assertFalse(ProtocolContentCodec.isSafelyEditable("[" + " ".repeat(ProtocolContentCodec.MAX_CONTENT_CHARS) + "]"))
    }

    @Test
    fun codecRejectsEveryShapeOrFieldThatEncodingWouldDrop() {
        val timestamp = "2026-07-17T12:00:00Z"
        val heading = "{\"id\":\"aim\",\"type\":\"heading\",\"level\":2,\"text\":\"Aim\",\"updatedAt\":\"$timestamp\",\"updatedBy\":\"native\"}"
        val paragraph = "{\"id\":\"aim-body\",\"type\":\"paragraph\",\"text\":\"Measure\",\"updatedAt\":\"$timestamp\",\"updatedBy\":\"native\"}"
        val unsafe = listOf(
            "[${heading.replace("\"id\":\"aim\",", "")},$paragraph]",
            "[${heading.replace("\"text\":\"Aim\",", "")},$paragraph]",
            "[${heading.dropLast(1)},\"runs\":[]},$paragraph]",
            "[${heading.dropLast(1)},\"align\":\"left\"},$paragraph]",
            "[${heading.dropLast(1)},\"locked\":false},$paragraph]",
            "[${heading.dropLast(1)},\"unknown\":true},$paragraph]",
            "[$heading]",
            "[$heading,${paragraph.replace("aim-body", "other-body")}]",
            "[$heading,${paragraph.replace("\"text\":\"Measure\",", "")}]",
            "[$heading,${paragraph.dropLast(1)},\"guide\":\"\"}]",
            "[$heading,${paragraph.dropLast(1)},\"metadata\":{}}]",
        )

        unsafe.forEach { raw ->
            assertFalse("Unexpectedly editable: $raw", ProtocolContentCodec.isSafelyEditable(raw))
        }
    }

    @Test
    fun compactLibraryCreatesGuidedProtocolThenCancelsAndSavesEdits() {
        val repository = InMemoryProtocolRepository()
        setProtocolScreen(
            repository = repository,
            now = sequenceOf(
                "2026-07-17T10:00:00Z",
                "2026-07-17T11:00:00Z",
            ).iterator().let { values -> { values.next() } },
        )

        compose.onNodeWithTag("protocol-empty").assertExists()
        compose.onNodeWithTag("protocol-new").performClick()
        compose.onNodeWithTag("protocol-create-title").performTextReplacement("Immunostaining SOP")
        compose.onNodeWithTag("protocol-create-guided").performClick()
        compose.waitUntil(5_000) {
            runBlocking { repository.getProtocol(account, "protocol-created") != null }
        }

        compose.onNodeWithTag("protocol-detail-protocol-created").assertExists()
        listOf("Aim", "Materials", "Procedure", "Notes").forEach {
            compose.onNodeWithText(it).assertExists()
        }
        compose.onNodeWithContentDescription("Back to protocols").assertExists()
        compose.onNodeWithContentDescription("Edit protocol").performClick()
        compose.onNodeWithTag("protocol-title-editor").performTextReplacement("Changed but cancelled")
        compose.onNodeWithTag("protocol-detail-protocol-created").performScrollToNode(hasTestTag("protocol-cancel"))
        compose.onNodeWithTag("protocol-cancel").performClick()
        compose.onNodeWithText("Immunostaining SOP").assertExists()
        assertEquals("Immunostaining SOP", runBlocking {
            repository.getProtocol(account, "protocol-created")?.title
        })

        compose.onNodeWithContentDescription("Edit protocol").performClick()
        compose.onNodeWithTag("protocol-title-editor").performTextReplacement("Validated immunostaining SOP")
        compose.onNodeWithTag("protocol-detail-protocol-created").performScrollToNode(hasTestTag("protocol-save"))
        compose.onNodeWithTag("protocol-save").performClick()
        compose.waitUntil(5_000) {
            runBlocking {
                repository.getProtocol(account, "protocol-created")?.title == "Validated immunostaining SOP"
            }
        }
        compose.onNodeWithText("Validated immunostaining SOP").assertExists()
        compose.onNodeWithContentDescription("Back to protocols").performClick()
        compose.onNodeWithTag("protocol-list").assertExists()
        compose.onNodeWithTag("protocol-item-protocol-created").assertExists()
    }

    @Test
    fun activeDraftSurvivesRepositoryEmissionAndSaveReportsConflict() {
        val repository = InMemoryProtocolRepository()
        val original = protocol(
            id = "conflict",
            title = "Original title",
            content = ProtocolContentCodec.encode(
                listOf(ProtocolSection("aim", "Aim", "Original body")),
                "2026-07-17T10:00:00Z",
            ),
        )
        runBlocking { repository.createProtocol(account, original) }
        setProtocolScreen(repository, now = { "2026-07-17T12:00:00Z" })

        compose.onNodeWithTag("protocol-item-conflict").performClick()
        compose.onNodeWithContentDescription("Edit protocol").performClick()
        compose.onNodeWithTag("protocol-title-editor").performTextReplacement("My active draft")
        runBlocking {
            repository.updateProtocol(
                account,
                original.copy(title = "Concurrent title", updatedAt = "2026-07-17T11:00:00Z"),
                expectedUpdatedAt = original.updatedAt,
            )
        }
        compose.waitForIdle()

        compose.onNodeWithText("My active draft").assertExists()
        compose.onNodeWithTag("protocol-detail-conflict").performScrollToNode(hasTestTag("protocol-save"))
        compose.onNodeWithTag("protocol-save").performClick()
        compose.onNodeWithText("changed after editing began", substring = true).assertExists()
        assertEquals("Concurrent title", runBlocking { repository.getProtocol(account, original.id)?.title })
    }

    @Test
    fun deleteRequiresConfirmationAndRemovesProtocol() {
        val repository = InMemoryProtocolRepository()
        runBlocking {
            repository.createProtocol(
                account,
                protocol(
                    id = "delete-me",
                    title = "Delete me",
                    content = ProtocolContentCodec.encode(emptyList(), "2026-07-17T10:00:00Z"),
                ),
            )
        }
        setProtocolScreen(repository)
        compose.onNodeWithTag("protocol-item-delete-me").performClick()

        compose.onNodeWithContentDescription("Delete protocol").performClick()
        compose.onNodeWithText("Delete protocol?").assertExists()
        compose.onNodeWithTag("protocol-delete-cancel").performClick()
        assertTrue(runBlocking { repository.getProtocol(account, "delete-me") != null })

        compose.onNodeWithContentDescription("Delete protocol").performClick()
        compose.onNodeWithTag("protocol-delete-confirm").performClick()
        compose.waitUntil(5_000) { runBlocking { repository.getProtocol(account, "delete-me") == null } }
        compose.onNodeWithTag("protocol-empty").assertExists()
    }

    @Test
    fun blankProtocolCreateShowsProfessionalEmptyState() {
        val blankRepository = InMemoryProtocolRepository()
        setProtocolScreen(blankRepository)
        compose.onNodeWithTag("protocol-new").performClick()
        compose.onNodeWithTag("protocol-create-title").performTextReplacement("Blank method")
        compose.onNodeWithTag("protocol-create-blank").performClick()
        compose.waitUntil(5_000) {
            runBlocking { blankRepository.getProtocol(account, "protocol-created") != null }
        }
        compose.onNodeWithText("Blank protocol").assertExists()

    }

    @Test
    fun longRichReadStateIsScrollableAndRemainsReadOnly() {

        val richRepository = InMemoryProtocolRepository()
        runBlocking {
            richRepository.createProtocol(
                account,
                protocol(
                    id = "rich",
                    title = "Imported rich method",
                    content = """[
                        {"id":"aim","type":"heading","level":2,"text":"Aim"},
                        {"id":"long","type":"paragraph","text":"${"Detailed step. ".repeat(400)}TAIL"},
                        {"id":"materials","type":"checklist","items":[{"id":"one","text":"PBS","done":false}]}
                    ]""".trimIndent(),
                ),
            )
        }
        setProtocolScreen(richRepository)
        compose.onNodeWithTag("protocol-item-rich").performClick()
        compose.onNodeWithTag("protocol-detail-rich").performScrollToNode(hasText("TAIL", substring = true))
        compose.onNodeWithText("TAIL", substring = true).assertExists()
        compose.onNodeWithTag("protocol-detail-rich").performScrollToNode(hasText("remains read-only", substring = true))
        compose.onNodeWithTag("protocol-rich-content-read-only").assertExists()
        compose.onNodeWithContentDescription("Edit protocol").assertDoesNotExist()
    }

    private fun setProtocolScreen(
        repository: InMemoryProtocolRepository,
        now: () -> String = { "2026-07-17T10:00:00Z" },
    ) {
        compose.setContent {
            MaterialTheme {
                ProtocolsScreen(
                    accountId = account,
                    repository = repository,
                    now = now,
                    idFactory = { "protocol-created" },
                )
            }
        }
    }

    private fun protocol(id: String, title: String, content: String) = ProtocolEntity(
        accountId = account.value,
        id = id,
        title = title,
        createdAt = "2026-07-17T10:00:00Z",
        updatedAt = "2026-07-17T10:00:00Z",
        contentJson = content,
    )
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w900dp-h800dp")
class ProtocolExpandedScreensTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun expandedLayoutKeepsLibraryAndSelectedDetailVisibleTogether() {
        val account = AccountId("protocol-tablet-account")
        val repository = InMemoryProtocolRepository()
        runBlocking {
            repository.createProtocol(
                account,
                ProtocolEntity(
                    accountId = account.value,
                    id = "tablet-protocol",
                    title = "Tablet protocol",
                    createdAt = "2026-07-17T10:00:00Z",
                    updatedAt = "2026-07-17T10:00:00Z",
                    contentJson = ProtocolContentCodec.encode(
                        listOf(ProtocolSection("aim", "Aim", "Tablet split view")),
                        "2026-07-17T10:00:00Z",
                    ),
                ),
            )
        }

        compose.setContent {
            MaterialTheme {
                ProtocolsScreen(accountId = account, repository = repository)
            }
        }
        compose.waitUntil(5_000) {
            runCatching { compose.onNodeWithTag("protocol-detail-tablet-protocol").fetchSemanticsNode() }.isSuccess
        }

        compose.onNodeWithTag("protocol-list").assertExists()
        compose.onNodeWithTag("protocol-item-tablet-protocol").assertExists().assertIsSelected()
        compose.onNodeWithTag("protocol-detail-tablet-protocol").assertExists()
        compose.onNodeWithText("Tablet split view").assertExists()
        compose.onNodeWithContentDescription("Back to protocols").assertDoesNotExist()
    }
}
