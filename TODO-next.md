# Next tasks to resume

- [x] Make checklist items fully editable (toggle done, add/remove items) and reflect in stored blocks.
- [x] Add inline attachment placeholders in the editor (thumbnail + open/view actions).
- [x] Persist disk cache preference + badge; fall back to IndexedDB gracefully.
- [x] Sync queue: mock API, statuses (pending/synced/failed), retry + timestamps; show per-block `updated_by/at` in UI.
- [x] Attachment filesystem writes: choose/change cache dir in Settings, validate write access, show error state when unavailable.

## Next ideas (optional)

- Persist sync queue across reloads (localStorage), with “clear all” + per-entry filter.
- Implement “New Experiment” creation flow and attach entries to it.
