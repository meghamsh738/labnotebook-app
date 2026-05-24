# Standalone Lab Notebook V1 Worklist

Planning source:
- This worklist consolidates the standalone Lab Notebook product plan and external design review notes.
- Do not commit private ChatGPT thread links, local upload bundles, OAuth credentials, tokens, or user data.

## Product Direction

V1 should be a reliability release, not a feature-expansion release. The app should prove that one daily entry and its files can move safely between two devices through the user's Google Drive account without data loss, accidental resurrection after delete, or silent overwrites.

The next milestone is:

> Two devices, one Drive folder, daily entries and attachments round-trip safely, conflicts are preserved, deletes do not resurrect, and the UI clearly tells the user what is local, queued, synced, failed, or conflicted.

## V1 Scope Boundary

In scope:

- One primary daily entry per calendar day.
- Rich text note body with lightweight structured sections.
- Optional simple workbook/table for pasted tabular data.
- IndexedDB-backed repository layer.
- Autosave and offline editing.
- Durable local blob persistence for attachments.
- Local backup/restore independent of Google Drive.
- Entry-specific attachments by drag/drop, paste, file picker, camera input where supported, and PWA share target where supported.
- File Box accept/reject/move-date flow.
- Attachment statuses: local only, queued, uploading, synced, remote available, missing local blob, failed.
- Google Drive root folder setup, device registration, entry push/pull, attachment upload/download, tombstones, conflicts, manifest, and conservative full rescan fallback.
- Electron desktop and mobile PWA.
- Today-first desktop, bottom-tab mobile, first-run sync setup, and plain-language sync/conflict status.

Out of scope:

- Custom backend, real-time collaboration, multi-user sharing, server queues, native mobile app, Tauri migration, full spreadsheet clone, broad Drive import, AI/RAG over notes, complex LIMS/protocol workflows, automatic WhatsApp/Telegram ingestion in this branch, enterprise audit/retention, and end-to-end encryption claims.

## P0 Architecture Foundation

1. Add repository interfaces and implementations:
   - `DailyEntryRepository`
   - `AttachmentRepository`
   - `FileBoxRepository`
   - `TransferRepository`
   - `SyncQueueRepository`
   - `DeviceRepository`
   - `TombstoneRepository`
   - `ConflictRepository`

   Acceptance:
   - Sync-related code can use repositories without direct IndexedDB store calls.
   - Existing migration/hydration still passes.

2. Add canonical hashing utilities:
   - Stable JSON stringify.
   - SHA-256 for entry payloads.
   - SHA-256 for attachment blobs.

   Acceptance:
   - The same logical entry produces the same content hash across browser contexts/devices.
   - Tests cover key-order stability and attachment blob hashing.

3. Add blob storage abstraction:
   - `BlobStore` interface.
   - `IndexedDbBlobStore` for PWA/browser use.
   - Electron filesystem-backed adapter or bridge when a local attachments folder is available.

   Acceptance:
   - Create/read/delete/list blob by key.
   - Verify SHA-256.
   - Simulate a missing local blob and surface `missing_local_blob`.

4. Add sync schema validators:
   - Entry envelope.
   - Attachment metadata.
   - Tombstone.
   - Conflict.
   - Manifest.

   Acceptance:
   - Invalid remote JSON is quarantined into diagnostics/conflicts instead of being applied.

## P0 Sync Provider And Engine

1. Create a `SyncProvider` interface:

```ts
interface SyncProvider {
  signIn(): Promise<AuthSession>
  signOut(): Promise<void>
  ensureWorkspace(): Promise<WorkspaceRef>
  ensureDeviceRecord(device: DeviceRecord): Promise<void>

  getJson<T>(path: string): Promise<RemoteJson<T> | null>
  putJson<T>(path: string, value: T, options?: PutOptions): Promise<RemoteFileRef>

  getBlob(path: string): Promise<Blob | null>
  putBlob(path: string, blob: Blob, metadata: BlobMetadata): Promise<RemoteFileRef>

  loadManifest(): Promise<WorkspaceManifest | null>
  putManifest(manifest: WorkspaceManifest): Promise<RemoteFileRef>

  listManagedFiles(options: ListOptions): Promise<RemoteFileRef[]>
  listChanges?(token: string): Promise<ChangePage>
}
```

2. Implement `MockSyncProvider`:
   - In-memory fake Drive.
   - Supports duplicate names, missing files, remote edits, and deletes.

   Acceptance:
   - Unit tests can simulate two devices without Google OAuth.

3. Implement `syncOnce()` with the mock provider:
   - Acquire local sync lock.
   - Ensure workspace and device record.
   - Pull tombstones first.
   - Pull entries.
   - Merge.
   - Reconcile attachment metadata.
   - Push tombstones, attachments, entries, conflicts, and transfer logs.
   - Write manifest last.
   - Pull once more to catch races.
   - Save checkpoint.

   Acceptance:
   - Two mock devices can sync different days and converge.
   - Same-day competing edit creates a conflict.
   - Delete-vs-edit creates a conflict.
   - Remote unchanged plus local changed pushes local.
   - Local unchanged plus remote changed accepts remote.
   - Deleted entry does not resurrect.
   - Attachment tombstone hides attachment.
   - Tombstones survive restart.

## P1 Google Drive Implementation

1. Drive folder setup:
   - Ensure root folder.
   - Ensure `devices`, `entries`, `attachments`, `filebox`, `transfers`, `conflicts`, and `tombstones`.
   - Persist folder/file IDs in local meta.

   Acceptance:
   - Setup is idempotent across repeated syncs.

