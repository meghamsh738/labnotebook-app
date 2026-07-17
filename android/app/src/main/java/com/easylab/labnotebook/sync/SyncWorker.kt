package com.easylab.labnotebook.sync

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.easylab.labnotebook.NativeProcessAuth
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import java.security.MessageDigest
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOf

data class SyncStatus(
    val pendingCount: Int = 0,
    val lastAttemptAt: String? = null,
    val lastSyncedAt: String? = null,
    val message: String = SyncMessages.NOT_RUN,
    val nativeWritesEnabled: Boolean = false,
    val signInRequired: Boolean = false,
    val hasError: Boolean = false,
)

interface SyncCoordinator {
    fun observeStatus(accountId: AccountId): Flow<SyncStatus>
    fun requestSync(accountId: AccountId, reason: String = "manual")
    fun cancel(accountId: AccountId)
}

object PlaceholderSyncCoordinator : SyncCoordinator {
    override fun observeStatus(accountId: AccountId): Flow<SyncStatus> = flowOf(SyncStatus())
    override fun requestSync(accountId: AccountId, reason: String) = Unit
    override fun cancel(accountId: AccountId) = Unit
}

class WorkManagerSyncCoordinator(context: Context) : SyncCoordinator {
    private val appContext = context.applicationContext
    private val dao = LabNotebookDatabase.get(appContext).dao()
    private val workManager by lazy { WorkManager.getInstance(appContext) }

    override fun observeStatus(accountId: AccountId): Flow<SyncStatus> = combine(
        dao.observePendingCount(accountId.value),
        dao.observeSyncState(accountId.value),
    ) { pending, state ->
        SyncStatus(
            pendingCount = pending,
            lastAttemptAt = state?.lastAttemptAt,
            lastSyncedAt = state?.lastSyncedAt,
            message = state?.lastMessage ?: SyncMessages.NOT_RUN,
            nativeWritesEnabled = false,
            signInRequired = state?.lastMessage == SyncMessages.SIGN_IN_REQUIRED,
            hasError = state?.lastMessage?.startsWith(SyncMessages.ERROR_PREFIX) == true,
        )
    }

    override fun requestSync(accountId: AccountId, reason: String) {
        val inputData = Data.Builder()
            .putString(JournalSyncWorker.KEY_ACCOUNT_ID, accountId.value)
            .putString(JournalSyncWorker.KEY_REASON, reason)
            .build()
        val request = OneTimeWorkRequestBuilder<JournalSyncWorker>()
            .setInputData(inputData)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .addTag(TAG_SYNC)
            .build()
        workManager.enqueueUniqueWork(
            syncUniqueWorkName(accountId),
            syncExistingWorkPolicy(inputData),
            request,
        )
    }

    override fun cancel(accountId: AccountId) {
        workManager.cancelUniqueWork(syncUniqueWorkName(accountId))
    }

    companion object { const val TAG_SYNC = "easylab-native-sync" }
}

internal fun syncExistingWorkPolicy(inputData: Data): ExistingWorkPolicy =
    if (inputData.getString(JournalSyncWorker.KEY_REASON) == JournalSyncWorker.REASON_INTERACTIVE_RECONNECT) {
        ExistingWorkPolicy.REPLACE
    } else {
        ExistingWorkPolicy.KEEP
    }

internal fun syncUniqueWorkName(accountId: AccountId): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(accountId.value.toByteArray(Charsets.UTF_8))
    return "easylab-sync-${digest.joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }}"
}

class JournalSyncWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        val rawAccountId = inputData.getString(KEY_ACCOUNT_ID).orEmpty()
        if (rawAccountId.isBlank()) return Result.failure(Data.Builder().putString(KEY_MESSAGE, "Missing account id.").build())

        val accountId = AccountId(rawAccountId)
        val database = LabNotebookDatabase.get(applicationContext)
        val authRepository = NativeProcessAuth.current()
        val outcome = ReadOnlySyncExecutor(
            database = database,
            authRepository = authRepository,
            driveFactory = { auth -> NativeDriveReadOnlyFactory.create(applicationContext, auth) },
        ).execute(accountId)
        setProgress(Data.Builder().putInt(KEY_PENDING_COUNT, outcome.pendingCount).build())
        return syncWorkerResult(outcome)
    }

    companion object {
        const val KEY_ACCOUNT_ID = "account_id"
        const val KEY_REASON = "reason"
        const val REASON_INTERACTIVE_RECONNECT = "interactive_reconnect"
        const val KEY_PENDING_COUNT = "pending_count"
        const val KEY_APPLIED_COUNT = "applied_count"
        const val KEY_MESSAGE = "message"

    }
}

internal fun syncWorkerResult(outcome: SyncExecutionOutcome): ListenableWorker.Result = when (outcome) {
    is SyncExecutionOutcome.Success -> ListenableWorker.Result.success(
        outcomeData(outcome).putInt(JournalSyncWorker.KEY_APPLIED_COUNT, outcome.appliedCount).build(),
    )
    is SyncExecutionOutcome.Retry -> ListenableWorker.Result.retry()
    is SyncExecutionOutcome.Failure -> {
        val data = outcomeData(outcome).build()
        if (outcome.message == SyncMessages.SIGN_IN_REQUIRED) {
            ListenableWorker.Result.success(data)
        } else {
            ListenableWorker.Result.failure(data)
        }
    }
}

private fun outcomeData(outcome: SyncExecutionOutcome): Data.Builder = Data.Builder()
    .putInt(JournalSyncWorker.KEY_PENDING_COUNT, outcome.pendingCount)
    .putString(JournalSyncWorker.KEY_MESSAGE, outcome.message)

internal object SyncMessages {
    const val NOT_RUN = "Native Drive metadata has not been checked yet."
    const val CHECKING_DRIVE = "Checking Google Drive metadata…"
    const val SIGN_IN_REQUIRED = "Sign in to Google Drive to sync this device."
    const val ERROR_PREFIX = "Sync problem:"
}
