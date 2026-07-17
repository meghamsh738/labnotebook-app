# Mac Codex Handover

Continue in the existing native recovery checkout:

```bash
cd "/Users/meghamsh/Coding Projects/lab-note-taking-app-connected-devices"
git status --short --branch
```

## Authoritative Recovery State

- Branch: `codex/native-android-recovery`
- Tag: `recovery/native-compose-baseline-20260717`
- Baseline commit: `6893dd64cfd908c54b541715ed4e3624af4ce5c3`
- Primary target: native Android with Jetpack Compose, Room, and WorkManager
- Preserved sibling clients: React web/PWA and Electron desktop

The old Windows path, transfer-root instructions, bundle-first restore flow, and Pixel PWA milestone are superseded. Use the local repository above unless disaster recovery is actually required.

## What Is Implemented

- Native Compose navigation and journal/editor/workbook/File Hub surfaces.
- Room-backed entries, blocks, attachments, sync records, deletions, and account-scoped state.
- Native authentication/session handling and lifecycle-safe activity result flow.
- Android share intents, bounded local file capture, rollback behavior, and local blob storage.
- Legacy workspace import with validation and conflict handling.
- Drive v1 models, compatibility fixtures, local serializers, read-only metadata pull, and WorkManager scheduling.
- Unit/Robolectric/Compose coverage plus a connected instrumentation target.

## Non-Negotiable Write Gate

Remote native Drive writes are **not production-enabled**. The worker currently creates a read-only Drive repository, and write attempts fail closed with `DisabledPendingContractParity`. Do not wire `GoogleDriveWriteRepository` into production merely because its isolated tests pass.

Before enabling writes, require reviewed proof of lossless contract parity, conflict/tombstone safety, retry/idempotency behavior, and Android-to-web-to-desktop round trips. Ship the change behind an explicit gate with a rollback to read-only. Local Room and capture writes remain allowed.

## Validation Commands

```bash
npm run android:test
npm run android:build:debug
```

When a device/emulator is available:

```bash
npm run android:gradle -- :app:connectedDebugAndroidTest
```

Do not use `npm run android:sync` during normal native work; it is the legacy Capacitor/web asset synchronization path.

## Next Milestones

1. Run the full native unit and debug APK build from a clean working tree and fix any recovery-environment regressions.
2. Exercise native sign-in, local editing/capture, process recreation, and read-only metadata sync on a device without enabling Drive mutation.
3. Complete cross-client Drive v1 parity and destructive-conflict fixtures, then review the native-write gate separately.
4. Finish accessibility, adaptive-layout, and device acceptance checks for the native Compose surfaces.

Do not commit secrets, account identifiers, private Drive data, local databases, or generated test/build artifacts.
