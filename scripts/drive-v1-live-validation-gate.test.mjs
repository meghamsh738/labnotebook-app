import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import test from 'node:test'
import path from 'node:path'
import {
  DRIVE_FILE_SCOPE,
  LiveValidationGateError,
  MANAGED_ROOT_FOLDERS,
  VALIDATION_APP_PROPERTY,
  assertDriveFileOnlyScope,
  assertEffectiveDriveFileOnlyAccessToken,
  assertLocalLiveAuthorization,
  assertSafeLocalIgnoredPath,
  assertSafeRemoteValidationWorkspace,
  assertSelectedAccountAllowed,
  assertSelectedDriveAccountAllowed,
  assertValidationPlan,
  collectPaginatedDriveFiles,
  createValidationPlan,
  normalizeForbiddenAccountHashes,
  publicValidationEvidence,
} from './drive-v1-live-validation-gate.mjs'

const commit = 'a'.repeat(40)
const root = '/tmp/easylab-live-gate-test'
const plan = createValidationPlan({
  now: new Date('2026-08-08T12:34:56.789Z'),
  randomHex: '0123456789ab',
  sourceCommit: commit,
})
const oauthConfigPath = path.join(root, '.labnote-local', 'oauth.desktop.json')
const tokenCachePath = path.join(root, '.labnote-local', 'drive-v1-live-token.json')
const evidenceDir = path.join(root, plan.evidenceRelativePath)
const env = {
  EASYLAB_DRIVE_V1_LIVE_WRITE_TEST: 'approved',
  EASYLAB_DRIVE_V1_LIVE_MODE: 'debug-test',
  EASYLAB_DRIVE_V1_USER_CONFIRMATION: `approved:${plan.runId}`,
}

test('validation plans are immutable, disposable, drive.file-only, and never auto-delete', () => {
  assert.equal(assertValidationPlan(plan), plan)
  assert.equal(plan.requiredScope, DRIVE_FILE_SCOPE)
  assert.match(plan.rootFolderName, /^Easylab Lab Notebook Safety Validation /)
  assert.equal(plan.autoDeleteValidationFolder, false)
  assert.equal(plan.normalApplicationWritesEnabled, false)

  assert.throws(
    () => assertValidationPlan({ ...plan, rootFolderName: 'Easylab Lab Notebook' }),
    (error) => error instanceof LiveValidationGateError && error.code === 'normal-workspace-refused',
  )
  assert.throws(
    () => assertValidationPlan({ ...plan, requiredScope: 'https://www.googleapis.com/auth/drive' }),
    (error) => error instanceof LiveValidationGateError && error.code === 'invalid-oauth-scope',
  )
  assert.throws(
    () => assertValidationPlan({ ...plan, autoDeleteValidationFolder: true }),
    (error) => error instanceof LiveValidationGateError && error.code === 'automatic-delete-refused',
  )
})

test('live authorization requires all independent gates and ignored exact paths', () => {
  const input = {
    plan,
    env,
    repoRoot: root,
    currentHead: commit,
    gitStatus: '',
    oauthConfigPath,
    tokenCachePath,
    evidenceDir,
    trackedPaths: [],
  }
  assert.deepEqual(assertLocalLiveAuthorization(input), {
    runId: plan.runId,
    rootFolderName: plan.rootFolderName,
    scope: DRIVE_FILE_SCOPE,
    sourceCommit: commit,
  })

  const failures = [
    [{ ...input, env: { ...env, EASYLAB_DRIVE_V1_LIVE_WRITE_TEST: '' } }, 'missing-live-acknowledgement'],
    [{ ...input, env: { ...env, EASYLAB_DRIVE_V1_LIVE_MODE: 'production' } }, 'missing-debug-test-mode'],
    [{ ...input, env: { ...env, EASYLAB_DRIVE_V1_USER_CONFIRMATION: 'approved:another-run' } }, 'missing-user-confirmation'],
    [{ ...input, currentHead: 'b'.repeat(40) }, 'source-commit-changed'],
    [{ ...input, gitStatus: ' M web/src/App.tsx' }, 'dirty-worktree'],
    [{ ...input, oauthConfigPath: '/tmp/oauth.json' }, 'unsafe-credential-path'],
    [{ ...input, evidenceDir: path.join(root, '.labnote-smoke', 'another-run') }, 'unsafe-evidence-path'],
    [{ ...input, trackedPaths: [tokenCachePath] }, 'tracked-private-path'],
  ]
  for (const [value, expectedCode] of failures) {
    assert.throws(
      () => assertLocalLiveAuthorization(value),
      (error) => error instanceof LiveValidationGateError && error.code === expectedCode,
    )
  }
})

