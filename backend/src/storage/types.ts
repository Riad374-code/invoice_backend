import type { Readable } from 'node:stream';

export class StorageError extends Error {
  constructor(
    message: string,
    readonly kind: 'NOT_FOUND' | 'UNAVAILABLE',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'StorageError';
  }
}

/** S3-uyğun obyekt anbarı. DB-də yalnız `storage_key` saxlanılır. */
export interface ObjectStorage {
  put(key: string, body: Buffer, opts: { contentType: string; sha256: string }): Promise<void>;
  get(key: string): Promise<Buffer>;
  getStream(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  /** Hazırlıq yoxlaması (bucket əlçatandır). */
  ping(): Promise<void>;
}

/** Content-addressed açar: eyni şirkətdə eyni məzmun həmişə eyni obyektdir (sha256 dedupe). */
export function blobKey(companyId: string, sha256: string): string {
  return `companies/${companyId}/blobs/${sha256.slice(0, 2)}/${sha256}`;
}
