import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DRIVE_FILE_SCOPE, DRIVE_FOLDER_MIME_TYPE, DRIVE_V2_PROTOCOL_MARKER,
  LiveValidationGateError, MANAGED_FOLDER_ROLES, VALIDATION_APP_PROPERTY, WORKSPACE_ROOT_NAME,
  REQUIRED_FORBIDDEN_ACCOUNT_SHA256,
  assertDriveFileOnlyScope, assertEffectiveDriveFileOnlyAccessToken, assertLocalLiveAuthorization,
  assertSafeLocalIgnoredPath, assertSafeRemoteValidationWorkspace, assertSelectedAccountAllowed,
  assertSelectedDriveAccountAllowed, assertValidationPlan, collectPaginatedDriveFiles,
  createValidationPlan, normalizeForbiddenAccountHashes, publicValidationEvidence,
} from './drive-v2-live-validation-gate.mjs'

const commit = 'a'.repeat(40)
const repoRoot = '/tmp/easylab-drive-v2-live-gate'
const plan = createValidationPlan({
  now: new Date('2026-08-12T12:34:56.789Z'), randomHex: '0123456789ab', sourceCommit: commit,
})
const oauthConfigPath = path.join(repoRoot, '.labnote-local', 'oauth.desktop.json')
const tokenCachePath = path.join(repoRoot, '.labnote-local', 'drive-v2-live-token.json')
const evidenceDir = path.join(repoRoot, plan.evidenceRelativePath)
const forbiddenHash = crypto.createHash('sha256').update('excluded@example.test').digest('hex')
const env = {
  EASYLAB_DRIVE_V2_LIVE_WRITE_TEST: 'approved',
  EASYLAB_DRIVE_V2_LIVE_MODE: 'debug-test',
  EASYLAB_DRIVE_V2_USER_CONFIRMATION: `approved:${plan.runId}`,
  EASYLAB_DRIVE_V2_FORBIDDEN_ACCOUNT_SHA256: `${REQUIRED_FORBIDDEN_ACCOUNT_SHA256},${forbiddenHash}`,
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof LiveValidationGateError && error.code === code)
}

test('signed plan binds disposable container, deterministic workspace, source, and disabled state', () => {
  assert.equal(assertValidationPlan(plan), plan)
  assert.match(plan.containerFolderName, /^Easylab Lab Notebook Safety Validation /)
  assert.equal(plan.workspaceRootName, WORKSPACE_ROOT_NAME)
  assert.match(plan.workspaceId, /^ws-v2-[0-9a-f]{32}$/)
  assert.equal(plan.requiredScope, DRIVE_FILE_SCOPE)
  assert.equal(plan.autoDeleteValidationContainer, false)
  assert.equal(plan.productionWritesEnabled, false)
  assert.equal(createValidationPlan({
    now: new Date('2026-08-12T12:34:56.789Z'), randomHex: '0123456789ab', sourceCommit: commit,
  }).workspaceId, plan.workspaceId)
  for (const [change, code] of [
    [{ workspaceRootName: 'Easylab Lab Notebook' }, 'invalid-workspace-name'],
    [{ createdAt: '2026-08-13T12:34:56.789Z' }, 'invalid-created-at'],
    [{ requiredScope: 'https://www.googleapis.com/auth/drive' }, 'invalid-oauth-scope'],
    [{ autoDeleteValidationContainer: true }, 'automatic-delete-refused'],
    [{ productionWritesEnabled: true }, 'production-write-refused'],
    [{ sourceCommit: 'b'.repeat(40) }, 'invalid-workspace-id'],
  ]) expectCode(() => assertValidationPlan({ ...plan, ...change }), code)
})

