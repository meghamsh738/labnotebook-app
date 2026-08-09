# Drive v1 isolated live validation

This harness is a debug/test-only safety check. It does not enable normal Android, web/PWA, or Electron writes.

`prepare` performs no network request. It creates a hashed, ignored plan beneath `.labnote-smoke/drive-v1-conditional-validation/` and prints the exact disposable Drive folder name. The name always begins with `Easylab Lab Notebook Safety Validation `. The normal `Easylab Lab Notebook` folder is refused.

The first live mutation remains impossible until all of these are true at the same time:

- `EASYLAB_DRIVE_V1_LIVE_WRITE_TEST=approved`
- `EASYLAB_DRIVE_V1_LIVE_MODE=debug-test`
- `EASYLAB_DRIVE_V1_USER_CONFIRMATION=approved:<generated-run-id>`
- `EASYLAB_DRIVE_V1_LIVE_PLAN_FILE` names the ignored plan generated from the current commit
- the Git worktree is clean
- OAuth configuration and token storage are ignored beneath `.labnote-local/`
- evidence stays in the exact ignored run directory
- OAuth requests use only `https://www.googleapis.com/auth/drive.file`
- the refreshed access token is independently introspected and its effective scope is exactly `drive.file`
- at least one excluded account is supplied only as a SHA-256 hash and checked through Drive `about.get` before token storage or mutation

The remote gate exhausts every Drive listing page and accepts either no matching folder or one exact validation folder carrying this run's private validation marker. Duplicate roots, unknown files, duplicate paths, repeated page tokens, or the normal notebook folder fail closed. An unmarked file is accepted only when its path and immutable native entity/hash properties match the prepared validation plan. The harness never trashes or deletes the validation folder.

Resumable operation identity is memory-only in both native and browser validation code. It survives the deliberate retry within one validation process but does not persist Drive file identifiers, ETags, or session URLs to disk or IndexedDB.

Public evidence is allowlisted. It records booleans, the generated folder name, source commit, and test outcomes, but no account identity, OAuth token, Drive file/folder identifier, resumable session URL, or notebook content.

When `EASYLAB_DRIVE_V1_FORBIDDEN_ACCOUNT_SHA256` is set, the selected Drive account email is read once into memory, normalized, hashed, and compared. The plain email and its hash are never written to evidence or the operation journal. A match or missing identity stops the run before any Drive mutation.

The operator must pause after `prepare` and obtain explicit user confirmation for the generated folder before running `execute`.

Both the command-line wrapper and the exported worker revalidate the immutable plan file, clean source commit, exact ignored paths, and absence of symbolic-link path components before authorization or execution.

If the isolated token cache is absent, the gated `authorize` command requests only `drive.file`, writes the manual OAuth URL beneath ignored `.labnote-local/` storage, and performs no Drive mutation. It never opens or foregrounds a browser automatically.
