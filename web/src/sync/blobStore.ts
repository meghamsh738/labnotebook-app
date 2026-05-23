import { hashBlobSha256 } from './hashing'
import type { BlobStoreRecord, JournalRepositories } from './repositories'

export type BlobStore = {
  put(key: string, blob: Blob): Promise<BlobStoreRecord>
  get(key: string): Promise<Blob | undefined>
  getRecord(key: string): Promise<BlobStoreRecord | undefined>
  delete(key: string): Promise<void>
  list(): Promise<BlobStoreRecord[]>
  has(key: string): Promise<boolean>
  verify(key: string, expectedSha256?: string): Promise<{ ok: boolean; actualSha256?: string; missing?: boolean }>
}

function nowIso() {
  return new Date().toISOString()
}

export class IndexedDbBlobStore implements BlobStore {
  private readonly repositories: Pick<JournalRepositories, 'blobs'>

  constructor(repositories: Pick<JournalRepositories, 'blobs'>) {
    this.repositories = repositories
  }

  async put(key: string, blob: Blob) {
    const record: BlobStoreRecord = {
      id: key,
      blob,
      sha256: await hashBlobSha256(blob),
      size: blob.size,
      mimeType: blob.type || 'application/octet-stream',
      updatedAt: nowIso(),
    }
    await this.repositories.blobs.put(record)
    return record
  }

  async get(key: string) {
    return (await this.repositories.blobs.get(key))?.blob
  }

  getRecord(key: string) {
    return this.repositories.blobs.get(key)
  }

  delete(key: string) {
    return this.repositories.blobs.delete(key)
  }

  list() {
    return this.repositories.blobs.all()
  }

  async has(key: string) {
    return Boolean(await this.repositories.blobs.get(key))
  }

  async verify(key: string, expectedSha256?: string) {
    const record = await this.repositories.blobs.get(key)
    if (!record) return { ok: false, missing: true }
    const actualSha256 = await hashBlobSha256(record.blob)
    return { ok: expectedSha256 ? actualSha256 === expectedSha256 : actualSha256 === record.sha256, actualSha256 }
  }
}
