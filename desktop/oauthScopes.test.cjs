const assert = require('node:assert/strict')
const test = require('node:test')
const {
  refreshFailureDecision,
  refreshedAuthorizationDecision,
  refreshedAuthorizationSatisfiesRequest,
} = require('./oauthScopes.cjs')

const requestedScope = 'openid email profile https://www.googleapis.com/auth/drive.file'

test('requires re-consent for a legacy Drive-only refresh grant', () => {
  assert.equal(refreshedAuthorizationSatisfiesRequest({
    requestedScope,
    grantedScope: 'https://www.googleapis.com/auth/drive.file',
    account: undefined,
  }), false)
})

test('accepts a refreshed grant that identifies the account and covers requested scopes', () => {
  assert.equal(refreshedAuthorizationSatisfiesRequest({
    requestedScope,
    grantedScope: 'profile openid https://www.googleapis.com/auth/drive.file email',
    account: { email: 'researcher@example.test' },
  }), true)
})

test('accepts an omitted refreshed scope only when account identity is verifiable', () => {
  assert.equal(refreshedAuthorizationSatisfiesRequest({
    requestedScope,
    account: { email: 'researcher@example.test' },
  }), true)
  assert.equal(refreshedAuthorizationSatisfiesRequest({ requestedScope }), false)
})

test('preserves the refresh token and retries transient refresh failures', () => {
  for (const failure of [
    {},
    { oauthError: 'temporarily_unavailable' },
    { oauthError: 'server_error' },
    { oauthError: 'malformed_response' },
    { oauthError: 'invalid_grant', httpStatus: 500 },
  ]) {
    assert.equal(refreshFailureDecision(failure), 'retry')
  }
})

test('requires re-consent only for a definitive invalid_grant refresh failure', () => {
  assert.equal(refreshFailureDecision({ oauthError: 'invalid_grant', httpStatus: 400 }), 'reconsent')
  assert.equal(refreshFailureDecision({ oauthError: 'invalid_grant' }), 'retry')
  assert.equal(refreshFailureDecision({ oauthError: 'invalid_client', httpStatus: 400 }), 'retry')
})

test('preserves the refresh token when userinfo lookup fails after refresh', () => {
  assert.equal(refreshedAuthorizationDecision({
    requestedScope,
    grantedScope: requestedScope,
    accountLookupStatus: 'failed',
  }), 'retry')
})

test('successful refresh with missing required scopes or unverifiable account requires re-consent', () => {
  assert.equal(refreshedAuthorizationDecision({
    requestedScope,
    grantedScope: 'openid email profile',
    account: { email: 'researcher@example.test' },
    accountLookupStatus: 'verified',
  }), 'reconsent')
  assert.equal(refreshedAuthorizationDecision({
    requestedScope,
    grantedScope: requestedScope,
    accountLookupStatus: 'unverifiable',
  }), 'reconsent')
})
