# Drive v1 cross-client safety gate

These fixtures define the conservative compatibility policy that native Android,
web/PWA, and Electron must satisfy before native Google Drive writes can be
wired. Electron uses the web renderer and therefore shares its sync semantics.

This gate is intentionally test-only. Its tests pass when the target contract is
internally consistent and every known runtime incompatibility remains explicitly
classified as blocking. It is not a claim that runtime parity has passed, does
not enable writes, and does not authorize live Drive mutation testing.

## Current result

Offline transaction parity is implemented and tested for Android, web/PWA, and
the shared Electron renderer. Runtime parity remains **blocked on isolated live
versioned-CAS validation**. The low-level web Google client now has offline-tested
fresh-ETag conditional writes, resumable recovery, and manifest-last transaction
planning, but normal web construction still reports versioned CAS as disabled.
Android production still constructs only the read-only Drive path. No fixture or
passing offline test authorizes a real Drive mutation.

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
- The staged offline round trip locks Android-origin payloads, a guarded web
  edit, an Electron tombstone, Android non-resurrection, and final manifest
  counts to the same paths and semantic hashes.

Changing the deletion cascade or canonical identity rules is a breaking contract
change and requires explicit review before runtime behavior is modified.
