package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.local.SyncStateEntity
import com.easylab.labnotebook.data.repository.AuthRepository
import com.easylab.labnotebook.data.repository.DriveHttpException
import com.easylab.labnotebook.data.repository.DriveRepository
import com.easylab.labnotebook.data.repository.DriveSignInRequiredException
import com.easylab.labnotebook.data.repository.DriveWriteCapability
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlinx.coroutines.CancellationException

internal sealed interface SyncExecutionOutcome {
    val pendingCount: Int
    val message: String

    data class Success(
        override val pendingCount: Int,
        override val message: String,
        val appliedCount: Int,
    ) : SyncExecutionOutcome

    data class Retry(override val pendingCount: Int, override val message: String) : SyncExecutionOutcome
    data class Failure(override val pendingCount: Int, override val message: String) : SyncExecutionOutcome
}

internal class ReadOnlySyncExecutor(
    private val database: LabNotebookDatabase,
    private val authRepository: AuthRepository?,
    private val driveFactory: (AuthRepository) -> DriveRepository,
    private val now: () -> String = ::syncNowIso,
) {
    suspend fun execute(accountId: AccountId): SyncExecutionOutcome {
        val dao = database.dao()
        val pending = dao.pendingQueue(accountId.value)
        val attemptAt = now()
        val auth = authRepository
        if (auth == null || auth.accessToken(accountId).isNullOrBlank()) {
            recordState(accountId, attemptAt, pending.size, SyncMessages.SIGN_IN_REQUIRED)
            return SyncExecutionOutcome.Failure(pending.size, SyncMessages.SIGN_IN_REQUIRED)
        }

        recordState(accountId, attemptAt, pending.size, SyncMessages.CHECKING_DRIVE)
        return try {
            val drive = driveFactory(auth)
            check(drive.writeCapability == DriveWriteCapability.DisabledPendingContractParity) {
                "Read-only native sync must not expose Drive writes."
            }
            val snapshot = DriveV1MetadataReader(drive).read(accountId)
            val report = DriveV1MetadataApplier(database, now).apply(accountId, snapshot)
            SyncExecutionOutcome.Success(
                pendingCount = pending.size,
                message = checkNotNull(dao.syncState(accountId.value)).lastMessage,
                appliedCount = report.appliedCount,
            )
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: DriveSignInRequiredException) {
            recordState(accountId, attemptAt, pending.size, SyncMessages.SIGN_IN_REQUIRED)
            SyncExecutionOutcome.Failure(pending.size, SyncMessages.SIGN_IN_REQUIRED)
        } catch (failure: DriveHttpException) {
            if (failure.statusCode == 401) {
                auth.invalidateAccessToken(accountId)
                recordState(accountId, attemptAt, pending.size, SyncMessages.SIGN_IN_REQUIRED)
                SyncExecutionOutcome.Failure(pending.size, SyncMessages.SIGN_IN_REQUIRED)
            } else {
                val message = "${SyncMessages.ERROR_PREFIX} ${failure.message.orEmpty()}".trim()
                recordState(accountId, attemptAt, pending.size, message)
                if (failure.retryable) {
                    SyncExecutionOutcome.Retry(pending.size, message)
                } else {
                    SyncExecutionOutcome.Failure(pending.size, message)
                }
            }
        } catch (failure: IOException) {
            val message = "${SyncMessages.ERROR_PREFIX} Drive could not be reached."
            recordState(accountId, attemptAt, pending.size, message)
            SyncExecutionOutcome.Retry(pending.size, message)
        } catch (failure: Exception) {
            val message = "${SyncMessages.ERROR_PREFIX} ${failure.message ?: "Drive metadata is invalid."}"
            recordState(accountId, attemptAt, pending.size, message)
            SyncExecutionOutcome.Failure(pending.size, message)
        }
    }

    private suspend fun recordState(
        accountId: AccountId,
        attemptAt: String,
        pendingCount: Int,
        message: String,
    ) {
        val dao = database.dao()
        val previous = dao.syncState(accountId.value)
        dao.upsertSyncState(
            SyncStateEntity(
                accountId = accountId.value,
                lastAttemptAt = attemptAt,
                lastSyncedAt = previous?.lastSyncedAt,
                lastMessage = message,
                changeToken = previous?.changeToken,
                updatedAt = attemptAt,
                queueCount = pendingCount,
                valueJson = previous?.valueJson,
            ),
        )
    }
}

private fun syncNowIso(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
}.format(Date())
