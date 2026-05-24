# Standalone Lab Notebook Release Checklist

Use this before calling the connected-devices branch ready for a desktop/PWA trial.

## Build Gates

- `npm --prefix web run lint`
- `npm --prefix web run build`
- `npm --prefix web run test:e2e -- --project=desktop-chromium`
- `npm --prefix web run test:e2e -- --project=mobile-chromium web/tests/mobile-pair.spec.ts`
- `npm run standalone:build`

## Sync Smoke

- Create or enter the right Google OAuth client ID in Sync > Advanced OAuth client IDs:
  - Desktop app OAuth client ID for the Electron app.
  - Web/PWA OAuth client ID for the browser or installed PWA origin.
- Use the `https://www.googleapis.com/auth/drive.file` scope only.
- Connect Google Drive and confirm the app creates the configured Drive folder.
- Create today's entry, attach one small file, run sync, restart the app, and confirm the entry and file metadata reload.
- Repeat with a second browser profile or PWA viewport before claiming cross-device readiness.

## Data Safety

- Export a local backup before destructive tests.
- Verify failed transfer rows show recovery actions.
- Verify conflicts can be resolved as local, Drive copy, or keep both.
- Verify tombstones prevent deleted entries/files from reappearing on another profile.

## Packaging

- Install the generated desktop installer on a clean profile.
- Confirm the app title, icon, local data paths, Sync pane paths, and backup export location.
- Confirm the PWA manifest and service worker are present in the built `web/dist` output.

## Secret Hygiene

- Do not commit OAuth client secrets, access tokens, refresh tokens, Google account data, Drive file dumps, local backups, or user notebook data.
- OAuth client IDs are non-secret configuration, but keep real user-specific IDs out of public docs unless intentionally publishing them.
- Scan staged diffs before every push.
