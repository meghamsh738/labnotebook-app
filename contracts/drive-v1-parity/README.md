# Drive v1 cross-client safety gate

These fixtures define the conservative compatibility policy that native Android,
web/PWA, and Electron must satisfy before native Google Drive writes can be
wired. Electron uses the web renderer and therefore shares its sync semantics.

This gate is intentionally test-only. Its tests pass when the target contract is
internally consistent and every known runtime incompatibility remains explicitly
classified as blocking. It is not a claim that runtime parity has passed, does
not enable writes, and does not authorize live Drive mutation testing.

## Current result

Runtime parity remains **blocked only on production web versioned CAS**.
Android's baseline-free daily-entry path and `data:` thumbnail projection,
native/web tombstone target normalization, the web File Box-to-transfer
cascade, malformed JSON quarantine, and web payload projection now have
client-behavior tests. The web provider protocol and mock enforce version/ETag
preconditions, but the real Google provider and sync engine remain deliberately
unwired pending a separately reviewed, live-write-safe milestone.

## Locked policies

- Existing remote files require an exact Drive file ID and positive Drive
  version. A fresh ETag is fetched immediately before mutation.
- Missing records with a prior baseline are blocked unless a tombstone proves
  deletion. The unwired native transaction path supports create-only writes for
  genuinely new records: it never overwrites an occupant and accepts a retry
  only after deterministic identity, metadata, and downloaded bytes all match.
  This offline-tested capability does not authorize production writes.
- Verified existing paths are preserved. New unique daily entries use
  `entries/{date}.json`; same-day collisions add the encoded entity ID.
- Unsafe local paths, cache keys, object URLs, and local-only thumbnails are
  removed from outbound payloads. Unknown remote fields remain losslessly
  preserved.
- Conflict IDs and tombstone IDs are deterministic. A tombstone target is
  identified by `(entityKind, entityId)`, not by its record ID.
- A parent tombstone suppresses its descendants transitively. Explicit child
  tombstones are accepted for native compatibility but are not required.
- For equal tombstone targets, the later `deletedAt` wins. Identical records at
  the same instant converge. Divergent records at the same instant block.
- Stale live JSON or blobs never resurrect a tombstoned entity or descendant.
- Malformed remote JSON is quarantined losslessly as a pending conflict.

Changing the deletion cascade or canonical identity rules is a breaking contract
change and requires explicit review before runtime behavior is modified.
