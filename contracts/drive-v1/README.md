# Google Drive v1 contract fixtures

This directory is the golden, compatibility-locked JSON tree for the Drive v1 sync contract. Relative fixture paths are the logical paths below the `Easylab Lab Notebook` Drive folder.

| Fixture | Drive v1 role |
| --- | --- |
| `manifest.json` | Workspace manifest |
| `devices/dev-contract.json` | Device profile |
| `entries/2026-05-23.json` | Daily entry envelope |
| `attachments/2026-05-23/att-contract-result.csv.json` | Attachment metadata envelope; the blob path is the same path without `.json` |
| `filebox/filebox-contract.json` | File Box item envelope |
| `transfers/transfer-contract.json` | Transfer envelope |
| `conflicts/conf-entry-entry-contract.json` | Conflict record |
| `tombstones/attachment--att-deleted.json` | Tombstone record |

Drive v1 envelopes have `version: 1`; their top-level `id` must equal `payload.id`. Timestamps are ISO-8601 timestamps. New readers may add validation, but writers must preserve these paths and JSON shapes unless a new contract version is introduced.
