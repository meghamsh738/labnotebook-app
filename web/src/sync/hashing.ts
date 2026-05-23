export function stableStringify(value: unknown): string {
  if (value === null) return 'null'

  const valueType = typeof value
  if (valueType === 'string' || valueType === 'boolean') return JSON.stringify(value)
  if (valueType === 'number') return Number.isFinite(value as number) ? JSON.stringify(value) : 'null'
  if (valueType === 'undefined' || valueType === 'function' || valueType === 'symbol') return 'null'

  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`

  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter((key) => typeof record[key] !== 'undefined').sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

function digestToHex(digest: ArrayBuffer) {
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function hashTextSha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return digestToHex(digest)
}

export async function hashJsonSha256(value: unknown) {
  return hashTextSha256(stableStringify(value))
}

export async function hashBlobSha256(blob: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return digestToHex(digest)
}
