package com.easylab.labnotebook.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DriveV1ThreeWayPlannerTest {
    private val json = DriveV1Json.format

    private fun fixture(path: String): String =
        checkNotNull(javaClass.classLoader?.getResource("drive-v1/$path")) { "Missing fixture $path" }.readText()

    @Test
    fun entryPlannerCoversTheSemanticThreeWayDecisionTable() {
        val base = entryFixture()
        val localEdit = base.copy(title = "local edit")
        val remoteEdit = base.copy(title = "remote edit")
        val tombstone = tombstone("entry", base.id)
        val cases = listOf(
            Case("no base and no remote creates", missing(), present(base), missing(), DriveV1ThreeWayDecision.PushLocal),
            Case(
                "matching concurrent creates converge",
                missing(),
                present(base),
                present(base),
                DriveV1ThreeWayDecision.AlreadyConverged,
            ),
            Case(
                "different concurrent creates conflict",
                missing(),
                present(base),
                present(remoteEdit),
                DriveV1ThreeWayDecision.Conflict("Local and remote created different entry content."),
            ),
            Case(
                "unchanged copies converge",
                present(base),
                present(base),
                present(base),
                DriveV1ThreeWayDecision.AlreadyConverged,
            ),
            Case(
                "local-only edit pushes",
                present(base),
                present(localEdit),
                present(base),
                DriveV1ThreeWayDecision.PushLocal,
            ),
            Case(
                "remote-only edit is accepted",
                present(base),
                present(base),
                present(remoteEdit),
                DriveV1ThreeWayDecision.AcceptRemote,
            ),
            Case(
                "same edit converges",
                present(base),
                present(localEdit),
                present(localEdit),
                DriveV1ThreeWayDecision.AlreadyConverged,
            ),
            Case(
                "different edits conflict",
                present(base),
                present(localEdit),
                present(remoteEdit),
                DriveV1ThreeWayDecision.Conflict("Local and remote changed the same entry differently."),
            ),
            Case(
                "remote disappearance after a base blocks",
                present(base),
                present(base),
                missing(),
                DriveV1ThreeWayDecision.Blocked(
                    "Remote entry is missing without a tombstone despite a prior merge base.",
                ),
            ),
            Case(
                "remote delete accepts an unchanged local",
                present(base),
                present(base),
                deleted(tombstone),
                DriveV1ThreeWayDecision.AcceptRemoteDelete,
            ),
            Case(
                "remote delete conflicts with a local edit",
                present(base),
                present(localEdit),
                deleted(tombstone),
                DriveV1ThreeWayDecision.Conflict("Remote deletion conflicts with a changed local entry."),
            ),
            Case(
                "remote delete conflicts with a new local",
                missing(),
                present(base),
                deleted(tombstone),
                DriveV1ThreeWayDecision.Conflict("Remote deletion conflicts with a new local entry."),
            ),
        )

        cases.forEach { case ->
            assertEquals(case.name, case.expected, DriveV1ThreeWayPlanner.planEntry(case.base, case.local, case.remote))
        }
    }

    @Test
    fun allTypedPlannersUseTheirDriveV1ContractSemanticHashes() {
        val entry = entryFixture()
        val attachment = attachmentFixture()
        val fileBox = fileBoxFixture()
        val transfer = transferFixture()

        assertEquals(
            DriveV1ThreeWayDecision.PushLocal,
            DriveV1ThreeWayPlanner.planEntry(present(entry), present(entry.copy(title = "changed")), present(entry)),
        )
        assertEquals(
            DriveV1ThreeWayDecision.PushLocal,
            DriveV1ThreeWayPlanner.planAttachment(
                present(attachment),
                present(attachment.copy(filename = "changed.csv")),
                present(attachment),
            ),
        )
        assertEquals(
            DriveV1ThreeWayDecision.PushLocal,
            DriveV1ThreeWayPlanner.planFileBoxItem(
                present(fileBox),
                present(fileBox.copy(status = "attached")),
                present(fileBox),
            ),
        )
        assertEquals(
            DriveV1ThreeWayDecision.PushLocal,
            DriveV1ThreeWayPlanner.planTransfer(
                present(transfer),
                present(transfer.copy(status = "attached")),
                present(transfer),
            ),
        )
    }

    @Test
    fun explicitNullAndOmittedOptionalFieldsAreSemanticallyEquivalentForEveryType() {
        val entry = entryFixture()
        val entryWithExplicitNull = entryFixture("\"experimentId\": null,")
        val attachment = attachmentFixture()
        val attachmentWithExplicitNull = attachmentFixture("\"linkedRegionId\": null,")
        val fileBox = fileBoxFixture()
        val fileBoxWithExplicitNull = fileBoxFixture("\"localObjectUrl\": null,")
        val transfer = transferFixture()
        val transferWithExplicitNull = transferFixture("\"lastError\": null,")

        assertEquals(
            DriveV1ThreeWayDecision.AlreadyConverged,
            DriveV1ThreeWayPlanner.planEntry(present(entry), present(entryWithExplicitNull), present(entry)),
        )
        assertEquals(
            DriveV1ThreeWayDecision.AlreadyConverged,
            DriveV1ThreeWayPlanner.planAttachment(
                present(attachment),
                present(attachmentWithExplicitNull),
                present(attachment),
            ),
        )
        assertEquals(
            DriveV1ThreeWayDecision.AlreadyConverged,
            DriveV1ThreeWayPlanner.planFileBoxItem(
                present(fileBox),
                present(fileBoxWithExplicitNull),
                present(fileBox),
            ),
        )
        assertEquals(
            DriveV1ThreeWayDecision.AlreadyConverged,
            DriveV1ThreeWayPlanner.planTransfer(
                present(transfer),
                present(transferWithExplicitNull),
                present(transfer),
            ),
        )
    }

    @Test
    fun unknownPayloadFieldsDoNotCreateFalseSemanticChangesForAnyType() {
        val entry = entryFixture()
        val attachment = attachmentFixture()
        val fileBox = fileBoxFixture()
        val transfer = transferFixture()

        assertEquals(
            DriveV1ThreeWayDecision.AlreadyConverged,
            DriveV1ThreeWayPlanner.planEntry(
                present(entry),
                present(entryFixture("\"futurePlannerField\": {\"nested\": true},")),
                present(entry),
            ),
        )
        assertEquals(
            DriveV1ThreeWayDecision.AlreadyConverged,
            DriveV1ThreeWayPlanner.planAttachment(
                present(attachment),
                present(attachmentFixture("\"futurePlannerField\": [1, 2, 3],")),
                present(attachment),
            ),
        )
        assertEquals(
            DriveV1ThreeWayDecision.AlreadyConverged,
            DriveV1ThreeWayPlanner.planFileBoxItem(
                present(fileBox),
                present(fileBoxFixture("\"futurePlannerField\": \"future\",")),
                present(fileBox),
            ),
        )
        assertEquals(
            DriveV1ThreeWayDecision.AlreadyConverged,
            DriveV1ThreeWayPlanner.planTransfer(
                present(transfer),
                present(transferFixture("\"futurePlannerField\": null,")),
                present(transfer),
            ),
        )
    }

    @Test
    fun deleteEditAndRemoteMissingRulesApplyToEveryTypedPlanner() {
        val entry = entryFixture()
        val attachment = attachmentFixture()
        val fileBox = fileBoxFixture()
        val transfer = transferFixture()

        assertDeleteAndMissingRules(
            kind = "entry",
            id = entry.id,
            unchanged = { remote -> DriveV1ThreeWayPlanner.planEntry(present(entry), present(entry), remote) },
            changed = { remote ->
                DriveV1ThreeWayPlanner.planEntry(present(entry), present(entry.copy(title = "changed")), remote)
            },
        )
        assertDeleteAndMissingRules(
            kind = "attachment",
            id = attachment.id,
            unchanged = { remote -> DriveV1ThreeWayPlanner.planAttachment(present(attachment), present(attachment), remote) },
            changed = { remote ->
                DriveV1ThreeWayPlanner.planAttachment(
                    present(attachment),
                    present(attachment.copy(filename = "changed.csv")),
                    remote,
                )
            },
        )
        assertDeleteAndMissingRules(
            kind = "fileBoxItem",
            id = fileBox.id,
            unchanged = { remote -> DriveV1ThreeWayPlanner.planFileBoxItem(present(fileBox), present(fileBox), remote) },
            changed = { remote ->
                DriveV1ThreeWayPlanner.planFileBoxItem(
                    present(fileBox),
                    present(fileBox.copy(status = "attached")),
                    remote,
                )
            },
        )
        assertDeleteAndMissingRules(
            kind = "transfer",
            id = transfer.id,
            unchanged = { remote -> DriveV1ThreeWayPlanner.planTransfer(present(transfer), present(transfer), remote) },
            changed = { remote ->
                DriveV1ThreeWayPlanner.planTransfer(
                    present(transfer),
                    present(transfer.copy(status = "attached")),
                    remote,
                )
            },
        )
    }

    @Test
    fun invalidMissingAndMismatchedIdentityStatesFailClosed() {
        val entry = entryFixture()
        assertTrue(
            DriveV1ThreeWayPlanner.planEntry(missing(), missing(), missing()) is DriveV1ThreeWayDecision.Blocked,
        )
        assertTrue(
            DriveV1ThreeWayPlanner.planEntry(
                present(entry),
                present(entry),
                present(entry.copy(id = "different")),
            ) is DriveV1ThreeWayDecision.Blocked,
        )
        assertTrue(
            DriveV1ThreeWayPlanner.planEntry(
                present(entry),
                present(entry),
                deleted(tombstone("attachment", entry.id)),
            ) is DriveV1ThreeWayDecision.Blocked,
        )
    }

    private fun <T> assertDeleteAndMissingRules(
        kind: String,
        id: String,
        unchanged: (DriveV1ThreeWayState<T>) -> DriveV1ThreeWayDecision,
        changed: (DriveV1ThreeWayState<T>) -> DriveV1ThreeWayDecision,
    ) {
        val deleted: DriveV1ThreeWayState<T> = deleted(tombstone(kind, id))
        assertEquals(DriveV1ThreeWayDecision.AcceptRemoteDelete, unchanged(deleted))
        assertTrue(changed(deleted) is DriveV1ThreeWayDecision.Conflict)
        assertTrue(unchanged(missing()) is DriveV1ThreeWayDecision.Blocked)
    }

    private fun entryFixture(injected: String? = null): DriveV1Entry =
        decodePayload("entries/2026-05-23.json", injected)

    private fun attachmentFixture(injected: String? = null): DriveV1Attachment =
        decodePayload("attachments/2026-05-23/att-contract-result.csv.json", injected)

    private fun fileBoxFixture(injected: String? = null): DriveV1FileBoxItem =
        decodePayload("filebox/filebox-contract.json", injected)

    private fun transferFixture(injected: String? = null): DriveV1Transfer =
        decodePayload("transfers/transfer-contract.json", injected)

    private inline fun <reified T> decodePayload(path: String, injected: String?): T {
        val source = fixture(path).let { raw ->
            if (injected == null) raw else raw.replace("\"payload\": {", "\"payload\": {\n    $injected")
        }
        return json.decodeFromString<DriveV1Envelope<T>>(source).payload
    }

    private fun tombstone(kind: String, id: String) = DriveV1Tombstone(
        id = "delete-$kind-$id",
        entityKind = kind,
        entityId = id,
        deletedAt = "2026-07-23T10:00:00Z",
        deletedByDeviceId = "test-device",
    )

    private fun <T> missing(): DriveV1ThreeWayState<T> = DriveV1ThreeWayState.Missing
    private fun <T> present(value: T): DriveV1ThreeWayState<T> = DriveV1ThreeWayState.Present(value)
    private fun <T> deleted(value: DriveV1Tombstone): DriveV1ThreeWayState<T> =
        DriveV1ThreeWayState.Tombstone(value)

    private data class Case(
        val name: String,
        val base: DriveV1ThreeWayState<DriveV1Entry>,
        val local: DriveV1ThreeWayState<DriveV1Entry>,
        val remote: DriveV1ThreeWayState<DriveV1Entry>,
        val expected: DriveV1ThreeWayDecision,
    )
}
