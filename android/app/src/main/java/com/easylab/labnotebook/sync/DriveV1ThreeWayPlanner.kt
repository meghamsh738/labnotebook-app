package com.easylab.labnotebook.sync

/**
 * One side of a Drive v1 three-way comparison.
 *
 * A tombstone is deliberately distinct from [Missing]: absence without a
 * tombstone is not proof that an entity was intentionally deleted.
 */
sealed interface DriveV1ThreeWayState<out T> {
    data object Missing : DriveV1ThreeWayState<Nothing>

    data class Present<T>(val value: T) : DriveV1ThreeWayState<T>

    data class Tombstone(val value: DriveV1Tombstone) : DriveV1ThreeWayState<Nothing>
}

sealed interface DriveV1ThreeWayDecision {
    data object AlreadyConverged : DriveV1ThreeWayDecision

    data object PushLocal : DriveV1ThreeWayDecision

    data object AcceptRemote : DriveV1ThreeWayDecision

    data object AcceptRemoteDelete : DriveV1ThreeWayDecision

    data class Conflict(val reason: String) : DriveV1ThreeWayDecision

    data class Blocked(val reason: String) : DriveV1ThreeWayDecision
}

/**
 * Pure semantic three-way planner for Drive v1 entities.
 *
 * The planner never uses timestamps to choose a winner. Its only change signal
 * is the entity type's contract semantic hash.
 */
object DriveV1ThreeWayPlanner {
    fun planEntry(
        base: DriveV1ThreeWayState<DriveV1Entry>,
        local: DriveV1ThreeWayState<DriveV1Entry>,
        remote: DriveV1ThreeWayState<DriveV1Entry>,
    ): DriveV1ThreeWayDecision = plan(
        entityKind = "entry",
        base = base,
        local = local,
        remote = remote,
        idOf = DriveV1Entry::id,
        semanticHash = DriveV1Hashing::entryContentHash,
    )

    fun planAttachment(
        base: DriveV1ThreeWayState<DriveV1Attachment>,
        local: DriveV1ThreeWayState<DriveV1Attachment>,
        remote: DriveV1ThreeWayState<DriveV1Attachment>,
    ): DriveV1ThreeWayDecision = plan(
        entityKind = "attachment",
        base = base,
        local = local,
        remote = remote,
        idOf = DriveV1Attachment::id,
        semanticHash = DriveV1Hashing::attachmentMetadataHash,
    )

    fun planFileBoxItem(
        base: DriveV1ThreeWayState<DriveV1FileBoxItem>,
        local: DriveV1ThreeWayState<DriveV1FileBoxItem>,
        remote: DriveV1ThreeWayState<DriveV1FileBoxItem>,
    ): DriveV1ThreeWayDecision = plan(
        entityKind = "fileBoxItem",
        base = base,
        local = local,
        remote = remote,
        idOf = DriveV1FileBoxItem::id,
        semanticHash = DriveV1Hashing::fileBoxMetadataHash,
    )

    fun planTransfer(
        base: DriveV1ThreeWayState<DriveV1Transfer>,
        local: DriveV1ThreeWayState<DriveV1Transfer>,
        remote: DriveV1ThreeWayState<DriveV1Transfer>,
    ): DriveV1ThreeWayDecision = plan(
        entityKind = "transfer",
        base = base,
        local = local,
        remote = remote,
        idOf = DriveV1Transfer::id,
        semanticHash = DriveV1Hashing::transferMetadataHash,
    )

    private fun <T> plan(
        entityKind: String,
        base: DriveV1ThreeWayState<T>,
        local: DriveV1ThreeWayState<T>,
        remote: DriveV1ThreeWayState<T>,
        idOf: (T) -> String,
        semanticHash: (T) -> String,
    ): DriveV1ThreeWayDecision {
        val localValue = when (local) {
            DriveV1ThreeWayState.Missing ->
                return DriveV1ThreeWayDecision.Blocked("Local $entityKind state is missing.")
            is DriveV1ThreeWayState.Tombstone ->
                return DriveV1ThreeWayDecision.Blocked("Local $entityKind tombstones are not valid for an upsert plan.")
            is DriveV1ThreeWayState.Present -> local.value
        }
        val localId = idOf(localValue)
        val localHash = semanticHash(localValue)

        val baseValue = when (base) {
            DriveV1ThreeWayState.Missing -> null
            is DriveV1ThreeWayState.Tombstone ->
                return DriveV1ThreeWayDecision.Blocked("A tombstone cannot be used as the $entityKind merge base.")
            is DriveV1ThreeWayState.Present -> base.value
        }
        if (baseValue != null && idOf(baseValue) != localId) {
            return DriveV1ThreeWayDecision.Blocked("Base and local $entityKind ids do not match.")
        }

        return when (remote) {
            DriveV1ThreeWayState.Missing -> {
                if (baseValue == null) {
                    DriveV1ThreeWayDecision.PushLocal
                } else {
                    DriveV1ThreeWayDecision.Blocked(
                        "Remote $entityKind is missing without a tombstone despite a prior merge base.",
                    )
                }
            }
            is DriveV1ThreeWayState.Tombstone -> {
                val tombstone = remote.value
                if (tombstone.entityKind != entityKind || tombstone.entityId != localId) {
                    DriveV1ThreeWayDecision.Blocked("Remote tombstone does not identify the local $entityKind.")
                } else if (baseValue == null) {
                    DriveV1ThreeWayDecision.Conflict("Remote deletion conflicts with a new local $entityKind.")
                } else if (localHash == semanticHash(baseValue)) {
                    DriveV1ThreeWayDecision.AcceptRemoteDelete
                } else {
                    DriveV1ThreeWayDecision.Conflict("Remote deletion conflicts with a changed local $entityKind.")
                }
            }
            is DriveV1ThreeWayState.Present -> {
                val remoteValue = remote.value
                if (idOf(remoteValue) != localId) {
                    DriveV1ThreeWayDecision.Blocked("Remote and local $entityKind ids do not match.")
                } else {
                    planPresentValues(
                        entityKind = entityKind,
                        baseValue = baseValue,
                        localHash = localHash,
                        remoteHash = semanticHash(remoteValue),
                        semanticHash = semanticHash,
                    )
                }
            }
        }
    }

    private fun <T> planPresentValues(
        entityKind: String,
        baseValue: T?,
        localHash: String,
        remoteHash: String,
        semanticHash: (T) -> String,
    ): DriveV1ThreeWayDecision {
        if (localHash == remoteHash) return DriveV1ThreeWayDecision.AlreadyConverged
        if (baseValue == null) {
            return DriveV1ThreeWayDecision.Conflict("Local and remote created different $entityKind content.")
        }

        val baseHash = semanticHash(baseValue)
        val localChanged = localHash != baseHash
        val remoteChanged = remoteHash != baseHash
        return when {
            localChanged && !remoteChanged -> DriveV1ThreeWayDecision.PushLocal
            !localChanged && remoteChanged -> DriveV1ThreeWayDecision.AcceptRemote
            !localChanged && !remoteChanged -> DriveV1ThreeWayDecision.AlreadyConverged
            else -> DriveV1ThreeWayDecision.Conflict("Local and remote changed the same $entityKind differently.")
        }
    }
}