test('effective access-token scope is verified as drive.file only', async () => {
  assert.equal(assertDriveFileOnlyScope(DRIVE_FILE_SCOPE), DRIVE_FILE_SCOPE)
  assert.throws(
    () => assertDriveFileOnlyScope(`openid ${DRIVE_FILE_SCOPE}`),
    (error) => error instanceof LiveValidationGateError && error.code === 'invalid-oauth-scope',
  )
  const calls = []
  assert.equal(await assertEffectiveDriveFileOnlyAccessToken('ephemeral-token', async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      json: async () => ({ scope: DRIVE_FILE_SCOPE }),
    }
  }), DRIVE_FILE_SCOPE)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.method, 'GET')
  await assert.rejects(
    () => assertEffectiveDriveFileOnlyAccessToken('ephemeral-token', async () => ({
      ok: true,
      json: async () => ({ scope: `${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive` }),
    })),
    (error) => error instanceof LiveValidationGateError && error.code === 'invalid-oauth-scope',
  )
})

test('selected-account exclusions are mandatory and compare only in-memory SHA-256 identities', async () => {
  const forbiddenHash = '3973d882d7a3499ff02e0ca3910ca05a31e9f1495b6a31546dc030ecf99dc2e1'
  assert.deepEqual(normalizeForbiddenAccountHashes(` ${forbiddenHash},${forbiddenHash} `), [forbiddenHash])
  assert.equal(assertSelectedAccountAllowed('allowed@example.test', [forbiddenHash]), true)
  assert.throws(
    () => assertSelectedAccountAllowed('excluded@example.test', [forbiddenHash]),
    (error) => error instanceof LiveValidationGateError && error.code === 'forbidden-validation-account',
  )
  assert.throws(
    () => normalizeForbiddenAccountHashes('not-a-hash'),
    (error) => error instanceof LiveValidationGateError && error.code === 'invalid-forbidden-account',
  )
  assert.throws(
    () => normalizeForbiddenAccountHashes(''),
    (error) => error instanceof LiveValidationGateError && error.code === 'missing-forbidden-account',
  )
  let identityReadAttempted = false
  await assert.rejects(
    () => assertSelectedDriveAccountAllowed('', async () => {
      identityReadAttempted = true
      return { me: true, emailAddress: 'allowed@example.test' }
    }),
    (error) => error instanceof LiveValidationGateError && error.code === 'missing-forbidden-account',
  )
  assert.equal(identityReadAttempted, false)
  await assert.rejects(
    () => assertSelectedDriveAccountAllowed([forbiddenHash], async () => ({ me: false })),
    (error) => error instanceof LiveValidationGateError && error.code === 'invalid-selected-account',
  )
  await assert.rejects(
    () => assertSelectedDriveAccountAllowed([forbiddenHash], async () => ({
      me: true,
      emailAddress: 'excluded@example.test',
    })),
    (error) => error instanceof LiveValidationGateError && error.code === 'forbidden-validation-account',
  )
  assert.equal(await assertSelectedDriveAccountAllowed([forbiddenHash], async () => ({
    me: true,
    emailAddress: 'allowed@example.test',
  })), true)
})

test('Drive inventory pagination is exhausted and repeated tokens fail closed', async () => {
  const requestedTokens = []
  const files = await collectPaginatedDriveFiles(async (pageToken) => {
    requestedTokens.push(pageToken)
    return pageToken
      ? { files: [{ id: 'second' }] }
      : { files: [{ id: 'first' }], nextPageToken: 'page-2' }
  })
  assert.deepEqual(requestedTokens, [undefined, 'page-2'])
  assert.deepEqual(files.map((file) => file.id), ['first', 'second'])
  await assert.rejects(
    () => collectPaginatedDriveFiles(async () => ({ files: [], nextPageToken: 'repeated' })),
    (error) => error instanceof LiveValidationGateError && error.code === 'invalid-drive-pagination',
  )
})

