package com.easylab.labnotebook.data.migration

import android.content.Context
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.sync.DriveV1Hashing
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class StoredLegacyBlob(
    val id: String,
    val path: String,
    val createdByImport: Boolean,
)

interface LegacyBlobStore {
    suspend fun putVerified(
        accountId: AccountId,
        blob: LegacyWorkspaceBlobV1,
        bytes: ByteArray,
    ): StoredLegacyBlob

    suspend fun removeIfCreated(blob: StoredLegacyBlob)
}

class FileLegacyBlobStore(
    context: Context,
    private val root: File = File(context.filesDir, "legacy-import-blobs"),
) : LegacyBlobStore {
    override suspend fun putVerified(
        accountId: AccountId,
        blob: LegacyWorkspaceBlobV1,
        bytes: ByteArray,
    ): StoredLegacyBlob = withContext(Dispatchers.IO) {
        require(bytes.size.toLong() == blob.size) { "Legacy blob ${blob.id} size changed before caching." }
        require(DriveV1Hashing.sha256(bytes).equals(blob.sha256, ignoreCase = true)) {
            "Legacy blob ${blob.id} hash changed before caching."
        }
        val accountDirectory = File(root, DriveV1Hashing.sha256(accountId.value))
        check(accountDirectory.mkdirs() || accountDirectory.isDirectory) {
            "Could not create the account-scoped legacy cache."
        }
        val destination = File(accountDirectory, DriveV1Hashing.sha256(blob.id))
        if (destination.exists()) {
            require(DriveV1Hashing.sha256(destination.readBytes()).equals(blob.sha256, ignoreCase = true)) {
                "A different cached blob already uses legacy id ${blob.id}."
            }
            return@withContext StoredLegacyBlob(blob.id, destination.absolutePath, createdByImport = false)
        }

        val temporary = File.createTempFile(".legacy-", ".tmp", accountDirectory)
        try {
            temporary.writeBytes(bytes)
            check(temporary.renameTo(destination)) { "Could not commit legacy blob ${blob.id}." }
        } finally {
            if (temporary.exists()) temporary.delete()
        }
        StoredLegacyBlob(blob.id, destination.absolutePath, createdByImport = true)
    }

    override suspend fun removeIfCreated(blob: StoredLegacyBlob) = withContext(Dispatchers.IO) {
        if (blob.createdByImport) File(blob.path).delete()
        Unit
    }
}
