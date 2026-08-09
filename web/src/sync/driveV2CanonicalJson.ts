export type DriveV2JsonPrimitive = null | boolean | number | string
export type DriveV2JsonValue = DriveV2JsonPrimitive | DriveV2JsonValue[] | { [key: string]: DriveV2JsonValue }
export type DriveV2JsonObject = { [key: string]: DriveV2JsonValue }

export class DriveV2ContractError extends Error {
  readonly code: string

  constructor(code: string, options?: ErrorOptions) {
    super(code, options)
    this.name = 'DriveV2ContractError'
    this.code = code
  }
}

function fail(code: string, cause?: unknown): never {
  throw new DriveV2ContractError(code, cause === undefined ? undefined : { cause })
}

function requireUnicodeScalars(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index)
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('invalid-unicode-scalar')
      index += 1
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      fail('invalid-unicode-scalar')
    }
  }
}

function requireJsonValue(value: unknown): asserts value is DriveV2JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string') requireUnicodeScalars(value)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid-json-number')
    return
  }
  if (Array.isArray(value)) {
    value.forEach(requireJsonValue)
    return
  }
  if (typeof value !== 'object') fail('artifact-schema-mismatch')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail('artifact-schema-mismatch')
  for (const [key, nested] of Object.entries(value)) {
    requireUnicodeScalars(key)
    requireJsonValue(nested)
  }
}

function encodeUnchecked(value: DriveV2JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(encodeUnchecked).join(',')}]`
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${encodeUnchecked(value[key])}`).join(',')}}`
}

export function driveV2CanonicalJson(value: unknown): string {
  requireJsonValue(value)
  return encodeUnchecked(value)
}

export function driveV2CanonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(driveV2CanonicalJson(value))
}

export function driveV2DecodeCanonicalObject(bytes: Uint8Array): DriveV2JsonObject {
  const snapshot = Uint8Array.from(bytes)
  if (snapshot.length >= 3 && snapshot[0] === 0xef && snapshot[1] === 0xbb && snapshot[2] === 0xbf) {
    fail('noncanonical-json-bytes')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot)
  } catch (error) {
    fail('invalid-utf8', error)
  }
  const roundTrip = new TextEncoder().encode(text)
  if (roundTrip.length !== snapshot.length || roundTrip.some((byte, index) => byte !== snapshot[index])) {
    fail('noncanonical-json-bytes')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    fail('malformed-json', error)
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') fail('artifact-schema-mismatch')
  if (driveV2CanonicalJson(parsed) !== text) fail('noncanonical-json-bytes')
  return parsed as DriveV2JsonObject
}

export async function driveV2Sha256(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes)
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function driveV2CanonicalSha256(value: unknown): Promise<string> {
  return driveV2Sha256(driveV2CanonicalBytes(value))
}
