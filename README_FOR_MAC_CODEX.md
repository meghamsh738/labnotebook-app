# Lab Notebook: Mac Codex Recovery Guide

This repository is the authoritative local checkout for continued work:

```text
/Users/meghamsh/Coding Projects/lab-note-taking-app-connected-devices
```

Do not resume from the old Windows transfer snapshot, a copied PWA folder, or a bundle unless this checkout is lost.

## Recovery Point

- Branch: `codex/native-android-recovery`
- Recovery tag: `recovery/native-compose-baseline-20260717`
- Tagged commit: `6893dd64cfd908c54b541715ed4e3624af4ce5c3`

To return to the preserved baseline without changing the current checkout:

```bash
cd "/Users/meghamsh/Coding Projects/lab-note-taking-app-connected-devices"
git switch -c codex/native-recovery-check recovery/native-compose-baseline-20260717
```

## Current Product State

Android is a native Jetpack Compose application, not a PWA handoff target. `MainActivity` installs the Compose UI and the production app uses Room repositories for journal entries, editor mutations, attachments, File Hub records, and durable local state. Native Google authentication, Android share/capture handling, legacy workspace import, WorkManager sync scheduling, Drive v1 serialization, and read-only Drive metadata pull are present.

The web and Electron implementations remain in the repository as preserved sibling clients and compatibility references. Do not run Capacitor asset sync as part of normal native development; `npm run android:sync` is the legacy web-wrapper path and can replace generated Android assets.

## Native-Write Safety Gate

**Keep native Google Drive writes disabled.** Production sync must continue to use `NativeDriveReadOnlyFactory`, `GoogleDriveReadOnlyRepository`, and `DriveWriteCapability.DisabledPendingContractParity`. The tested `GoogleDriveWriteRepository` is preparatory code only and must not be injected into the app or worker yet.

Enable native remote writes only after all of these are complete and explicitly reviewed:

1. Lossless Drive v1 serialization and manifest/count validation pass for every record type.
2. Conflict, tombstone, interrupted-sync, and retry behavior pass against compatibility fixtures.
3. Cross-client Android/web/desktop round trips prove that no newer data, attachment metadata, or blobs are overwritten or deleted.
4. A reviewed feature gate and rollback path exist, with read-only remaining the default.

Local Room edits and local capture/blob writes are expected; this gate applies to remote Google Drive mutation.

## Validate

From the authoritative checkout:

```bash
cd "/Users/meghamsh/Coding Projects/lab-note-taking-app-connected-devices"
npm run android:test
npm run android:build:debug
```

With an emulator or device connected, also run:

```bash
npm run android:gradle -- :app:connectedDebugAndroidTest
```

The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. The Gradle helper selects Android Studio's Java 21 runtime when available.

## Safety

- Never commit access tokens, refresh tokens, account identifiers, credentials, local databases, private Drive content, or device test data.
- Keep `android/local.properties`, generated build output, runtime data, and test reports untracked.
- Review `git status --short` before commits; this checkout can contain unrelated in-progress work.
