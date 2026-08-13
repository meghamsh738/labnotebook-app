# Drive v2 isolated live validation

This harness validates the append-only Drive v2 protocol without enabling any
normal application write path. It is restricted to a disposable Google account
workspace and an exact, timestamped folder named:

`Easylab Lab Notebook Safety Validation <run-id>`

The normal `Easylab Lab Notebook` Drive v1 folder is never selected or changed.
The v2 root is created only beneath the marked validation container. The harness
never updates, patches, physically deletes, trashes, or automatically cleans up
Drive data.

## Safety boundary

The launcher refuses to continue unless all of these checks pass:

- The Git worktree is clean and still at the exact reviewed source commit.
- The plan, OAuth configuration, token cache, and evidence paths are ignored by
  Git and remain inside `.labnote-local/` or `.labnote-smoke/`.
- `EASYLAB_DRIVE_V2_LIVE_WRITE_TEST=approved` is present.
- `EASYLAB_DRIVE_V2_LIVE_MODE=debug-test` is present.
- `EASYLAB_DRIVE_V2_USER_CONFIRMATION=approved:<run-id>` exactly matches the
  current one-run plan.
- `EASYLAB_DRIVE_V2_FORBIDDEN_ACCOUNT_SHA256` contains the mandatory built-in
  project-owner exclusion hash
  `e39ed3e99d1d992cf2d81d2c4701dc22000d713fc37b2ae1047f7ca520fecd8b`.
  Additional forbidden-account hashes may be comma-separated.
- Google confirms that the effective access token grants exactly `drive.file`.
- The selected Google account is not forbidden.
- The remote container, root, managed folders, and every existing artifact have
  their exact expected identity and no ambiguous occupant.

Account exclusion happens before a newly issued refresh token is written and
again before any provisioning request. Tokens, account addresses, Drive IDs,
folder IDs, resumable session URLs, and private content are never written to
committed or public evidence. The selected account's one-way SHA-256 identity is
bound to the ignored token cache, folder journal, artifact-ID journals, and
test-only account scope so a retry cannot silently switch Google accounts.

## Reviewed offline gates

Run these before preparing a live plan:

```bash
npm run test:drive-v2-contract
npm run test:drive-v2-live-gate
npm run test:drive-v2-live-worker
npm --prefix web run lint
npm --prefix web run build
npm --prefix web run test:e2e -- \
  web/tests/drive-v2-live-validation-client.spec.ts \
  web/tests/drive-v2-live-validation-round-trip.spec.ts
npm run android:test
npm run android:gradle -- :app:lintDebug
npm run android:build:debug
npm run android:gradle -- :app:assembleDebugAndroidTest
```

The staged round-trip test skips by default. It can run only through the
authorized worker with a clean, source-bound plan.

## One-run workflow

1. Prepare the ignored plan. This is offline and makes no Google request:

   ```bash
   npm run prepare:drive-v2-live-validation
   ```

2. Export the exact plan path printed by `prepare`, the three required gate
   values, and at least the mandatory exclusion hash above. Additional hashes
   can be calculated locally without storing addresses in the repository:

   ```bash
   printf '%s' 'forbidden@example.invalid' | shasum -a 256
   ```

3. Run the local preflight. It makes no Google request:

   ```bash
   npm run preflight:drive-v2-live-validation
   ```

4. After the user confirms the exact run, authorize the disposable Google
   account. If consent is required, open only the ignored OAuth URL printed by
   the command and complete the Google account selection manually:

   ```bash
   npm run authorize:drive-v2-live-validation
   ```

5. Immediately before the first Drive mutation, confirm the selected account
   and exact timestamped container once more, then execute:

   ```bash
   npm run execute:drive-v2-live-validation
   ```

The worker creates the marked folders and pre-generates every artifact Drive ID
before the corresponding create request. It performs native genesis creation,
a web descendant edit, stale-plan rejection, lost-response reconciliation, an
interrupted large resumable create and retry, Electron-labeled tombstones, and a
final native graph read. Blobs are created before object metadata and every
commit is created last.

The public result is boolean-only and remains under the ignored run directory.
The validation container is deliberately left in Drive; its human-readable name
is reported so the user can inspect or remove it manually.

Passing this harness does **not** enable Android, web/PWA, or Electron production
writes. Production remains read-only/disabled until a separate rollout decision.

## Recorded validation status

The isolated append-only round trip has passed against the reviewed source at
commit `1d0a3d1450390ed64252589fcbcda233cc7d9a0f`. All expected artifacts were
present exactly once, no artifact was trashed or physically deleted, and the
final native read verified the single valid graph tip, large-blob integrity,
unknown-field preservation, tombstones, descendant suppression, and
non-resurrection. A finite browser read deadline stopped the combined runner
after its mutation phases; the same source-bound run was then completed by the
dedicated read-only native final phase, without replaying any Drive writes.

Only a redacted status summary with allowlisted metadata and boolean checks is
committed in `live-validation-result.json`.
The validation folder remains in the disposable account for manual inspection
or removal. Normal Android Drive v2 artifact writes remain read-only, and Drive
v2 artifact writes remain unwired in web/PWA and Electron. Existing non-v2
Drive behavior is outside this readiness claim.
