package com.easylab.labnotebook.data.migration

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.LabNotebookDatabase

interface LegacyWorkspaceImportRepository {
    suspend fun import(
        accountId: AccountId,
        activeDeviceId: String,
        rawJson: String,
        policy: LegacyImportPolicy = LegacyImportPolicy.RequireEmptyWorkspace,
    ): LegacyImportResult
}

class RoomLegacyWorkspaceImportRepository(
    database: LabNotebookDatabase,
    blobStore: LegacyBlobStore,
) : LegacyWorkspaceImportRepository {
    private val importer = LegacyWorkspaceImporter(database, blobStore)

    override suspend fun import(
        accountId: AccountId,
        activeDeviceId: String,
        rawJson: String,
        policy: LegacyImportPolicy,
    ): LegacyImportResult = importer.import(accountId, activeDeviceId, rawJson, policy)
}
