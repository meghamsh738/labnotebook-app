# Lab Note Taking App — TODO

- [x] Basic Slate-based inline editor for headings/paragraphs/quotes (in-memory drafts).
- [x] Persist edited blocks to local storage/IndexedDB (localStorage cache for now).
- [x] Local full-text search index (lunr) with filters for date, tags, projects, and attachment types.
- [x] Attachment pipeline: drag/drop + paste → cache metadata, image previews, pin offline toggle (mock path; no disk copy yet).
- [x] Offline-first sync scaffold: per-block `updated_at/updated_by`, change queue, status chip (mocked sync now).
- [x] Entry creation flow with templates (Summary/Protocol/Results pinned regions prefilled).
- [x] Export options: PDF/Markdown bundle for an experiment with attachment manifest.