2. Drive JSON round-trip:
   - Upload one entry JSON.
   - Download the same entry into another local profile/device simulation.
   - Verify content hash before/after.

3. Drive manifest:
   - Build manifest from local repositories.
   - Upload manifest after entity pushes.
   - Read manifest during pull.
   - Rebuild manifest from folder scan if missing.

4. Conservative change detection:
   - Full managed-folder scan first.
   - Optional Drive changes token after baseline.
   - Fallback to full scan on uncertainty.

   Acceptance:
   - Renamed, deleted, or duplicated Drive file creates a diagnostic/conflict and does not silently overwrite local data.

## P1 Attachments And File Hub

1. File Box intake:
   - Desktop drag/drop.
   - Paste file/image.
   - File input.
   - Camera input where supported.

   Acceptance:
   - Intake creates a file box item, local blob, and transfer row.

2. Accept/reject/move-date:
   - Accept attaches to current entry.
   - Move date changes target entry.
   - Reject deletes or tombstones the pending item.

   Acceptance:
   - File Hub counters and entry attachments update correctly.

3. Attachment upload/download:
   - Upload blob after accept.
   - Store Drive file ID/path.
   - On another device, restore metadata and download blob.
   - Verify SHA-256 before marking restored.

   Acceptance:
   - An image/file attached on desktop appears restorable in a PWA/mobile context and vice versa.

4. Retry and failure states:
   - Failed upload.
   - Missing local blob.
   - Remote unavailable.
   - Hash mismatch.

   Acceptance:
   - User sees actionable status and retry controls.

## P1 UX Conversion

1. First-run sync wizard:
   - Explain local-first storage.
   - Choose/connect Drive.
   - Confirm local storage and attachment folder.
   - Show first sync result.

   Acceptance:
   - OAuth client ID is not presented as a scary primary field unless in Advanced.

2. Mobile bottom-tab shell:
   - Today.
   - Days/Search.
   - Capture.
   - Files.
   - Sync/Settings.

   Acceptance:
   - Mobile no longer renders the large desktop sidebar as the primary navigation.

3. Desktop focus layout:
   - Today note is primary.
   - Collapsible sidebar.
   - Collapsible details drawer.
   - Contextual toolbar.
   - Export/details/workbook/sync diagnostics move to overflow or secondary UI.

   Acceptance:
   - First screen reads as a writing app, not a sync dashboard.

## P2 Release Hardening

1. Local backup/restore:
   - Versioned archive of entries, metadata, tombstones, conflicts, and attachments.
   - Restore into a fresh local profile.

   Acceptance:
   - Backup restore works without Google Drive.

2. Sync diagnostics:
   - Last sync.
   - Pending queue.
   - Conflicts.
   - Failed transfers.
   - Drive folder ID.
   - Local storage path.

   Acceptance:
   - Failures are inspectable without developer tools.

3. Cross-device Playwright tests:
   - Two browser contexts/profiles.
   - Offline edit then reconnect.
   - Attachment upload/download.
   - Conflict.
   - Tombstone.

   Acceptance:
   - These are the main v1 safety tests and pass before v1 is called ready.

## Current Branch Status

Implemented in this branch:

- IndexedDB-backed repository layer.
- Canonical JSON and blob hashing.
- Blob storage abstraction for IndexedDB.
- Remote JSON schema validators.
- Mock sync provider.
- Google Drive adapter that implements the new `SyncProvider` path contract over the existing OAuth/Drive folder client.
- Repository-backed `IndexedDbJournalStore` for snapshots, devices, and sync engine checkpoints.
- `syncOnce()` engine for entry pull/push, attachment metadata, attachment blob upload/download, tombstones, and conflicts.
- Visible Google Drive sync action now stages current UI state, writes attachment blobs into `IndexedDbBlobStore`, runs `syncOnce()`, and refreshes the app from the synced repository snapshot.
- Sync pane includes the last sync result for pulled/pushed entries, attachment metadata, uploaded/downloaded blobs, tombstones, and conflicts.
- Local backup/restore archive for entries, attachment metadata, file box items, transfers, conflicts, tombstones, device metadata, and cached attachment blobs.
- Conflict resolution controls in the Sync pane for local wins, Drive copy wins, or keeping both as a separate entry copy.
- Google Drive upload retry handling plus resumable upload for larger attachment blobs.
- Two isolated browser-profile tests for attachment blob round-trip, offline edit conflict preservation, and tombstone propagation.
- First-run Sync pane copy now explains local-first Drive setup and keeps Desktop app and Web/PWA OAuth client IDs under an Advanced section with legacy single-client fallback.
- File Hub and Entry File Box rows now show actionable recovery hints for failed sync, missing local references, remote-only files, remote unavailable errors, and hash mismatch errors.
- Release readiness checklist for desktop installer, PWA, sync smoke, data safety, and secret hygiene.
- Focused tests for repository CRUD, stable hashing, validation, two-device convergence, attachment metadata, blob restoration, conflicts, tombstone non-resurrection, backup restore, Google Drive provider path mapping, upload retry, and two-profile repository-backed sync.

Next implementation task:

1. Verify the real Google Drive OAuth flow with a user-provided OAuth client ID and consent.
2. Run a clean desktop installer smoke plus mobile PWA installability check after real Drive auth succeeds.
3. Promote the passing verification evidence into the release checklist before tagging a trial build.
4. Consider a guided OAuth setup screen only if the Advanced fields still confuse first-run testing.
