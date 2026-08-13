import { DRIVE_V2_RESUMABLE_THRESHOLD_BYTES } from '../../src/sync/driveV2Graph'
import {
  type DriveV2CreateOnlyClient,
  type DriveV2CreateReceipt,
  DriveV2CreateArtifact,
} from '../../src/sync/driveV2OfflinePrimitives'

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,trashed,version,parents,appProperties'

export type DriveV2LiveFault =
  | 'none'
  | 'lose-response-after-create'
  | 'interrupt-before-resumable-content'

const DEFAULT_RECONCILIATION_DELAYS_MS = Object.freeze([0, 100, 250, 500, 1_000, 2_000])
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export type DriveV2LiveFile = {
  readonly id: string
  readonly name: string
  readonly mimeType?: string
  readonly modifiedTime?: string
  readonly size?: string
  readonly trashed?: boolean
  readonly version?: string
  readonly parents?: readonly string[]
  readonly appProperties?: Readonly<Record<string, string>>
}

export class DriveV2LiveValidationError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DriveV2LiveValidationError'
    this.code = code
  }
}

class DriveV2LiveHttpError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Drive v2 live validation request failed with status ${status}.`)
    this.name = 'DriveV2LiveHttpError'
    this.status = status
  }
}

function fail(code: string, message: string): never {
  throw new DriveV2LiveValidationError(code, message)
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function exactStringMap(left: Readonly<Record<string, string>> | undefined, right: Readonly<Record<string, string>>): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

function positiveVersion(value: string | undefined): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value)
}

function validModifiedTime(value: string | undefined): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Drive v2 validation was cancelled.', 'AbortError')
}

async function boundedDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal)
  if (delayMs === 0) return
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

/**
 * Live Drive adapter used only by the explicitly gated v2 Playwright harness.
 * It has no update or delete operation: every mutation is a pre-generated-id POST.
 */
export class DriveV2LiveValidationClient implements DriveV2CreateOnlyClient {
  readonly #accessToken: string
  readonly #accountScopeId: string
  readonly #fetch: typeof fetch
  readonly #reconciliationDelaysMs: readonly number[]
  readonly #requestTimeoutMs: number
  #fault: DriveV2LiveFault
  #faultTargetPath: string | null = null
  #faultUsed = false

  constructor(options: {
    accessToken: string
    accountScopeId: string
    runId: string
    fetchImpl?: typeof fetch
    reconciliationDelaysMs?: readonly number[]
    requestTimeoutMs?: number
  }) {
    if (!options.accessToken.trim()) fail('missing-access-token', 'The validation client requires a short-lived access token.')
    if (!options.accountScopeId.startsWith('drive-v2-live:')) fail('invalid-account-scope', 'The validation account scope is not isolated.')
    if (!/^[a-z0-9][a-z0-9-]{15,95}$/.test(options.runId)) fail('invalid-run-id', 'The validation run id is invalid.')
    this.#accessToken = options.accessToken
    this.#accountScopeId = options.accountScopeId
    const delays = options.reconciliationDelaysMs ?? DEFAULT_RECONCILIATION_DELAYS_MS
    if (delays.length < 1 || delays.length > 12 || delays.some((delay) => !Number.isInteger(delay) || delay < 0 || delay > 10_000)) {
      fail('invalid-reconciliation-policy', 'The validation reconciliation retry policy is invalid.')
    }
    this.#reconciliationDelaysMs = Object.freeze([...delays])
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) {
      fail('invalid-request-timeout', 'The validation request timeout must be a finite positive duration.')
    }
    this.#requestTimeoutMs = requestTimeoutMs
    this.#fault = 'none'
    this.#fetch = options.fetchImpl ?? fetch.bind(globalThis)
  }

  get faultUsed(): boolean {
    return this.#faultUsed
  }

  setFault(fault: DriveV2LiveFault, targetPath?: string): void {
    if (fault !== 'none' && !targetPath?.trim()) {
      fail('invalid-fault-target', 'A validation-only fault must be pinned to one immutable artifact path.')
    }
    this.#fault = fault
    this.#faultTargetPath = fault === 'none' ? null : targetPath!.trim()
    this.#faultUsed = false
  }

  async generateFileIds(count: number): Promise<readonly string[]> {
    if (!Number.isInteger(count) || count < 1 || count > 100) fail('invalid-generated-id-count', 'Drive id count is invalid.')
    const url = new URL(`${DRIVE_API}/files/generateIds`)
    url.searchParams.set('count', String(count))
    url.searchParams.set('space', 'drive')
    url.searchParams.set('fields', 'ids')
    const payload = await this.jsonRequest<{ ids?: unknown }>(url.toString())
    const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : []
    if (ids.length !== count || ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) {
      fail('invalid-generated-drive-ids', 'Drive did not return the requested unique file ids.')
    }
    return Object.freeze(ids)
  }

  async listChildren(parentId: string, signal?: AbortSignal): Promise<readonly DriveV2LiveFile[]> {
    if (!parentId.trim()) fail('invalid-parent-id', 'Drive parent id is invalid.')
    const files: DriveV2LiveFile[] = []
    const seenTokens = new Set<string>()
    let pageToken = ''
    do {
      const url = new URL(`${DRIVE_API}/files`)
      url.searchParams.set('q', `'${escapeDriveQuery(parentId)}' in parents and trashed = false`)
      url.searchParams.set('spaces', 'drive')
      url.searchParams.set('pageSize', '1000')
      url.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`)
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const payload = await this.jsonRequest<{ files?: DriveV2LiveFile[]; nextPageToken?: string }>(url.toString(), { signal })
      if (!Array.isArray(payload.files)) fail('invalid-drive-pagination', 'Drive returned an invalid inventory page.')
      files.push(...payload.files)
      const next = String(payload.nextPageToken ?? '').trim()
      if (next && seenTokens.has(next)) fail('invalid-drive-pagination', 'Drive repeated an inventory page token.')
      if (next) seenTokens.add(next)
      pageToken = next
    } while (pageToken)
    return Object.freeze(files)
  }

  async downloadBytes(fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
    return this.withRequestDeadline(signal, async (deadlineSignal) => {
      const response = await this.rawRequest(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {
        signal: deadlineSignal,
      })
      return new Uint8Array(await response.arrayBuffer())
    })
  }

  async metadata(fileId: string, signal?: AbortSignal): Promise<DriveV2LiveFile> {
    const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`)
    url.searchParams.set('fields', FILE_FIELDS)
    url.searchParams.set('supportsAllDrives', 'false')
    return this.jsonRequest<DriveV2LiveFile>(url.toString(), {
      headers: { 'Cache-Control': 'no-cache' },
      signal,
    })
  }

  async createOrReconcile(
    accountScopeId: string,
    artifact: DriveV2CreateArtifact,
    signal?: AbortSignal,
  ): Promise<DriveV2CreateReceipt> {
    if (accountScopeId !== this.#accountScopeId) fail('account-switch', 'The validation account changed before creation.')
    if (signal?.aborted) throw signal.reason ?? new DOMException('Drive v2 validation was cancelled.', 'AbortError')
    const name = artifact.path.split('/').at(-1) ?? ''
    if (!name || artifact.parentFolderDriveFileId.trim() === '') fail('invalid-artifact-path', 'The validation artifact path is invalid.')

    const existing = await this.exactOccupants(artifact.parentFolderDriveFileId, name, signal)
    if (existing.length > 0) {
      const receipt = await this.reconcileExact(existing, artifact, signal)
      this.consumeRecoveredTargetFault(artifact)
      return receipt
    }

    let mutationStarted = false
    try {
      mutationStarted = true
      if (artifact.byteCount >= DRIVE_V2_RESUMABLE_THRESHOLD_BYTES) {
        await this.createResumable(artifact, name, signal)
      } else {
        await this.createMultipart(artifact, name, signal)
      }
      if (this.consumeFault('lose-response-after-create', artifact)) {
        throw new TypeError('validation-only simulated lost create response')
      }
    } catch (error) {
      if (!mutationStarted) throw error
      if (signal?.aborted) throw signal.reason ?? error
      try {
        const receipt = await this.verifyExact(artifact, signal)
        this.consumeRecoveredTargetFault(artifact)
        return receipt
      } catch (reconciliationError) {
        if (signal?.aborted) throw signal.reason ?? reconciliationError
        if (reconciliationError instanceof DriveV2LiveValidationError) throw reconciliationError
        throw new DriveV2LiveValidationError(
          'ambiguous-create',
          `Drive v2 creation may have committed but could not be reconciled: ${artifact.path}`,
          { cause: reconciliationError },
        )
      }
    }
    return this.verifyExact(artifact, signal)
  }

  private async exactOccupants(parentId: string, name: string, signal?: AbortSignal): Promise<readonly DriveV2LiveFile[]> {
    return (await this.listChildren(parentId, signal)).filter((file) => file.name === name)
  }

  private async createMultipart(artifact: DriveV2CreateArtifact, name: string, signal?: AbortSignal): Promise<void> {
    if (artifact.resumableOperationId !== null) fail('unexpected-resumable-operation-id', 'Multipart creation included a resumable identity.')
    const metadata = {
      id: artifact.generatedDriveFileId,
      name,
      mimeType: artifact.mimeType,
      parents: [artifact.parentFolderDriveFileId],
      appProperties: artifact.appProperties,
    }
    const boundary = `easylab-v2-${crypto.randomUUID()}`
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: ${artifact.mimeType}\r\n\r\n`,
      artifact.bytes,
      `\r\n--${boundary}--\r\n`,
    ])
    await this.request(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
      signal,
    })
  }

  private async createResumable(artifact: DriveV2CreateArtifact, name: string, signal?: AbortSignal): Promise<void> {
    if (!artifact.resumableOperationId?.trim()) fail('missing-resumable-operation-id', 'Resumable creation requires its immutable operation id.')
    const initiation = await this.request(
      `${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': artifact.mimeType,
          'X-Upload-Content-Length': String(artifact.byteCount),
        },
        body: JSON.stringify({
          id: artifact.generatedDriveFileId,
          name,
          mimeType: artifact.mimeType,
          parents: [artifact.parentFolderDriveFileId],
          appProperties: artifact.appProperties,
        }),
        signal,
      },
    )
    const location = initiation.headers.get('Location')?.trim()
    if (!location) fail('missing-resumable-session', 'Drive did not return a resumable upload session.')
    const sessionUrl = new URL(location)
    if (sessionUrl.protocol !== 'https:' || !sessionUrl.hostname.endsWith('.googleapis.com')) {
      fail('invalid-resumable-session', 'Drive returned a resumable session outside Google APIs.')
    }
    if (this.consumeFault('interrupt-before-resumable-content', artifact)) {
      throw new TypeError('validation-only simulated interrupted resumable upload')
    }
    await this.request(sessionUrl.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': artifact.mimeType },
      body: new Blob([artifact.bytes], { type: artifact.mimeType }),
      signal,
    })
  }

  private async reconcileExact(
    occupants: readonly DriveV2LiveFile[],
    artifact: DriveV2CreateArtifact,
    signal?: AbortSignal,
  ): Promise<DriveV2CreateReceipt> {
    if (occupants.length !== 1 || occupants[0].id !== artifact.generatedDriveFileId) {
      fail('create-precondition-conflict', 'The canonical Drive v2 path is occupied or duplicated.')
    }
    return this.verifyExact(artifact, signal)
  }

  private consumeFault(expected: DriveV2LiveFault, artifact: DriveV2CreateArtifact): boolean {
    const matches = !this.#faultUsed && this.#fault === expected && this.#faultTargetPath === artifact.path
    if (matches) this.#faultUsed = true
    return matches
  }

  private consumeRecoveredTargetFault(artifact: DriveV2CreateArtifact): void {
    if (!this.#faultUsed && this.#fault !== 'none' && this.#faultTargetPath === artifact.path) {
      this.#faultUsed = true
    }
  }

  private metadataMatchesArtifact(file: DriveV2LiveFile, artifact: DriveV2CreateArtifact): boolean {
    const expectedName = artifact.path.split('/').at(-1)!
    return file.id === artifact.generatedDriveFileId
      && file.name === expectedName
      && file.mimeType === artifact.mimeType
      && validModifiedTime(file.modifiedTime)
      && file.trashed !== true
      && file.size === String(artifact.byteCount)
      && JSON.stringify(file.parents ?? []) === JSON.stringify([artifact.parentFolderDriveFileId])
      && exactStringMap(file.appProperties, artifact.appProperties)
      && positiveVersion(file.version)
  }

  private metadataPairIsStable(first: DriveV2LiveFile, second: DriveV2LiveFile): boolean {
    return second.id === first.id
      && second.name === first.name
      && second.mimeType === first.mimeType
      && second.modifiedTime === first.modifiedTime
      && second.version === first.version
      && second.size === first.size
      && JSON.stringify(second.parents ?? []) === JSON.stringify(first.parents ?? [])
      && second.trashed === first.trashed
      && exactStringMap(second.appProperties, first.appProperties ?? {})
  }

  private async verifyExact(artifact: DriveV2CreateArtifact, signal?: AbortSignal): Promise<DriveV2CreateReceipt> {
    let lastNotFound: DriveV2LiveHttpError | undefined
    let sawUnstablePair = false
    for (const delayMs of this.#reconciliationDelaysMs) {
      await boundedDelay(delayMs, signal)
      if (signal?.aborted) throw abortError(signal)
      try {
        const first = await this.metadata(artifact.generatedDriveFileId, signal)
        if (!this.metadataMatchesArtifact(first, artifact)) {
          fail('create-reconciliation-mismatch', 'Drive v2 created metadata does not match the immutable artifact.')
        }
        const downloaded = await this.downloadBytes(first.id, signal)
        if (downloaded.length !== artifact.byteCount || await sha256(downloaded) !== artifact.contentSha256) {
          fail('create-reconciliation-mismatch', 'Drive v2 created bytes do not match the immutable artifact.')
        }
        const second = await this.metadata(artifact.generatedDriveFileId, signal)
        if (!this.metadataMatchesArtifact(second, artifact)) {
          fail('create-reconciliation-mismatch', 'Drive v2 created metadata changed away from its immutable artifact.')
        }
        if (BigInt(second.version!) < BigInt(first.version!) || Date.parse(second.modifiedTime!) < Date.parse(first.modifiedTime!)) {
          fail('create-reconciliation-mismatch', 'Drive v2 server metadata moved backwards during verification.')
        }
        if (!this.metadataPairIsStable(first, second)) {
          sawUnstablePair = true
          continue
        }
        return Object.freeze({
          driveFileId: second.id,
          parentFolderDriveFileId: artifact.parentFolderDriveFileId,
          path: artifact.path,
          canonicalId: artifact.canonicalId,
          contentSha256: artifact.contentSha256,
          mimeType: artifact.mimeType,
          appProperties: artifact.appProperties,
          byteCount: artifact.byteCount,
          trashed: false,
          stableSecondRead: true,
        })
      } catch (error) {
        if (error instanceof DriveV2LiveHttpError && error.status === 404) {
          lastNotFound = error
          continue
        }
        throw error
      }
    }
    if (sawUnstablePair) {
      fail('unstable-verification', 'Drive v2 metadata did not produce two consecutive stable reads within the bounded verification window.')
    }
    throw new DriveV2LiveValidationError(
      'ambiguous-create',
      `Drive v2 generated file id remained unavailable after bounded reconciliation: ${artifact.path}`,
      { cause: lastNotFound },
    )
  }

  private async jsonRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
    return this.withRequestDeadline(init.signal, async (deadlineSignal) => {
      const response = await this.rawRequest(url, { ...init, signal: deadlineSignal })
      return response.json() as Promise<T>
    })
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    return this.withRequestDeadline(init.signal, (deadlineSignal) => this.rawRequest(url, {
      ...init,
      signal: deadlineSignal,
    }))
  }

  private async withRequestDeadline<T>(
    callerSignal: AbortSignal | null | undefined,
    action: (deadlineSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const requestController = new AbortController()
    const forwardAbort = () => requestController.abort(callerSignal?.reason ?? new DOMException('Drive v2 validation was cancelled.', 'AbortError'))
    if (callerSignal?.aborted) forwardAbort()
    else callerSignal?.addEventListener('abort', forwardAbort, { once: true })
    const timer = setTimeout(() => {
      requestController.abort(new DOMException('Drive v2 validation request exceeded its finite deadline.', 'TimeoutError'))
    }, this.#requestTimeoutMs)
    try {
      return await action(requestController.signal)
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', forwardAbort)
    }
  }

  private async rawRequest(url: string, init: RequestInit = {}): Promise<Response> {
    const method = String(init.method ?? 'GET').toUpperCase()
    if (method === 'PATCH' || method === 'DELETE') fail('forbidden-http-method', 'Drive v2 live validation forbids update and delete requests.')
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.#accessToken}`)
    const response = await this.#fetch(url, { ...init, method, headers, redirect: 'error' })
    if (!response.ok) throw new DriveV2LiveHttpError(response.status)
    return response
  }
}
