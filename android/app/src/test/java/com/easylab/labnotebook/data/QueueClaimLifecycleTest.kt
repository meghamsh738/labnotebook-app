package com.easylab.labnotebook.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.easylab.labnotebook.data.local.AccountEntity
import com.easylab.labnotebook.data.local.JournalEntryEntity
import com.easylab.labnotebook.data.local.LabNotebookDao
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.local.SyncQueueEntity
import com.easylab.labnotebook.data.local.upsertQueueEventId
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class QueueClaimLifecycleTest {
    @Test
    fun claimsAreAtomicFifoAndAccountScoped() = runTest {
        val database = database()
        try {
            val dao = database.dao()
            seedAccount(dao, ACCOUNT_A)
            seedAccount(dao, ACCOUNT_B)
            dao.upsertQueueItem(queue(ACCOUNT_A, "a-middle", "2026-07-17T10:01:00Z"))
            dao.upsertQueueItem(queue(ACCOUNT_A, "a-first", "2026-07-17T10:00:00Z"))
            dao.upsertQueueItem(queue(ACCOUNT_A, "a-last", "2026-07-17T10:02:00Z"))
            dao.upsertQueueItem(queue(ACCOUNT_B, "b-first", "2026-07-17T09:00:00Z"))
            dao.upsertQueueItem(queue("inactive-account", "orphan", "2026-07-17T08:00:00Z"))

            val first = dao.claimNextQueueItem(ACCOUNT_A, "claim-1", CLAIM_AT, LEASE_EXPIRES_AT)
            assertEquals("a-first", first?.id)

            val gate = CompletableDeferred<Unit>()
            val concurrent = listOf("claim-2", "claim-3").map { token ->
                async(Dispatchers.IO) {
                    gate.await()
                    dao.claimNextQueueItem(ACCOUNT_A, token, CLAIM_AT, LEASE_EXPIRES_AT)
                }
            }
            gate.complete(Unit)
            val claimed = concurrent.awaitAll()
            assertEquals(setOf("a-middle", "a-last"), claimed.mapNotNull { it?.id }.toSet())
            assertEquals(2, claimed.mapNotNull { it?.claimToken }.toSet().size)
            assertTrue(dao.pendingQueue(ACCOUNT_A).all { it.status == "syncing" && it.attemptCount == 1 })
            assertEquals("queued", dao.queueItem(ACCOUNT_B, "b-first")?.status)
            assertNull(dao.claimNextQueueItem("inactive-account", "orphan-claim", CLAIM_AT, LEASE_EXPIRES_AT))
        } finally {
            database.close()
        }
    }

    @Test
    fun expiredLeaseCanBeReclaimedAndOldTokenCannotFinishIt() = runTest {
        val database = database()
        try {
            val dao = database.dao()
            seedAccount(dao, ACCOUNT_A)
            val original = queue(ACCOUNT_A, "snapshot", "2026-07-17T09:00:00Z").copy(
                updatedAt = "2026-07-16T22:00:00Z",
                baseVersion = 7,
            )
            dao.upsertQueueItem(original)

            val first = dao.claimNextQueueItem(
                ACCOUNT_A,
                "expired-token",
                "2026-07-17T10:00:00Z",
                "2026-07-17T11:00:00Z",
            )
            assertEquals(1, first?.attemptCount)
            assertNull(
                dao.claimNextQueueItem(
                    ACCOUNT_A,
                    "too-early",
                    "2026-07-17T10:59:59Z",
                    "2026-07-17T11:59:59Z",
                ),
            )

            val reclaimed = dao.claimNextQueueItem(
                ACCOUNT_A,
                "current-token",
                "2026-07-17T11:00:00Z",
                "2026-07-17T12:00:00Z",
            )
            assertEquals(2, reclaimed?.attemptCount)
            assertEquals(0, dao.completeQueueClaim(ACCOUNT_A, original.id, "expired-token"))
            assertEquals(0, dao.failQueueClaim(ACCOUNT_A, original.id, "expired-token", "stale failure"))
            assertEquals(1, dao.completeQueueClaim(ACCOUNT_A, original.id, "current-token"))

            val completed = dao.queueItem(ACCOUNT_A, original.id)
            assertEquals("completed", completed?.status)
            assertEquals(original.updatedAt, completed?.updatedAt)
            assertEquals(original.baseVersion, completed?.baseVersion)
            assertEquals(2, completed?.attemptCount)
            assertNull(completed?.claimToken)
            assertNull(completed?.leaseExpiresAt)
        } finally {
            database.close()
        }
    }

    @Test
    fun restagedMutationInvalidatesOldClaimBeforeCompletion() = runTest {
        val database = database()
        try {
            val dao = database.dao()
            seedAccount(dao, ACCOUNT_A)
            val versionOne = entry(version = 1, updatedAt = "2026-07-17T09:00:00Z")
            dao.upsertEntry(versionOne.copy(syncStatus = "synced"))
            dao.stageEntryUpsert(
                versionOne.copy(version = 2, updatedAt = "2026-07-17T10:00:00Z"),
                "2026-07-17T10:00:00Z",
            )
            val claimed = requireNotNull(
                dao.claimNextQueueItem(ACCOUNT_A, "old-token", CLAIM_AT, LEASE_EXPIRES_AT),
            )

            dao.stageEntryUpsert(
                versionOne.copy(version = 3, updatedAt = "2026-07-17T11:00:00Z"),
                "2026-07-17T11:00:00Z",
            )
            assertEquals(0, dao.completeQueueClaim(ACCOUNT_A, claimed.id, "old-token"))
            val fresh = requireNotNull(dao.queueItem(ACCOUNT_A, claimed.id))
            assertEquals("queued", fresh.status)
            assertNull(fresh.claimToken)
            assertEquals(0, fresh.attemptCount)
            assertEquals("2026-07-17T11:00:00Z", fresh.updatedAt)
            assertEquals(2, fresh.baseVersion)
        } finally {
            database.close()
        }
    }

    @Test
    fun expiredClaimRecoveryUsesLeaseExpiryAndActiveAccountPredicate() = runTest {
        val database = database()
        try {
            val dao = database.dao()
            seedAccount(dao, ACCOUNT_A)
            seedAccount(dao, ACCOUNT_B)
            dao.upsertQueueItem(
                queue(ACCOUNT_A, "abandoned", "2026-07-17T08:00:00Z").copy(
                    status = "syncing",
                    claimToken = "abandoned-token",
                    claimedAt = null,
                    leaseExpiresAt = null,
                    attemptCount = 1,
                ),
            )
            dao.upsertQueueItem(
                queue(ACCOUNT_A, "old-unexpired", "2026-07-17T09:00:00Z").copy(
                    status = "syncing",
                    claimToken = "old-unexpired-token",
                    claimedAt = "2026-07-17T08:00:00Z",
                    leaseExpiresAt = "2026-07-17T12:30:00Z",
                    attemptCount = 1,
                ),
            )
            dao.upsertQueueItem(
                queue(ACCOUNT_A, "expired", "2026-07-17T09:30:00Z").copy(
                    status = "syncing",
                    claimToken = "expired-token",
                    claimedAt = "2026-07-17T10:00:00Z",
                    leaseExpiresAt = "2026-07-17T10:59:59Z",
                    attemptCount = 1,
                ),
            )

            dao.upsertQueueItem(
                queue(ACCOUNT_B, "other-account", "2026-07-17T07:00:00Z").copy(
                    status = "syncing",
                    claimToken = "other-token",
                    claimedAt = "2026-07-17T08:00:00Z",
                    leaseExpiresAt = "2026-07-17T09:00:00Z",
                    attemptCount = 1,
                ),
            )
            dao.upsertQueueItem(
                queue("inactive-account", "orphan", "2026-07-17T06:00:00Z").copy(
                    status = "syncing",
                    claimToken = "orphan-token",
                    claimedAt = null,
                    attemptCount = 1,
                ),
            )

            assertEquals(2, dao.recoverExpiredQueueClaims(ACCOUNT_A, "2026-07-17T11:00:00Z"))
            assertEquals("queued", dao.queueItem(ACCOUNT_A, "abandoned")?.status)
            assertNull(dao.queueItem(ACCOUNT_A, "abandoned")?.claimToken)
            assertEquals("queued", dao.queueItem(ACCOUNT_A, "expired")?.status)
            assertNull(dao.queueItem(ACCOUNT_A, "expired")?.claimToken)
            assertEquals("syncing", dao.queueItem(ACCOUNT_A, "old-unexpired")?.status)
            assertEquals("syncing", dao.queueItem(ACCOUNT_B, "other-account")?.status)
            assertEquals(0, dao.recoverExpiredQueueClaims("inactive-account", "2026-07-17T11:00:00Z"))
            assertEquals("syncing", dao.queueItem("inactive-account", "orphan")?.status)
        } finally {
            database.close()
        }
    }

    @Test
    fun failAndRequeueAreClaimTokenGuarded() = runTest {
        val database = database()
        try {
            val dao = database.dao()
            seedAccount(dao, ACCOUNT_A)
            dao.upsertQueueItem(queue(ACCOUNT_A, "retryable", "2026-07-17T09:00:00Z"))
            dao.claimNextQueueItem(ACCOUNT_A, "failure-owner", CLAIM_AT, LEASE_EXPIRES_AT)

            assertEquals(0, dao.failQueueClaim(ACCOUNT_A, "retryable", "wrong-token", "wrong"))
            assertEquals(1, dao.failQueueClaim(ACCOUNT_A, "retryable", "failure-owner", "network unavailable"))
            val failed = requireNotNull(dao.queueItem(ACCOUNT_A, "retryable"))
            assertEquals("failed", failed.status)
            assertEquals("network unavailable", failed.lastError)
            assertNull(failed.claimToken)

            val retry = dao.claimNextQueueItem(
                ACCOUNT_A,
                "retry-owner",
                "2026-07-17T10:01:00Z",
                "2026-07-17T11:01:00Z",
            )
            assertEquals(2, retry?.attemptCount)
            assertEquals(0, dao.requeueQueueClaim(ACCOUNT_A, "retryable", "wrong-token"))
            assertEquals(1, dao.requeueQueueClaim(ACCOUNT_A, "retryable", "retry-owner"))
            assertEquals("queued", dao.queueItem(ACCOUNT_A, "retryable")?.status)
            assertNull(dao.queueItem(ACCOUNT_A, "retryable")?.claimToken)
        } finally {
            database.close()
        }
    }

    private fun database(): LabNotebookDatabase = Room.inMemoryDatabaseBuilder(
        ApplicationProvider.getApplicationContext<Context>(),
        LabNotebookDatabase::class.java,
    ).allowMainThreadQueries().build()

    private suspend fun seedAccount(dao: LabNotebookDao, accountId: String) {
        dao.upsertAccount(AccountEntity(accountId, "$accountId@example.test", connectedAt = CLAIM_AT))
    }

    private fun queue(accountId: String, id: String, queuedAt: String) = SyncQueueEntity(
        accountId = accountId,
        id = id,
        entityKind = "entry",
        entityId = "entity-$id",
        operation = "upsert",
        queuedAt = queuedAt,
        updatedAt = queuedAt,
        updatedByDeviceId = "queue-test",
    )

    private fun entry(version: Int, updatedAt: String) = JournalEntryEntity(
        accountId = ACCOUNT_A,
        id = "restaged-entry",
        title = "Restaged",
        dateBucket = "2026-07-17",
        createdAt = "2026-07-17T09:00:00Z",
        updatedAt = updatedAt,
        authorId = ACCOUNT_A,
        version = version,
        updatedByDeviceId = "queue-test",
    )

    private companion object {
        const val ACCOUNT_A = "queue-account-a"
        const val ACCOUNT_B = "queue-account-b"
        const val CLAIM_AT = "2026-07-17T10:00:00Z"
        const val LEASE_EXPIRES_AT = "2026-07-17T11:00:00Z"
    }
}
