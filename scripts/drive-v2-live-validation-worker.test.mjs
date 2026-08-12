import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import test from 'node:test'
import {
  assertProvisioningJournal,
  folderJournal,
  makePkce,
} from './drive-v2-live-validation-worker.mjs'

const source = fs.readFileSync(new URL('./drive-v2-live-validation-worker.mjs', import.meta.url), 'utf8')
const browserSource = fs.readFileSync(new URL('../web/tests/drive-v2-live-validation-round-trip.spec.ts', import.meta.url), 'utf8')

test('PKCE challenge is deterministic SHA-256 base64url', () => {
  const bytes = Buffer.alloc(32, 7)
  const value = makePkce(bytes)
  const expectedVerifier = bytes.toString('base64url')
  const expectedChallenge = crypto.createHash('sha256').update(expectedVerifier).digest('base64url')
  assert.deepEqual(value, { verifier: expectedVerifier, challenge: expectedChallenge })
})

test('forbidden account is checked before a newly authorized refresh token is cached', () => {
  const authorizeStart = source.indexOf('export async function authorizeLiveDriveV2Validation')
  const selectedAccountCheck = source.indexOf('const selectedAccountSha256 = await verifySelectedAccount(String(payload.access_token))', authorizeStart)
  const tokenWrite = source.indexOf('writePrivateJson(tokenCachePath', selectedAccountCheck)
  assert.ok(authorizeStart >= 0 && selectedAccountCheck > authorizeStart && tokenWrite > selectedAccountCheck)
  assert.match(source.slice(tokenWrite, tokenWrite + 500), /account_sha256: selectedAccountSha256/)
})

test('private folder journal is account-bound and exactly matches signed-plan descriptors before creation', () => {
  const plan = {
    runId: '2026-08-12t12-00-00-000z-0123456789ab',
    workspaceId: `ws-v2-${'a'.repeat(32)}`,
    containerFolderName: 'Easylab Lab Notebook Safety Validation 2026-08-12t12-00-00-000z-0123456789ab',
  }
  const accountSha256 = 'b'.repeat(64)
  const journal = folderJournal(plan, ['container', 'workspace', 'objects', 'blobs', 'commits'], accountSha256)
  assert.equal(assertProvisioningJournal(plan, journal, accountSha256), journal)
  for (const changed of [
    { ...journal, accountSha256: 'c'.repeat(64) },
    { ...journal, container: { ...journal.container, name: 'Easylab Lab Notebook' } },
    { ...journal, workspace: { ...journal.workspace, parentId: 'root' } },
    { ...journal, folders: { ...journal.folders, blobs: { ...journal.folders.blobs, appProperties: { changed: 'true' } } } },
    { ...journal, unexpected: true },
  ]) assert.throws(() => assertProvisioningJournal(plan, changed, accountSha256))
})

test('execute and every private id journal remain bound to the authorized selected account', () => {
  const runStart = source.indexOf('export async function runLiveDriveV2Validation')
  const selectedAccount = source.indexOf('const selectedAccountSha256 = await verifySelectedAccount(accessToken)', runStart)
  const cacheBinding = source.indexOf('selectedAccountSha256 !== cached.accountSha256', selectedAccount)
  const provisioning = source.indexOf('provisionOrResume({ accessToken, plan, evidenceDir, selectedAccountSha256 })', cacheBinding)
  assert.ok(runStart >= 0 && selectedAccount > runStart && cacheBinding > selectedAccount && provisioning > cacheBinding)
  assert.match(source, /accountSha256: requireAccountSha256\(selectedAccountSha256\)/)
  assert.match(source, /EASYLAB_DRIVE_V2_ACCOUNT_SHA256/)
})

