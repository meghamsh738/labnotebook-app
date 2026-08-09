package com.easylab.labnotebook.sync

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.easylab.labnotebook.data.local.AccountEntity
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.local.SyncQueueEntity
import com.easylab.labnotebook.data.local.DriveWritePayloadEntity
import com.easylab.labnotebook.data.repository.DriveFileRef
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DriveV1DurableTransactionRecoveryTest {
    @Test
    fun transactionPersistsReceiptsAndCompletesQueueOnlyAfterManifest() = runTest {
        val fixture = fixture()
        try {
            val result = fixture.coordinator.runNext(ACCOUNT_A, "claim-a")

            assertTrue(result is DriveV1DurableRunResult.Completed)
            assertEquals(
                listOf(TOMBSTONE_PATH, BLOB_PATH, METADATA_PATH, DriveV1Paths.manifest),
                fixture.writer.calls,
            )
            assertEquals("completed", fixture.dao.queueItem(ACCOUNT_A.value, QUEUE_ID)?.status)
            val operation = fixture.dao.recoverableDriveWriteOperations(ACCOUNT_A.value).singleOrNull()
            assertNull(operation)
            val completed = fixture.dao.driveWriteOperationForQueueMutation(ACCOUNT_A.value, QUEUE_ID, MUTATION_AT)
            assertEquals("completed", completed?.state)
            assertEquals(4, DriveV1OperationJournal(fixture.dao).receipts(requireNotNull(completed)).size)
            assertEquals(1L, fixture.dao.driveRawDocument(ACCOUNT_A.value, "attachment", ATTACHMENT_ID)?.driveVersion)
            assertEquals(5L, fixture.dao.driveRawDocument(ACCOUNT_A.value, "manifest", "manifest")?.driveVersion)
            assertNull(fixture.dao.driveWritePayload(ACCOUNT_A.value, TOMBSTONE_JSON_KEY))
            assertNull(fixture.dao.driveWritePayload(ACCOUNT_A.value, METADATA_JSON_KEY))
            assertNull(fixture.dao.driveWritePayload(ACCOUNT_A.value, MANIFEST_JSON_KEY))
        } finally {
            fixture.close()
        }
    }

    @Test
    fun lostBlobResponseReconcilesWithoutDuplicateAndSuppressesManifestUntilRetry() = runTest {
        val fixture = fixture()
        try {
            fixture.writer.ambiguousAfterCommitPath = BLOB_PATH
            val first = fixture.coordinator.runNext(ACCOUNT_A, "claim-first")

            assertTrue(first is DriveV1DurableRunResult.Ambiguous)
            assertFalse(DriveV1Paths.manifest in fixture.writer.calls)
            assertEquals("queued", fixture.dao.queueItem(ACCOUNT_A.value, QUEUE_ID)?.status)
            fixture.writer.ambiguousAfterCommitPath = null

            val second = fixture.coordinator.runNext(ACCOUNT_A, "claim-second")
            assertTrue(second is DriveV1DurableRunResult.Completed)
            assertEquals(1, fixture.writer.calls.count { it == BLOB_PATH })
            assertEquals(1, fixture.writer.calls.count { it == DriveV1Paths.manifest })
        } finally {
            fixture.close()
        }
    }

    @Test
    fun cancellationAfterRemoteCommitLeavesRecoverableReceiptAndRethrows() = runTest {
        val fixture = fixture()
        try {
            fixture.writer.cancelAfterCommitPath = BLOB_PATH
            var cancelled = false
            try {
                fixture.coordinator.runNext(ACCOUNT_A, "cancelled-claim")
            } catch (_: CancellationException) {
                cancelled = true
            }
            assertTrue(cancelled)
            assertEquals("syncing", fixture.dao.queueItem(ACCOUNT_A.value, QUEUE_ID)?.status)
            val running = requireNotNull(
                fixture.dao.driveWriteOperationForQueueMutation(ACCOUNT_A.value, QUEUE_ID, MUTATION_AT),
            )
            assertEquals(BLOB_PATH, DriveV1OperationJournal(fixture.dao).receipts(running).last().path)

            fixture.writer.cancelAfterCommitPath = null
            fixture.clock.advanceSeconds(601)
            val resumed = fixture.coordinator.runNext(ACCOUNT_A, "recovery-claim")
            assertTrue(resumed is DriveV1DurableRunResult.Completed)
            assertEquals(1, fixture.writer.calls.count { it == BLOB_PATH })
        } finally {
            fixture.close()
        }
    }

    @Test
    fun manifestCommitCanBeFinalizedAfterProcessStyleRecreation() = runTest {
        val fixture = fixture()
        try {
            fixture.verifier.deferOneManifestReceiptCheck = true
            val first = fixture.coordinator.runNext(ACCOUNT_A, "first-process")
            assertTrue(first is DriveV1DurableRunResult.LocalCompletionPending)
            assertEquals("syncing", fixture.dao.queueItem(ACCOUNT_A.value, QUEUE_ID)?.status)
            assertEquals(
                "manifest-committed",
                fixture.dao.driveWriteOperationForQueueMutation(ACCOUNT_A.value, QUEUE_ID, MUTATION_AT)?.state,
            )
            assertNotNull(fixture.dao.driveWritePayload(ACCOUNT_A.value, METADATA_JSON_KEY))

            fixture.clock.advanceSeconds(601)
            val recreated = DriveV1DurableWriteCoordinator(
                fixture.dao,
                DriveV1QueuePlanProvider { _, _ -> error("Persisted recovery must not replan.") },
                fixture.writer,
                DriveV1DurableBlobSource { _, _ ->
                    Result.failure(IllegalStateException("Committed recovery must not reload attachment bytes."))
                },
                fixture.verifier,
                fixture.clock,
            )
            val second = recreated.runNext(ACCOUNT_A, "second-process")
            assertTrue(second is DriveV1DurableRunResult.Completed)
            assertEquals(1, fixture.writer.calls.count { it == DriveV1Paths.manifest })
        } finally {
            fixture.close()
        }
    }

    @Test
    fun cancellationFromRepairScopeIsRethrownWithoutWritingOrFailingTheQueue() = runTest {
        val fixture = fixture()
        try {
            fixture.verifier.cancelScope = true
            var cancelled = false
            try {
                fixture.coordinator.runNext(ACCOUNT_A, "scope-cancel")
            } catch (_: CancellationException) {
                cancelled = true
            }

            assertTrue(cancelled)
            assertTrue(fixture.writer.calls.isEmpty())
            assertEquals("syncing", fixture.dao.queueItem(ACCOUNT_A.value, QUEUE_ID)?.status)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun cancellationDuringPlanningLeavesNoJournalOrPayloadRows() = runTest {
        val fixture = fixture(
            planProvider = DriveV1QueuePlanProvider { _, _ ->
                throw CancellationException("Injected cancellation while staging a plan.")
            },
        )
        try {
            var cancelled = false
            try {
                fixture.coordinator.runNext(ACCOUNT_A, "planning-cancel")
            } catch (_: CancellationException) {
                cancelled = true
            }
            assertTrue(cancelled)
            assertNull(fixture.dao.driveWriteOperationForQueueMutation(ACCOUNT_A.value, QUEUE_ID, MUTATION_AT))
            fixture.payloads.forEach { payload ->
                assertNull(fixture.dao.driveWritePayload(ACCOUNT_A.value, payload.payloadKey))
            }
        } finally {
            fixture.close()
        }
    }

    @Test
    fun unexpectedPlanningFailureFailsClaimClosedInsteadOfLeavingItsLeaseActive() = runTest {
        val fixture = fixture(
            planProvider = DriveV1QueuePlanProvider { _, _ ->
                throw IllegalStateException("Verified Drive target has no positive version.")
            },
        )
        try {
            val result = fixture.coordinator.runNext(ACCOUNT_A, "missing-version-claim")

            assertTrue(result is DriveV1DurableRunResult.Blocked)
            val queue = requireNotNull(fixture.dao.queueItem(ACCOUNT_A.value, QUEUE_ID))
            assertEquals("failed", queue.status)
            assertNull(queue.claimToken)
            assertTrue(queue.lastError.orEmpty().contains("version", ignoreCase = true))
            assertTrue(fixture.writer.calls.isEmpty())
        } finally {
            fixture.close()
        }
    }

    @Test
    fun payloadStagingRollsBackIfJournalInsertionFails() = runTest {
        val fixture = fixture()
        try {
            val queue = requireNotNull(fixture.dao.queueItem(ACCOUNT_A.value, QUEUE_ID))
            val journal = DriveV1OperationJournal(fixture.dao)
            val operation = journal.prepare(
                ACCOUNT_A,
                queue,
                fixture.plan,
                fixture.payloads,
                fixture.clock.next().now,
            )
            val orphanJson = "{\"must\":\"roll-back\"}"
            val orphan = DriveWritePayloadEntity(
                accountId = ACCOUNT_A.value,
                payloadKey = "orphan-after-failed-journal",
                contentSha256 = digest(orphanJson.toByteArray(StandardCharsets.UTF_8)),
                payloadJson = orphanJson,
                createdAt = MUTATION_AT,
            )

            var failed = false
            try {
                fixture.dao.insertDriveWriteOperationWithPayloads(operation, listOf(orphan))
            } catch (_: Throwable) {
                failed = true
            }
            assertTrue(failed)
            assertNull(fixture.dao.driveWritePayload(ACCOUNT_A.value, orphan.payloadKey))
        } finally {
            fixture.close()
        }
    }

    @Test
    fun leaseLossBeforeFirstWriteSupersedesAndRemovesStagedPayloads() = runTest {
        val fixture = fixture()
        try {
            fixture.verifier.beforeCheck = { path ->
                if (path == TOMBSTONE_PATH) {
                    fixture.verifier.beforeCheck = {}
                    fixture.dao.deleteStalePendingUpserts(ACCOUNT_A.value, "attachment", ATTACHMENT_ID)
                    fixture.dao.insertQueueItemIfAbsent(queue(updatedAt = NEWER_MUTATION_AT))
                }
            }

            val result = fixture.coordinator.runNext(ACCOUNT_A, "claim-lost-before-write")
            assertTrue(result is DriveV1DurableRunResult.Superseded)
            assertTrue(fixture.writer.calls.isEmpty())
            fixture.payloads.forEach { payload ->
                assertNull(fixture.dao.driveWritePayload(ACCOUNT_A.value, payload.payloadKey))
            }
            assertEquals(
                "superseded",
                fixture.dao.driveWriteOperationForQueueMutation(ACCOUNT_A.value, QUEUE_ID, MUTATION_AT)?.state,
            )
        } finally {
            fixture.close()
        }
    }

    @Test
    fun preconditionConflictBeforeAnyReceiptReplansButPartialConflictFailsClosed() = runTest {
        var planningCalls = 0
        val freshPlan = plan()
        val replannable = fixture(
            planProvider = DriveV1QueuePlanProvider { _, _ ->
                planningCalls += 1
                if (planningCalls == 1) {
                    DriveV1QueuePlanDecision.Ready(freshPlan, payloadsFor(ACCOUNT_A))
                }
                else DriveV1QueuePlanDecision.CompleteWithoutRemote("Fresh remote snapshot already converges.")
            },
        )
        try {
            replannable.writer.preconditionConflictPath = TOMBSTONE_PATH
            val first = replannable.coordinator.runNext(ACCOUNT_A, "stale-first")
            assertTrue(first is DriveV1DurableRunResult.Superseded)
            assertEquals("queued", replannable.dao.queueItem(ACCOUNT_A.value, QUEUE_ID)?.status)
            replannable.writer.preconditionConflictPath = null

            val second = replannable.coordinator.runNext(ACCOUNT_A, "fresh-second")
            assertTrue(second is DriveV1DurableRunResult.CompletedWithoutRemote)
            assertEquals(2, planningCalls)
        } finally {
            replannable.close()
        }

        val partial = fixture()
        try {
            partial.writer.preconditionConflictPath = METADATA_PATH
            val result = partial.coordinator.runNext(ACCOUNT_A, "partial-conflict")
            assertTrue(result is DriveV1DurableRunResult.Blocked)
            assertFalse(DriveV1Paths.manifest in partial.writer.calls)
            assertEquals("failed", partial.dao.queueItem(ACCOUNT_A.value, QUEUE_ID)?.status)
        } finally {
            partial.close()
        }
    }

    @Test
    fun retryablePrerequisiteFailureOrUnexplainedRepairScopeNeverPublishesManifest() = runTest {
        val failedWrite = fixture()
        try {
            failedWrite.writer.failBeforeCommitPath = BLOB_PATH
            val result = failedWrite.coordinator.runNext(ACCOUNT_A, "failed-claim")
            assertTrue(result is DriveV1DurableRunResult.Ambiguous)
            assertFalse(DriveV1Paths.manifest in failedWrite.writer.calls)
        } finally {
            failedWrite.close()
        }

        val unsafeScope = fixture()
        try {
            unsafeScope.verifier.scopeFailure = "Unexplained duplicate managed path."
            val result = unsafeScope.coordinator.runNext(ACCOUNT_A, "scope-claim")
            assertTrue(result is DriveV1DurableRunResult.Blocked)
            assertTrue(unsafeScope.writer.calls.isEmpty())
        } finally {
            unsafeScope.close()
        }
    }

    @Test
    fun newerLocalMutationSupersedesOldClaimAfterRemoteManifestCommit() = runTest {
        val fixture = fixture()
        try {
            fixture.writer.afterCommit = { path ->
                if (path == DriveV1Paths.manifest) {
                    fixture.dao.deleteStalePendingUpserts(ACCOUNT_A.value, "attachment", ATTACHMENT_ID)
                    fixture.dao.insertQueueItemIfAbsent(queue(updatedAt = NEWER_MUTATION_AT))
                }
            }
            val result = fixture.coordinator.runNext(ACCOUNT_A, "old-claim")

            assertTrue(result is DriveV1DurableRunResult.Superseded)
            val current = fixture.dao.queueItem(ACCOUNT_A.value, QUEUE_ID)
            assertEquals("queued", current?.status)
            assertEquals(NEWER_MUTATION_AT, current?.updatedAt)
            assertEquals(
                "manifest-committed",
                fixture.dao.driveWriteOperationForQueueMutation(ACCOUNT_A.value, QUEUE_ID, MUTATION_AT)?.state,
            )
            val recovered = fixture.coordinator.runNext(ACCOUNT_A, "new-claim")
            assertTrue(recovered is DriveV1DurableRunResult.CompletedWithoutRemote)
            assertEquals(
                "superseded",
                fixture.dao.driveWriteOperationForQueueMutation(ACCOUNT_A.value, QUEUE_ID, MUTATION_AT)?.state,
            )
            assertEquals("completed", fixture.dao.queueItem(ACCOUNT_A.value, QUEUE_ID)?.status)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun partialOlderTransactionIsRepairedBeforeNewerMutationIsPlanned() = runTest {
        val fixture = fixture()
        try {
            fixture.writer.ambiguousAfterCommitPath = BLOB_PATH
            val partial = fixture.coordinator.runNext(ACCOUNT_A, "partial-claim")
            assertTrue(partial is DriveV1DurableRunResult.Ambiguous)
            fixture.dao.deleteStalePendingUpserts(ACCOUNT_A.value, "attachment", ATTACHMENT_ID)
            fixture.dao.insertQueueItemIfAbsent(queue(updatedAt = NEWER_MUTATION_AT))
            fixture.writer.ambiguousAfterCommitPath = null

            val resumed = fixture.coordinator.runNext(ACCOUNT_A, "newer-claim")
            assertTrue(resumed is DriveV1DurableRunResult.CompletedWithoutRemote)
            assertEquals(
                "superseded",
                fixture.dao.driveWriteOperationForQueueMutation(ACCOUNT_A.value, QUEUE_ID, MUTATION_AT)?.state,
            )
            assertEquals(1, fixture.writer.calls.count { it == BLOB_PATH })
            assertEquals(1, fixture.writer.calls.count { it == DriveV1Paths.manifest })
            assertEquals("completed", fixture.dao.queueItem(ACCOUNT_A.value, QUEUE_ID)?.status)
            assertEquals(1L, fixture.dao.driveRawDocument(ACCOUNT_A.value, "attachment", ATTACHMENT_ID)?.driveVersion)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun firstWriteCommittedWithoutReceiptIsReconciledBeforeNewerMutation() = runTest {
        val fixture = fixture()
        try {
            fixture.writer.ambiguousAfterCommitPath = TOMBSTONE_PATH
            val partial = fixture.coordinator.runNext(ACCOUNT_A, "lost-first-receipt")
            assertTrue(partial is DriveV1DurableRunResult.Ambiguous)
            val ambiguous = requireNotNull(
                fixture.dao.driveWriteOperationForQueueMutation(ACCOUNT_A.value, QUEUE_ID, MUTATION_AT),
            )
            assertTrue(DriveV1OperationJournal(fixture.dao).receipts(ambiguous).isEmpty())

            fixture.dao.deleteStalePendingUpserts(ACCOUNT_A.value, "attachment", ATTACHMENT_ID)
            fixture.dao.insertQueueItemIfAbsent(queue(updatedAt = NEWER_MUTATION_AT))
            fixture.writer.ambiguousAfterCommitPath = null

            val resumed = fixture.coordinator.runNext(ACCOUNT_A, "newer-after-lost-receipt")
            assertTrue(resumed is DriveV1DurableRunResult.CompletedWithoutRemote)
            assertEquals(1, fixture.writer.calls.count { it == TOMBSTONE_PATH })
            assertEquals(1, fixture.writer.calls.count { it == DriveV1Paths.manifest })
            assertEquals(
                "superseded",
                fixture.dao.driveWriteOperationForQueueMutation(ACCOUNT_A.value, QUEUE_ID, MUTATION_AT)?.state,
            )
        } finally {
            fixture.close()
        }
    }

    @Test
    fun operationIdentityAndJournalAreImmutableAndAccountScoped() = runTest {
        val fixture = fixture(seedSecondAccount = true)
        try {
            val journal = DriveV1OperationJournal(fixture.dao)
            val queueA = requireNotNull(fixture.dao.queueItem(ACCOUNT_A.value, QUEUE_ID))
            val queueB = queueA.copy(accountId = ACCOUNT_B.value)
            fixture.dao.insertQueueItemIfAbsent(queueB)
            val operationA = journal.prepare(
                ACCOUNT_A,
                queueA,
                fixture.plan,
                fixture.payloads,
                fixture.clock.next().now,
            )
            val operationB = journal.prepare(
                ACCOUNT_B,
                queueB,
                fixture.plan,
                fixture.payloads.map { it.copy(accountId = ACCOUNT_B.value) },
                fixture.clock.next().now,
            )

            assertEquals(operationA.operationId, operationB.operationId)
            assertNotEquals(operationA.accountId, operationB.accountId)
            assertNull(fixture.dao.driveWriteOperation(ACCOUNT_A.value, "missing"))
            assertNotNull(fixture.dao.driveWriteOperation(ACCOUNT_B.value, operationB.operationId))
            assertFalse(operationA.planJson.contains("claim-a"))
            assertFalse(operationA.planJson.contains("@example"))
            assertFalse(operationA.planJson.contains(BLOB_BYTES.toString(StandardCharsets.UTF_8)))
            assertFalse(operationA.planJson.contains("deletedByDeviceId"))
            assertFalse(operationA.planJson.contains("storagePath"))

            val firstSnapshot = operationA
            journal.transition(operationA, DriveV1OperationState.Running, updatedAt = fixture.clock.next().now)
            var staleCasRejected = false
            try {
                journal.transition(firstSnapshot, DriveV1OperationState.Running, updatedAt = fixture.clock.next().now)
            } catch (_: IllegalStateException) {
                staleCasRejected = true
            }
            assertTrue(staleCasRejected)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun malformedMissingDuplicateAndDeleteEditPlansFailBeforeAnyWrite() = runTest {
        listOf(
            "Malformed remote JSON is quarantined.",
            "Remote record is missing despite a prior baseline.",
            "Duplicate canonical path occupants exist.",
            "Remote delete conflicts with a changed local attachment.",
            "Equal-instant tombstones diverge.",
        ).forEachIndexed { index, reason ->
            val fixture = fixture(
                planProvider = DriveV1QueuePlanProvider { _, _ -> DriveV1QueuePlanDecision.Blocked(reason) },
            )
            try {
                val result = fixture.coordinator.runNext(ACCOUNT_A, "blocked-$index")
                assertTrue(result is DriveV1DurableRunResult.Blocked)
                assertTrue(fixture.writer.calls.isEmpty())
            } finally {
                fixture.close()
            }
        }
    }

    private suspend fun fixture(
        seedSecondAccount: Boolean = false,
        planProvider: DriveV1QueuePlanProvider? = null,
    ): Fixture {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        val dao = database.dao()
        dao.upsertAccount(AccountEntity(ACCOUNT_A.value, "a@example.invalid", connectedAt = MUTATION_AT))
        if (seedSecondAccount) {
            dao.upsertAccount(AccountEntity(ACCOUNT_B.value, "b@example.invalid", connectedAt = MUTATION_AT))
        }
        dao.insertQueueItemIfAbsent(queue())
        val plan = plan()
        val payloads = payloadsFor(ACCOUNT_A)
        val writer = FakeWriter()
        writer.seed(
            path = DriveV1Paths.manifest,
            id = "manifest-file",
            version = 4,
            contentSha256 = digest("old-manifest".toByteArray()),
        )
        val verifier = FakeVerifier(writer)
        val clock = FakeLeaseClock()
        val blobSource = DriveV1DurableBlobSource { accountId, key ->
            if (accountId == ACCOUNT_A && key == BLOB_KEY) Result.success(BLOB_BYTES.copyOf())
            else Result.failure(IllegalArgumentException("Blob content is outside the active account."))
        }
        val provider = planProvider ?: DriveV1QueuePlanProvider { accountId, claimed ->
            require(accountId == ACCOUNT_A)
            if (claimed.updatedAt == MUTATION_AT) {
                DriveV1QueuePlanDecision.Ready(plan, payloads)
            } else {
                DriveV1QueuePlanDecision.CompleteWithoutRemote("Newer mutation replanned from repaired baselines.")
            }
        }
        val coordinator = DriveV1DurableWriteCoordinator(
            dao,
            provider,
            writer,
            blobSource,
            verifier,
            clock,
        )
        return Fixture(database, dao, plan, payloads, writer, verifier, clock, blobSource, coordinator)
    }

    private fun plan(): DriveV1DurableTransactionPlan {
        val attachment = DriveV1Attachment(
            id = ATTACHMENT_ID,
            entryId = "entry-1",
            type = "file",
            filename = "result.bin",
            filesize = "7 B",
            bytes = BLOB_BYTES.size.toLong(),
            storagePath = BLOB_PATH,
            mimeType = "application/octet-stream",
            sha256 = digest(BLOB_BYTES),
            createdAt = MUTATION_AT,
            updatedAt = MUTATION_AT,
        ).requireV1()
        val metadata = DriveV1Envelope(
            id = attachment.id,
            kind = "attachment",
            updatedAt = MUTATION_AT,
            updatedByDeviceId = "device-a",
            payload = attachment,
        ).requireV1("attachment")
        val manifest = DriveV1Manifest(
            createdAt = "2026-08-01T09:00:00.000Z",
            updatedAt = MUTATION_AT,
            attachmentCount = 1,
        ).requireV1()
        return DriveV1DurableTransactionPlan.create(
            prerequisites = listOf(
                DriveV1DurableWrite.json(
                    TOMBSTONE_PATH,
                    tombstoneJson(),
                    TOMBSTONE_JSON_KEY,
                    DriveWritePrecondition.MustNotExist,
                    "tombstone",
                    "old-entry-tombstone",
                ),
                DriveV1DurableWrite.blob(
                    BLOB_PATH,
                    BLOB_KEY,
                    "application/octet-stream",
                    BLOB_BYTES.size.toLong(),
                    digest(BLOB_BYTES),
                    DriveWritePrecondition.MustNotExist,
                ),
                DriveV1DurableWrite.json(
                    METADATA_PATH,
                    DriveV1Json.format.encodeToString(metadata),
                    METADATA_JSON_KEY,
                    DriveWritePrecondition.MustNotExist,
                    "attachment",
                    ATTACHMENT_ID,
                ),
            ),
            manifest = DriveV1DurableWrite.json(
                DriveV1Paths.manifest,
                DriveV1Json.format.encodeToString(manifest),
                MANIFEST_JSON_KEY,
                DriveWritePrecondition.MustMatch("manifest-file", 4),
                "manifest",
                "manifest",
            ),
        )
    }

    private fun testJsonPayloads(): Map<String, String> {
        val attachment = DriveV1Attachment(
            id = ATTACHMENT_ID,
            entryId = "entry-1",
            type = "file",
            filename = "result.bin",
            filesize = "7 B",
            bytes = BLOB_BYTES.size.toLong(),
            storagePath = BLOB_PATH,
            mimeType = "application/octet-stream",
            sha256 = digest(BLOB_BYTES),
            createdAt = MUTATION_AT,
            updatedAt = MUTATION_AT,
        ).requireV1()
        val metadata = DriveV1Envelope(
            id = attachment.id,
            kind = "attachment",
            updatedAt = MUTATION_AT,
            updatedByDeviceId = "device-a",
            payload = attachment,
        ).requireV1("attachment")
        val manifest = DriveV1Manifest(
            createdAt = "2026-08-01T09:00:00.000Z",
            updatedAt = MUTATION_AT,
            attachmentCount = 1,
        ).requireV1()
        return mapOf(
            TOMBSTONE_JSON_KEY to tombstoneJson(),
            METADATA_JSON_KEY to DriveV1Json.format.encodeToString(metadata),
            MANIFEST_JSON_KEY to DriveV1Json.format.encodeToString(manifest),
        )
    }

    private fun payloadsFor(accountId: AccountId): List<DriveWritePayloadEntity> =
        testJsonPayloads().map { (payloadKey, json) ->
            DriveWritePayloadEntity(
                accountId = accountId.value,
                payloadKey = payloadKey,
                contentSha256 = digest(json.toByteArray(StandardCharsets.UTF_8)),
                payloadJson = json,
                createdAt = MUTATION_AT,
            )
        }

    private fun tombstoneJson(): String = DriveV1Json.format.encodeToString(
        DriveV1Tombstone(
            id = "old-entry-tombstone",
            entityKind = "entry",
            entityId = "old-entry",
            deletedAt = MUTATION_AT,
            deletedByDeviceId = "device-a",
        ).requireV1(),
    )

    private fun queue(updatedAt: String = MUTATION_AT) = SyncQueueEntity(
        accountId = ACCOUNT_A.value,
        id = QUEUE_ID,
        entityKind = "attachment",
        entityId = ATTACHMENT_ID,
        operation = "upsert",
        queuedAt = updatedAt,
        updatedAt = updatedAt,
        updatedByDeviceId = "device-a",
    )

    private data class Fixture(
        val database: LabNotebookDatabase,
        val dao: com.easylab.labnotebook.data.local.LabNotebookDao,
        val plan: DriveV1DurableTransactionPlan,
        val payloads: List<DriveWritePayloadEntity>,
        val writer: FakeWriter,
        val verifier: FakeVerifier,
        val clock: FakeLeaseClock,
        val blobSource: DriveV1DurableBlobSource,
        val coordinator: DriveV1DurableWriteCoordinator,
    ) {
        fun close() = database.close()
    }

    private class FakeLeaseClock : DriveV1LeaseClock {
        private var current = Instant.parse("2026-08-01T10:00:00Z")
        private val format = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
            .withZone(ZoneOffset.UTC)

        override fun next(): DriveV1LeaseWindow {
            val now = current
            current = current.plusSeconds(1)
            return DriveV1LeaseWindow(format.format(now), format.format(now.plusSeconds(600)))
        }

        fun advanceSeconds(seconds: Long) {
            current = current.plusSeconds(seconds)
        }
    }

    private data class FakeRemote(val ref: DriveFileRef, val contentSha256: String)

    private class FakeWriter : DriveConditionalWriteClient {
        val calls = mutableListOf<String>()
        val remote = linkedMapOf<String, FakeRemote>()
        var ambiguousAfterCommitPath: String? = null
        var cancelAfterCommitPath: String? = null
        var failBeforeCommitPath: String? = null
        var preconditionConflictPath: String? = null
        var afterCommit: suspend (String) -> Unit = {}

        fun seed(path: String, id: String, version: Long, contentSha256: String) {
            remote[path] = FakeRemote(ref(path, id, version), contentSha256)
        }

        override suspend fun putJsonConditional(
            accountId: AccountId,
            path: String,
            json: String,
            precondition: DriveWritePrecondition,
        ) = write(path, digest(json.toByteArray(StandardCharsets.UTF_8)), precondition)

        override suspend fun putBlobConditional(
            accountId: AccountId,
            path: String,
            bytes: ByteArray,
            mimeType: String,
            sha256: String,
            precondition: DriveWritePrecondition,
        ) = write(path, digest(bytes), precondition)

        override suspend fun putBlobConditionalResumable(
            accountId: AccountId,
            path: String,
            bytes: ByteArray,
            mimeType: String,
            sha256: String,
            precondition: DriveWritePrecondition,
            operationId: String,
        ) = write(path, digest(bytes), precondition)

        override suspend fun putBlobConditionalResumableCreate(
            accountId: AccountId,
            path: String,
            bytes: ByteArray,
            mimeType: String,
            sha256: String,
            precondition: DriveWritePrecondition,
            operationId: String,
        ) = write(path, digest(bytes), precondition)

        private suspend fun write(
            path: String,
            contentSha256: String,
            precondition: DriveWritePrecondition,
        ): Result<DriveFileRef> = try {
            calls += path
            if (failBeforeCommitPath == path) throw IllegalStateException("Injected failure before commit.")
            if (preconditionConflictPath == path) {
                throw DriveWritePreconditionConflictException("Injected stale conditional target.", 412)
            }
            val existing = remote[path]
            when (precondition) {
                DriveWritePrecondition.MustNotExist -> require(existing == null) { "Path already exists." }
                is DriveWritePrecondition.MustMatch -> require(
                    existing?.ref?.id == precondition.fileId && existing.ref.version == precondition.version,
                ) { "Stale conditional update." }
            }
            val committed = ref(
                path,
                existing?.ref?.id ?: "file-${remote.size + 1}",
                (existing?.ref?.version ?: 0L) + 1L,
            )
            remote[path] = FakeRemote(committed, contentSha256)
            afterCommit(path)
            if (ambiguousAfterCommitPath == path) {
                throw DriveWriteAmbiguousCommitException("Injected lost response.", IllegalStateException("lost"))
            }
            if (cancelAfterCommitPath == path) throw DriveWriteReconciledAfterCancellationException(committed)
            Result.success(committed)
        } catch (error: Throwable) {
            Result.failure(error)
        }

        private fun ref(path: String, id: String, version: Long) = DriveFileRef(
            id = id,
            path = path,
            name = path.substringAfterLast('/'),
            updatedAt = "2026-08-01T10:10:00.000Z",
            version = version,
        )
    }

    private class FakeVerifier(private val writer: FakeWriter) : DriveV1RecoveryVerifier {
        var scopeFailure: String? = null
        var cancelScope = false
        var deferOneManifestReceiptCheck = false
        var beforeCheck: suspend (String) -> Unit = {}

        override suspend fun validatePlanScope(
            accountId: AccountId,
            plan: DriveV1DurableTransactionPlan,
        ): Result<Unit> = when {
            cancelScope -> Result.failure(CancellationException("Injected repair cancellation."))
            scopeFailure != null -> Result.failure(IllegalStateException(scopeFailure))
            else -> Result.success(Unit)
        }

        override suspend fun check(
            accountId: AccountId,
            write: DriveV1DurableWrite,
            receipt: DriveV1VerifiedWriteReceipt?,
        ): DriveV1RecoveryCheck {
            beforeCheck(write.path)
            if (write.path == DriveV1Paths.manifest && receipt != null && deferOneManifestReceiptCheck) {
                deferOneManifestReceiptCheck = false
                return DriveV1RecoveryCheck.Blocked("Injected process stop before local completion.")
            }
            val remote = writer.remote[write.path]
            if (remote != null && remote.contentSha256 == write.contentSha256) {
                if (receipt != null &&
                    (receipt.fileId != remote.ref.id || receipt.version != remote.ref.version)
                ) {
                    return DriveV1RecoveryCheck.Blocked("Remote receipt identity changed.")
                }
                return DriveV1RecoveryCheck.Exact(remote.ref)
            }
            if (receipt != null) return DriveV1RecoveryCheck.Blocked("Verified remote write changed or disappeared.")
            return when (val precondition = write.precondition.toRuntime()) {
                DriveWritePrecondition.MustNotExist -> if (remote == null) {
                    DriveV1RecoveryCheck.ReadyToWrite
                } else {
                    DriveV1RecoveryCheck.Blocked("Create-only path has an occupant.")
                }
                is DriveWritePrecondition.MustMatch -> if (
                    remote?.ref?.id == precondition.fileId && remote.ref.version == precondition.version
                ) {
                    DriveV1RecoveryCheck.ReadyToWrite
                } else {
                    DriveV1RecoveryCheck.Blocked("Update target identity or version changed.")
                }
            }
        }
    }

    private companion object {
        val ACCOUNT_A = AccountId("durable-account-a")
        val ACCOUNT_B = AccountId("durable-account-b")
        const val QUEUE_ID = "attachment-upsert"
        const val ATTACHMENT_ID = "attachment-1"
        const val MUTATION_AT = "2026-08-01T10:00:00.000Z"
        const val NEWER_MUTATION_AT = "2026-08-01T11:00:00.000Z"
        const val BLOB_KEY = "account-local-blob-key"
        val BLOB_BYTES = "raw-binary-sentinel-that-must-not-enter-the-journal".toByteArray(StandardCharsets.UTF_8)
        val BLOB_PATH = DriveV1Paths.attachmentBlob("2026-08-01", ATTACHMENT_ID, "result.bin")
        val METADATA_PATH = DriveV1Paths.attachmentMetadata("2026-08-01", ATTACHMENT_ID, "result.bin")
        val TOMBSTONE_PATH = DriveV1Paths.tombstone("entry", "old-entry")
        const val TOMBSTONE_JSON_KEY = "test-json-tombstone"
        const val METADATA_JSON_KEY = "test-json-metadata"
        const val MANIFEST_JSON_KEY = "test-json-manifest"

        fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }
}
