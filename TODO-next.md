# Native Android recovery: next milestones

Authoritative checkout: `/Volumes/Coding Projects/Active/lab-notebook`

Recovery branch/tag: `codex/native-android-recovery` / `recovery/native-compose-baseline-20260717`

- [x] Preserve the recovered web, desktop, contract, and native Android source in reviewable commits and tag the recovery baseline.
- [x] Run web lint, production build, PWA verification, and Playwright from the authoritative checkout.
- [x] Run native unit tests, Android lint, debug APK, and instrumentation APK build gates.
- [ ] Commit and validate the hardened legacy importer for version rebasing, tombstone ordering, pending local mutations, and interrupted import.
- [ ] Fix the responsive UI-audit failures: tablet drawer interception, clipped tag controls, out-of-bounds compact controls, and undersized touch targets.
- [ ] On an emulator or device, verify sign-in, process recreation, local journal/editor writes, share capture, legacy import, and read-only metadata sync.
- [ ] Run `npm run android:gradle -- :app:connectedDebugAndroidTest` when a device/emulator is available.
- [ ] Add queue claims and compare-and-set completion before implementing any native Drive write executor.
- [ ] Add a three-way semantic-hash planner and durable conflict records for all Drive v1 entity types.
- [ ] Add fault-injected, resumable entity/blob upload with manifest-last repair and post-write hash verification.
- [ ] Expand cross-client fixtures for conflicts, tombstones, interrupted sync, attachments, duplicate folders, and manifest/count mismatches.
- [ ] Prove Android -> web -> desktop -> Android round trips are lossless before proposing any production native Drive mutation.
- [ ] Implement the remaining Protocols surface in Compose and complete editor/workbook parity.
- [ ] Complete Compose accessibility, adaptive-layout, and device acceptance checks.
- [ ] Remove the legacy WebView runtime only after editor, workbook, attachment, and migration parity tests pass.
- [ ] Configure release OAuth fingerprints, consent/privacy/support details, and Play signing for a signed internal build.

## Native-write safety gate

- [ ] Keep production injection on `NativeDriveReadOnlyFactory` / `GoogleDriveReadOnlyRepository`.
- [ ] Keep `DriveWriteCapability.DisabledPendingContractParity` as the production capability.
- [ ] Do not connect `GoogleDriveWriteRepository` until contract parity, conflict safety, retry/idempotency, cross-client round trips, an explicit feature gate, and rollback have passed review.

Local Room and capture/blob writes are allowed. The gate above applies to remote Google Drive writes.
