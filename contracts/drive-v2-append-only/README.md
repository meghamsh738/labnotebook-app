# Drive v2 append-only safety contract

Drive v2 is an isolated successor to the existing Drive v1 workspace. It exists
because the live Drive v3 API did not return the ETag needed for an atomic
in-place update. Drive's output-only `version` field can detect a race, but it
cannot prevent one client from overwriting another between a read and a write.

This contract removes that overwrite operation entirely. A v2 client creates
immutable, content-addressed objects and publishes an immutable commit last.
Readers merge every valid commit graph tip. Concurrent edits remain separate
and become a deterministic conflict; a client never chooses a winner merely by
wall-clock time.

## Isolation from Drive v1

- The v1 root remains read-only. No v2 code may update, delete, rename, or add
  files beneath it.
- V2 uses the exact root name `Easylab Lab Notebook v2` and a protocol marker.
- Creating a v2 workspace is an explicit single-client operation. Automatic
  provisioning during normal sync is forbidden. Duplicate marked roots block.
- V1 migration is a verified read-only import that creates a v2 genesis commit.
  It never turns the old v1 files into writable state.

## Remote representation

The v2 root contains exactly three managed folders:

- `objects/` stores immutable JSON entity-operation envelopes.
- `blobs/` stores immutable attachment bytes addressed by SHA-256.
- `commits/` stores immutable transaction commits.

Every artifact is created with a pre-generated Drive file ID persisted in the
account-scoped local operation journal before the request. Retries use the same
ID. A `409` or lost response is success only after exact metadata, app-property,
byte, and stable second-read verification. No v2 protocol request uses
`files.update`, multipart `PATCH`, or resumable `PATCH`.

Logical names are content-addressed. Exact duplicate artifacts are equivalent;
the same logical name with different bytes or protocol properties blocks the
workspace. Drive file IDs, ETags, resumable session URLs, OAuth data, and account
identity never participate in canonical hashes or remote payloads.

Every remote artifact is bound to a public random workspace ID. The local retry
identity is the tuple `(accountScopeId, savedRootDriveFileId, workspaceId,
operationId)`. Only the workspace ID appears remotely. Account scope and Drive
IDs remain in the encrypted/account-scoped local stores. A changed account,
saved root, marker, workspace ID, managed-folder identity, or duplicate marked
root blocks the journal before any remote request that can mutate state.

Object envelopes and commits use RFC 8785 canonical JSON and the exact schemas
locked in `policy.json`. Readers validate the exact downloaded bytes with fatal
UTF-8 decoding, reject lone Unicode surrogates, and require those bytes to
already be canonical before hashing them. Arrays that represent sets are sorted
and unique. An object envelope directly references the previous object frontier
for its one entity. Attachments require an entry ID, File Box items require
entry and attachment IDs, and transfers require entry, attachment, and File Box
IDs; every referenced target must be reachable and the parent chains must agree.
A commit references the exact objects and blobs it introduces, plus its parent
commits. The content digest determines the logical ID and path; a Drive file ID
is only a retry handle.

Remote object and commit bodies permit numeric JSON primitives only for signed
safe integers (`-9007199254740991` through `9007199254740991`). Decimal and
scientific measurements are canonical decimal strings. This deliberately narrow
cross-client domain prevents Android and ECMAScript number-formatting differences
from producing different content IDs; unsupported numbers block before mutation.

## Commit graph and visibility

A transaction creates blobs first, then object envelopes, then one commit. The
commit lists exact prerequisite hashes and all graph tips observed during
planning. Until the commit is present and all references verify, none of its
objects are visible. Unreferenced prerequisites are inert orphans and cannot
resurrect data.

Commits form a directed acyclic graph, while each entity has its own object
history graph. The visible frontier for an entity is calculated across every
object reachable from every valid commit, not merely from objects introduced by
the current commit tips. A commit that edits entity B therefore cannot erase an
unchanged entity A or one of A's unresolved branches.

A causal object descendant supersedes its referenced ancestors for that entity.
Concurrent divergent maxima become a conflict whose ID is derived from the
target and sorted maximal object IDs. Concurrent tombstones converge only when
their canonical object IDs are identical; different timestamps or metadata do
not elect a winner. Concurrent delete/edit state is hidden until an explicit
resolution references every conflicting object and descends from every graph
tip that exposed it. Restoring even a single causally prior tombstone requires a
`resolve-upsert` object; a regular upsert cannot resurrect it. Parent deletion
continues to suppress File Box and transfer descendants transitively.

Malformed commits, missing references, graph cycles, unknown managed artifacts,
divergent duplicates, and account/workspace changes block mutation. They never
become an excuse to publish a repair commit.

The fixtures distinguish canonical logical graph bodies from remote snapshots.
Logical fixtures lock hashes, ancestry, frontiers, and projections. The remote
preflight fixture supplies the complete Drive metadata tuple for every artifact:
exact parent folder, content-addressed path, MIME type, byte count, content hash,
app properties, raw downloaded bytes, and opaque Drive file ID. A single
`validateBeforePlan` reference gate checks the local journal identity, exact root
and managed folders, every remote artifact, commit prerequisites, relationship
chains, and the derived projection before it can return a plan. All
malformed/switched snapshots are sent through that same gate with a writer spy
proving zero mutation calls.

## Runtime gate

This directory is an offline contract only. Android production must continue to
construct the read-only Drive repository, and the real web provider must remain
write-disabled. A separate reviewed live harness and exact per-run user approval
are required before any v2 Drive mutation test.