test('authorization requires v2 gates, forbidden hash, exact source, clean tree, and private paths', () => {
  const input = {
    plan, env, repoRoot, currentHead: commit, gitStatus: '', oauthConfigPath, tokenCachePath,
    evidenceDir, trackedPaths: [],
  }
  assert.equal(assertLocalLiveAuthorization(input).forbiddenAccountExclusionConfigured, true)
  const failures = [
    [{ env: { ...env, EASYLAB_DRIVE_V2_LIVE_WRITE_TEST: '' } }, 'missing-live-acknowledgement'],
    [{ env: { ...env, EASYLAB_DRIVE_V2_LIVE_MODE: 'production' } }, 'missing-debug-test-mode'],
    [{ env: { ...env, EASYLAB_DRIVE_V2_USER_CONFIRMATION: 'approved:wrong' } }, 'missing-user-confirmation'],
    [{ env: { ...env, EASYLAB_DRIVE_V2_FORBIDDEN_ACCOUNT_SHA256: '' } }, 'missing-forbidden-account'],
    [{ env: { ...env, EASYLAB_DRIVE_V2_FORBIDDEN_ACCOUNT_SHA256: forbiddenHash } }, 'missing-required-forbidden-account'],
    [{ currentHead: 'b'.repeat(40) }, 'source-commit-changed'],
    [{ gitStatus: ' M web/src/App.tsx' }, 'dirty-worktree'],
    [{ oauthConfigPath: '/tmp/oauth.json' }, 'unsafe-credential-path'],
    [{ evidenceDir: path.join(repoRoot, '.labnote-smoke', 'wrong') }, 'unsafe-evidence-path'],
    [{ trackedPaths: [tokenCachePath] }, 'tracked-private-path'],
  ]
  for (const [change, code] of failures) expectCode(() => assertLocalLiveAuthorization({ ...input, ...change }), code)
})

test('OAuth token scope is exactly drive.file', async () => {
  assert.equal(assertDriveFileOnlyScope(DRIVE_FILE_SCOPE), DRIVE_FILE_SCOPE)
  expectCode(() => assertDriveFileOnlyScope(`openid ${DRIVE_FILE_SCOPE}`), 'invalid-oauth-scope')
  const calls = []
  assert.equal(await assertEffectiveDriveFileOnlyAccessToken('ephemeral', async (url, init) => {
    calls.push({ url, init })
    return { ok: true, json: async () => ({ scope: DRIVE_FILE_SCOPE }) }
  }), DRIVE_FILE_SCOPE)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.method, 'GET')
})

test('forbidden account is mandatory, hashed, and checked before identity lookup', async () => {
  const configured = `${REQUIRED_FORBIDDEN_ACCOUNT_SHA256},${forbiddenHash},${forbiddenHash}`
  assert.deepEqual(normalizeForbiddenAccountHashes(configured), [REQUIRED_FORBIDDEN_ACCOUNT_SHA256, forbiddenHash])
  assert.equal(
    assertSelectedAccountAllowed('allowed@example.test', configured),
    crypto.createHash('sha256').update('allowed@example.test').digest('hex'),
  )
  expectCode(() => assertSelectedAccountAllowed('excluded@example.test', configured), 'forbidden-validation-account')
  expectCode(() => assertSelectedAccountAllowed('mkonda@tcd.ie', configured), 'forbidden-validation-account')
  expectCode(() => normalizeForbiddenAccountHashes(forbiddenHash), 'missing-required-forbidden-account')
  expectCode(() => normalizeForbiddenAccountHashes(''), 'missing-forbidden-account')
  expectCode(() => normalizeForbiddenAccountHashes('mkonda@tcd.ie'), 'invalid-forbidden-account')
  let identityRead = false
  await assert.rejects(() => assertSelectedDriveAccountAllowed('', async () => {
    identityRead = true
    return { me: true, emailAddress: 'allowed@example.test' }
  }), (error) => error.code === 'missing-forbidden-account')
  assert.equal(identityRead, false)
})