test('ignored local paths reject tracked, outside, and symbolic-link locations', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easylab-live-path-gate-'))
  try {
    const ignored = path.join(temporaryRoot, '.ignored')
    const realDirectory = path.join(temporaryRoot, 'real')
    const linkedDirectory = path.join(temporaryRoot, 'linked')
    fs.mkdirSync(ignored)
    fs.mkdirSync(realDirectory)
    fs.symlinkSync(realDirectory, linkedDirectory)
    assert.equal(assertSafeLocalIgnoredPath({
      repoRoot: temporaryRoot,
      filePath: path.join(ignored, 'plan.json'),
      label: 'Plan',
      isTracked: () => false,
      isIgnored: () => true,
    }), path.join(ignored, 'plan.json'))
    for (const input of [
      { filePath: path.join(ignored, 'tracked.json'), isTracked: () => true, isIgnored: () => true },
      { filePath: path.join(temporaryRoot, '..', 'outside.json'), isTracked: () => false, isIgnored: () => true },
      { filePath: path.join(linkedDirectory, 'token.json'), isTracked: () => false, isIgnored: () => true },
    ]) {
      assert.throws(
        () => assertSafeLocalIgnoredPath({ repoRoot: temporaryRoot, label: 'Private path', ...input }),
        (error) => error instanceof LiveValidationGateError && error.code === 'unsafe-local-path',
      )
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('live validation operation identities remain memory-only', () => {
  const workerSource = fs.readFileSync(
    new URL('./drive-v1-live-validation-worker.mjs', import.meta.url),
    'utf8',
  )
  const nativeSource = fs.readFileSync(
    new URL('../android/app/src/test/java/com/easylab/labnotebook/sync/DriveV1LiveValidationHarnessTest.kt', import.meta.url),
    'utf8',
  )
  assert.match(workerSource, /MemoryDriveResumableOperationPersistence/)
  assert.doesNotMatch(workerSource, /IndexedDbDriveResumableOperationPersistence/)
  assert.doesNotMatch(workerSource, /EASYLAB_DRIVE_V1_OPERATION_DIRECTORY/)
  assert.match(nativeSource, /MemoryResumableOperationPersistence/)
  assert.doesNotMatch(nativeSource, /FileResumableOperationPersistence/)
  const newTokenCheck = workerSource.indexOf(
    'const forbiddenAccountExcluded = await verifySelectedValidationAccount(String(tokenPayload.access_token))',
  )
  const tokenCacheWrite = workerSource.indexOf('writePrivateJson(tokenCachePath', newTokenCheck)
  const executionStart = workerSource.indexOf('export async function runLiveDriveV1Validation')
  const executionAccountCheck = workerSource.indexOf(
    'const forbiddenAccountExcluded = await verifySelectedValidationAccount(accessToken)',
    executionStart,
  )
  const workspaceProvision = workerSource.indexOf('const workspace = await provisionOrResumeWorkspace', executionStart)
  assert.ok(newTokenCheck >= 0 && tokenCacheWrite > newTokenCheck)
  assert.ok(executionAccountCheck >= executionStart && workspaceProvision > executionAccountCheck)
})

test('remote workspace checks allow only a marked exact validation tree', () => {
  assert.deepEqual(assertSafeRemoteValidationWorkspace({ plan, rootMatches: [] }), { disposition: 'create-new' })

  const marker = { [VALIDATION_APP_PROPERTY]: plan.runId }
  const rootFolder = {
    id: 'redacted-root',
    name: plan.rootFolderName,
    mimeType: 'application/vnd.google-apps.folder',
    trashed: false,
    appProperties: marker,
  }
  const children = MANAGED_ROOT_FOLDERS.map((name) => ({
    id: `redacted-${name}`,
    name,
    mimeType: 'application/vnd.google-apps.folder',
    appProperties: marker,
  }))
  assert.equal(assertSafeRemoteValidationWorkspace({
    plan,
    rootMatches: [rootFolder],
    rootChildren: children,
    managedFolders: [{
      path: 'attachments/2026-08-08',
      mimeType: 'application/vnd.google-apps.folder',
      appProperties: marker,
    }],
    allowedManagedFolderPaths: ['attachments/2026-08-08'],
    managedFiles: [{ path: 'entries/2026-08-08.json', appProperties: marker }],
  }).disposition, 'resume-exact')
  assert.equal(assertSafeRemoteValidationWorkspace({
    plan,
    rootMatches: [rootFolder],
    rootChildren: children,
    managedFiles: [{
      path: 'entries/2026-08-08.json',
      appProperties: { entityType: 'entry', entityId: 'entry-live-validation' },
    }],
    expectedUnmarkedFiles: {
      'entries/2026-08-08.json': { entityType: 'entry', entityId: 'entry-live-validation' },
    },
  }).disposition, 'resume-exact')
  assert.throws(
    () => assertSafeRemoteValidationWorkspace({
      plan,
      rootMatches: [rootFolder],
      rootChildren: children,
      managedFiles: [{ path: 'entries/unplanned.json', appProperties: marker }],
      allowedManagedPaths: ['entries/2026-08-08.json'],
    }),
    (error) => error instanceof LiveValidationGateError && error.code === 'foreign-drive-data',
  )

  assert.throws(
    () => assertSafeRemoteValidationWorkspace({ plan, rootMatches: [rootFolder, rootFolder] }),
    (error) => error instanceof LiveValidationGateError && error.code === 'ambiguous-validation-root',
  )
  assert.throws(
    () => assertSafeRemoteValidationWorkspace({
      plan,
      rootMatches: [rootFolder],
      rootChildren: children,
      managedFolders: [{
        path: 'entries/unplanned',
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: marker,
      }],
      allowedManagedFolderPaths: ['attachments/2026-08-08'],
    }),
    (error) => error instanceof LiveValidationGateError && error.code === 'foreign-drive-data',
  )
  assert.throws(
    () => assertSafeRemoteValidationWorkspace({
      plan,
      rootMatches: [rootFolder],
      rootChildren: [{ name: 'personal-data', mimeType: 'text/plain', appProperties: marker }],
    }),
    (error) => error instanceof LiveValidationGateError && error.code === 'foreign-drive-data',
  )
  assert.throws(
    () => assertSafeRemoteValidationWorkspace({
      plan,
      rootMatches: [{ ...rootFolder, appProperties: {} }],
    }),
    (error) => error instanceof LiveValidationGateError && error.code === 'foreign-drive-data',
  )
  assert.throws(
    () => assertSafeRemoteValidationWorkspace({
      plan,
      rootMatches: [rootFolder],
      rootChildren: children,
      managedFolders: [{
        path: 'attachments/foreign',
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: {},
      }],
    }),
    (error) => error instanceof LiveValidationGateError && error.code === 'foreign-drive-data',
  )
  assert.throws(
    () => assertSafeRemoteValidationWorkspace({
      plan,
      rootMatches: [rootFolder],
      rootChildren: children,
      managedFiles: [{
        path: 'entries/2026-08-08.json',
        appProperties: { entityType: 'entry', entityId: 'foreign' },
      }],
      expectedUnmarkedFiles: {
        'entries/2026-08-08.json': { entityType: 'entry', entityId: 'entry-live-validation' },
      },
    }),
    (error) => error instanceof LiveValidationGateError && error.code === 'foreign-drive-data',
  )
})

test('public evidence is allowlisted and cannot contain identifiers, tokens, or content fields', () => {
  const evidence = publicValidationEvidence({
    plan,
    outcome: 'prepared',
    checks: { cleanWorktree: true, userConfirmationPresent: false },
    testResults: { offlineGateTestsPassed: true },
  })
  assert.equal(evidence.rootFolderName, plan.rootFolderName)
  assert.equal(evidence.normalApplicationWritesEnabled, false)
  assert.equal('account' in evidence, false)
  assert.equal('fileId' in evidence, false)
  assert.equal('token' in evidence, false)
  assert.throws(
    () => publicValidationEvidence({ plan, outcome: 'prepared', checks: { fileId: true } }),
    (error) => error instanceof LiveValidationGateError && error.code === 'invalid-evidence',
  )
})