test('folder and genesis ids are persisted before any corresponding mutation phase', () => {
  const provisionStart = source.indexOf('async function provisionOrResume')
  const folderIds = source.indexOf('writePrivateJson(journalFile, journal)', provisionStart)
  const folderCreate = source.indexOf('await reconcileOrCreateFolder', provisionStart)
  assert.ok(folderIds > provisionStart && folderCreate > folderIds)

  const runStart = source.indexOf('export async function runLiveDriveV2Validation')
  const nativeIds = source.indexOf('const nativeIds = await nativeGenesisIds', runStart)
  const nativeCreate = source.indexOf("'nativeCreatesGenesisWithLargeBlobAndCommitLast'", runStart)
  assert.ok(nativeIds > runStart && nativeCreate > nativeIds)
  assert.match(source, /EASYLAB_DRIVE_V2_NATIVE_BLOB_FILE_ID/)
  assert.match(source, /EASYLAB_DRIVE_V2_NATIVE_ENTRY_FILE_ID/)
  assert.match(source, /EASYLAB_DRIVE_V2_NATIVE_ATTACHMENT_FILE_ID/)
  assert.match(source, /EASYLAB_DRIVE_V2_NATIVE_COMMIT_FILE_ID/)
  for (const name of [
    'WEB_ENTRY', 'WEB_COMMIT', 'WEB_LARGE_BLOB', 'WEB_ATTACHMENT', 'WEB_BLOB_COMMIT',
    'ELECTRON_ENTRY_TOMBSTONE', 'ELECTRON_ATTACHMENT_TOMBSTONE', 'ELECTRON_COMMIT',
  ]) assert.match(source, new RegExp(`EASYLAB_DRIVE_V2_${name}_FILE_ID`))
  const browserJournal = source.indexOf("'browser-artifact-ids.json'")
  const browserGenerate = source.indexOf('generateIds(accessToken, BROWSER_ID_ROLES.length)', browserJournal)
  const browserWrite = source.indexOf('writePrivateJson(filePath', browserGenerate)
  const browserPhase = source.indexOf('runBrowserPhase(context', browserWrite)
  assert.ok(browserJournal >= 0 && browserGenerate > browserJournal && browserWrite > browserGenerate && browserPhase > browserWrite)
})

test('execution order is native genesis, Playwright append/tombstone, then final native read', () => {
  const runStart = source.indexOf('export async function runLiveDriveV2Validation')
  const nativeCreate = source.indexOf("'nativeCreatesGenesisWithLargeBlobAndCommitLast'", runStart)
  const browser = source.indexOf('runBrowserPhase(context', runStart)
  const nativeFinal = source.indexOf("'nativeReadsFinalGraphAndProvesNonResurrection'", runStart)
  const finalInventory = source.indexOf('const finalInventory', runStart)
  assert.ok(runStart >= 0 && nativeCreate > runStart && browser > nativeCreate && nativeFinal > browser && finalInventory > nativeFinal)
})

test('worker has no PATCH, DELETE, v1 provider, production wiring, or automatic cleanup flow', () => {
  assert.match(source, /if \(!\['GET', 'POST', 'PUT'\]\.includes\(method\)\)/)
  assert.doesNotMatch(source, /EASYLAB_DRIVE_V1|GoogleDriveProvider|GoogleDriveSyncProvider|files\.update|files\.delete/)
  assert.doesNotMatch(source, /rmSync\([^)]*container|rmSync\([^)]*workspace|unlinkSync/)
  assert.match(source, /validationContainerAutomaticallyDeleted: false/)
  assert.match(source, /productionWritesEnabled: false/)
})

test('public result uses the boolean-only evidence constructor and never includes remote ids', () => {
  const runStart = source.indexOf('export async function runLiveDriveV2Validation')
  const publicResult = source.slice(runStart)
  assert.match(publicResult, /publicValidationEvidence/)
  assert.doesNotMatch(publicResult, /checks:\s*\{[^}]*(containerFolderName|workspaceId|DriveFileId)/)
})

test('browser round trip is default-off, source-bound, append-only, and staged commit-last', () => {
  assert.match(browserSource, /test\.skip\(!enabled/)
  assert.match(browserSource, /EASYLAB_DRIVE_V2_USER_CONFIRMATION/)
  assert.match(browserSource, /git\(\['rev-parse', 'HEAD'\]\)/)
  assert.match(browserSource, /git\(\['status', '--porcelain=v1', '--untracked-files=all'\]\)/)
  assert.match(browserSource, /git\(\['check-ignore', planFile\]\)/)
  assert.match(browserSource, /lose-response-after-create/)
  assert.match(browserSource, /interrupt-before-resumable-content/)
  assert.match(browserSource, /incomplete-parent-frontier/)
  assert.match(browserSource, /device-electron-live-v2/)
  assert.match(browserSource, /orderedCalls\)\.toEqual\(\[blob\.path, attachment\.path, blobCommit\.path\]\)/)
  assert.doesNotMatch(browserSource, /\.putJson|\.putBlob|\.putManifest|GoogleDriveProvider|GoogleDriveSyncProvider/)
})