test('pagination is exhaustive and repeated tokens fail closed', async () => {
  const tokens = []
  const files = await collectPaginatedDriveFiles(async (token) => {
    tokens.push(token)
    return token ? { files: [{ id: '2' }] } : { files: [{ id: '1' }], nextPageToken: 'next' }
  })
  assert.deepEqual(tokens, [undefined, 'next'])
  assert.deepEqual(files.map((file) => file.id), ['1', '2'])
  await assert.rejects(
    () => collectPaginatedDriveFiles(async () => ({ files: [], nextPageToken: 'repeat' })),
    (error) => error.code === 'invalid-drive-pagination',
  )
})

test('ignored paths reject outside, tracked, and symlink traversal', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easylab-v2-live-path-'))
  try {
    const ignored = path.join(temporaryRoot, '.ignored')
    const real = path.join(temporaryRoot, 'real')
    const linked = path.join(temporaryRoot, 'linked')
    fs.mkdirSync(ignored); fs.mkdirSync(real); fs.symlinkSync(real, linked)
    assert.equal(assertSafeLocalIgnoredPath({ repoRoot: temporaryRoot, filePath: path.join(ignored, 'plan'), label: 'Plan', isTracked: () => false, isIgnored: () => true }), path.join(ignored, 'plan'))
    for (const value of [
      { filePath: path.join(ignored, 'tracked'), isTracked: () => true, isIgnored: () => true },
      { filePath: path.join(temporaryRoot, '..', 'outside'), isTracked: () => false, isIgnored: () => true },
      { filePath: path.join(linked, 'token'), isTracked: () => false, isIgnored: () => true },
    ]) expectCode(() => assertSafeLocalIgnoredPath({ repoRoot: temporaryRoot, label: 'Private', ...value }), 'unsafe-local-path')
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }) }
})

function validInventory() {
  const container = { id: 'container-id', name: plan.containerFolderName, parentFolderDriveFileId: 'root', mimeType: DRIVE_FOLDER_MIME_TYPE, trashed: false, appProperties: { [VALIDATION_APP_PROPERTY]: plan.runId } }
  const workspace = { id: 'workspace-id', name: WORKSPACE_ROOT_NAME, parentFolderDriveFileId: 'container-id', mimeType: DRIVE_FOLDER_MIME_TYPE, trashed: false, appProperties: { easylabDriveProtocol: DRIVE_V2_PROTOCOL_MARKER, easylabWorkspaceId: plan.workspaceId, easylabArtifactKind: 'workspace-root' } }
  const folders = MANAGED_FOLDER_ROLES.map((role) => ({ id: `${role}-folder-id`, name: role, parentFolderDriveFileId: 'workspace-id', mimeType: DRIVE_FOLDER_MIME_TYPE, trashed: false, appProperties: { easylabDriveProtocol: DRIVE_V2_PROTOCOL_MARKER, easylabWorkspaceId: plan.workspaceId, easylabArtifactKind: 'managed-folder', easylabFolderRole: role } }))
  const id = `obj-v2-${'1'.repeat(64)}`
  const artifact = { id: 'artifact-id', path: `objects/${id}.json`, parentFolderDriveFileId: 'objects-folder-id', mimeType: 'application/json', trashed: false, appProperties: { easylabDriveProtocol: DRIVE_V2_PROTOCOL_MARKER, easylabWorkspaceId: plan.workspaceId, easylabArtifactKind: 'object', easylabCanonicalId: id, easylabContentSha256: '1'.repeat(64) } }
  return { container, workspace, folders, artifact }
}

test('remote inventory allows only exact isolated v2 folders and canonical artifacts', () => {
  assert.deepEqual(assertSafeRemoteValidationWorkspace({ plan, containerMatches: [] }), { disposition: 'create-new' })
  const { container, workspace, folders, artifact } = validInventory()
  const result = assertSafeRemoteValidationWorkspace({ plan, containerMatches: [container], containerChildren: [workspace], workspaceChildren: folders, managedFiles: [artifact] })
  assert.equal(result.disposition, 'resume-exact')
  assert.deepEqual(result.managedFolderIds, { objects: 'objects-folder-id', blobs: 'blobs-folder-id', commits: 'commits-folder-id' })
})

