# EasyLab Next development boundary

The user explicitly requested a separate development version for the Suite and all eight modules on 13 November 2026. This worktree belongs to that version.

- Development branch: `codex/easylab-next-20261113`. Preserve the original checkout and its branch. Do not switch, edit, reset, clean, build in, or install over the original checkout.
- Use this worktree for the approved EasyLab improvement plan. The Suite at `/Volumes/Coding Projects/Active/easylab-next/suite` must use only sibling module worktrees under `/Volumes/Coding Projects/Active/easylab-next/modules`.
- Preserve baseline tag `preserved/easylab-before-next-20261113`. Do not move or overwrite it.
- Do not symlink build outputs, node_modules, writable Python environments, settings, databases or user profiles to a stable checkout or installed app.
- Before any app preview, implement and verify separate Electron userData, module data/export/settings directories and strict backend/frontend ports. Existing default launch commands are not runtime-isolated. qPCR Analysis has its own home-directory settings paths; redirect them explicitly. Do not repurpose HOME.
- Never reuse an unknown listener as a module server. Use only verified task-owned processes and stop only those processes.
- The installed `/Users/meghamsh/Applications/Easylab Suite.app` and existing lab data must remain unchanged. Do not copy real user sessions or data into test profiles.
- Changes may be committed and pushed to this development branch. Merging, replacing the installed app, publishing or cloud-data changes still require the applicable separate authorization.
- Source-specific safety rules below still apply. Historical project-root instructions are superseded for this Next branch by the explicit worktree boundary above.

Current development checkout: `/Volumes/Coding Projects/Active/easylab-next/modules/labnotebook`.

Preserved original checkout: `/Volumes/Coding Projects/Active/lab-note-taking-app-connected-devices`.

# Local Codex Instructions

Use this local Mac copy as the project root:

`/Users/meghamsh/Coding Projects/lab-note-taking-app-connected-devices`

Do not work from the Google Drive synced copy:

`/Users/meghamsh/Google Drive/My Drive/Coding Projects/lab-note-taking-app-connected-devices`

Do not work from the CloudStorage backing path:

`/Users/meghamsh/Library/CloudStorage/GoogleDrive-meghamshteja@gmail.com/My Drive/Coding Projects/lab-note-taking-app-connected-devices`

Google Drive is a backup/source mirror only unless the user explicitly asks to sync changes there. Install dependencies, run dev servers, run builds, and edit files from this local folder.

Read `README_FOR_MAC_CODEX.md`, `MAC_CODEX_HANDOVER.md`, and `LOCAL_WORKSPACE_THREAD_NOTE.md` before making project changes.
