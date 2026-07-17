function scopeSet(value) {
  return new Set(String(value || '').trim().split(/\s+/).filter(Boolean))
}

function refreshedAuthorizationDecision({ requestedScope, grantedScope, account, accountLookupStatus }) {
  if (accountLookupStatus === 'failed') return 'retry'
  if (!account || typeof account.email !== 'string' || !account.email.trim()) return 'reconsent'
  const granted = scopeSet(grantedScope)
  if (granted.size === 0) return 'accept'
  for (const required of scopeSet(requestedScope)) {
    if (!granted.has(required)) return 'reconsent'
  }
  return 'accept'
}

function refreshedAuthorizationSatisfiesRequest(options) {
  return refreshedAuthorizationDecision(options) === 'accept'
}

function refreshFailureDecision({ oauthError, httpStatus } = {}) {
  return oauthError === 'invalid_grant' && httpStatus === 400 ? 'reconsent' : 'retry'
}

module.exports = {
  refreshFailureDecision,
  refreshedAuthorizationDecision,
  refreshedAuthorizationSatisfiesRequest,
}
