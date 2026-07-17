package com.easylab.labnotebook.data.capture

import android.content.Context
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.sync.DriveV1Hashing
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class StoredCaptureBlob(
    val attachmentId: String,
    val path: String,
    val createdByCapture: Boolean,
)

interface CaptureBlobStore {
    suspend fun put(
        accountId: AccountId,
        attachmentId: String,
        bytes: ByteArray,
        sha256: String,
    ): StoredCaptureBlob

    suspend fun removeIfCreated(blob: StoredCaptureBlob)
}

class FileCaptureBlobStore(
    context: Context,
    private val root: File = File(context.filesDir, "attachment-cache"),
) : CaptureBlobStore {
    override suspend fun put(
        accountId: AccountId,
        attachmentId: String,
        bytes: ByteArray,
        sha256: String,
    ): StoredCaptureBlob = withContext(Dispatchers.IO) {
        require(bytes.isNotEmpty()) { "Captured file is empty." }
        require(DriveV1Hashing.sha256(bytes).equals(sha256, ignoreCase = true)) {
            "Captured file changed before it was cached."
        }
        val accountDirectory = File(root, DriveV1Hashing.sha256(accountId.value))
        check(accountDirectory.mkdirs() || accountDirectory.isDirectory) {
            "Could not create the account-scoped attachment cache."
        }
        val destination = File(accountDirectory, DriveV1Hashing.sha256(attachmentId))
        if (destination.exists()) {
            require(DriveV1Hashing.sha256(destination.readBytes()).equals(sha256, ignoreCase = true)) {
                "A different local file already uses this attachment id."
            }
            return@withContext StoredCaptureBlob(attachmentId, destination.absolutePath, createdByCapture = false)
        }

        val temporary = File.createTempFile(".capture-", ".tmp", accountDirectory)
        try {
            temporary.writeBytes(bytes)
            check(temporary.renameTo(destination)) { "Could not save the captured file." }
        } finally {
            if (temporary.exists()) temporary.delete()
        }
        StoredCaptureBlob(attachmentId, destination.absolutePath, createdByCapture = true)
    }

    override suspend fun removeIfCreated(blob: StoredCaptureBlob) = withContext(Dispatchers.IO) {
        if (blob.createdByCapture) File(blob.path).delete()
        Unit
    }
}