test('remote inventory requires complete array inputs', () => {
  expectCode(() => assertSafeRemoteValidationWorkspace({ plan }), 'invalid-remote-inventory')
})

test('remote inventory rejects ambiguity, foreign data, marker switches, and bad paths', () => {
  const { container, workspace, folders, artifact } = validInventory()
  const base = { plan, containerMatches: [container], containerChildren: [workspace], workspaceChildren: folders, managedFiles: [artifact] }
  for (const [change, code] of [
    [{ containerMatches: [container, container] }, 'ambiguous-validation-container'],
    [{ containerMatches: [{ ...container, parentFolderDriveFileId: 'foreign' }] }, 'invalid-container-parent'],
    [{ containerChildren: [workspace, { ...workspace, id: 'other' }] }, 'invalid-container-inventory'],
    [{ containerChildren: [{ ...workspace, appProperties: { ...workspace.appProperties, easylabWorkspaceId: `ws-v2-${'f'.repeat(32)}` } }] }, 'invalid-drive-properties'],
    [{ workspaceChildren: [...folders, { ...folders[0], id: 'foreign', name: 'unknown' }] }, 'invalid-workspace-inventory'],
    [{ workspaceChildren: [folders[0], folders[0], folders[2]] }, 'duplicate-managed-folder'],
    [{ managedFiles: [artifact, { ...artifact, id: 'duplicate' }] }, 'duplicate-artifact-path'],
    [{ managedFiles: [{ ...artifact, path: 'objects/not-canonical.json' }] }, 'invalid-artifact-path'],
    [{ managedFiles: [{ ...artifact, parentFolderDriveFileId: 'wrong' }] }, 'invalid-artifact-parent'],
    [{ managedFiles: [{ ...artifact, mimeType: 'text/plain' }] }, 'invalid-artifact-mime'],
    [{ managedFiles: [{ ...artifact, appProperties: { ...artifact.appProperties, easylabContentSha256: '2'.repeat(64) } }] }, 'invalid-artifact-identity'],
    [{ managedFiles: [{ ...artifact, appProperties: { ...artifact.appProperties, secret: 'foreign' } }] }, 'invalid-drive-properties'],
  ]) expectCode(() => assertSafeRemoteValidationWorkspace({ ...base, ...change }), code)
})

test('public evidence is boolean-only and contains no run or remote identity', () => {
  const evidence = publicValidationEvidence({ plan, outcome: 'passed', checks: { forbiddenAccountExcluded: true, remoteInventorySafe: true, productionWritesRemainDisabled: true }, testResults: { liveDriveV2RoundTripPassed: true } })
  const encoded = JSON.stringify(evidence)
  for (const privateValue of [plan.runId, plan.workspaceId, plan.containerFolderName, plan.sourceCommit, 'email', 'fileId', 'folderId', 'token']) assert.equal(encoded.includes(privateValue), false)
  expectCode(() => publicValidationEvidence({ plan, outcome: 'passed', checks: { accountEmail: true } }), 'invalid-evidence')
  expectCode(() => publicValidationEvidence({ plan, outcome: 'passed', checks: { cleanWorktree: 'yes' } }), 'invalid-evidence')
})

test('launcher performs local authorization before future worker import and has no delete path', () => {
  const source = fs.readFileSync(new URL('./drive-v2-live-validation.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /EASYLAB_DRIVE_V1/)
  assert.match(source, /EASYLAB_DRIVE_V2_LIVE_PLAN_FILE/)
  for (const name of ['authorize', 'execute']) {
    const start = source.indexOf(`async function ${name}`)
    assert.ok(source.indexOf('const context = loadAuthorizedPlan()', start) < source.indexOf("import('./drive-v2-live-validation-worker.mjs')", start))
  }
  assert.doesNotMatch(source, /rmSync|unlinkSync|files\.delete|files\.trash/)
})
