import { Readable } from 'node:stream';
import { StorageError, type ObjectStorage } from './types.js';

/** Proses daxili anbar — testlər və S3-süz lokal dev üçün. Production-da İSTİFADƏ OLUNMUR. */
export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string; sha256: string }>();

  async put(
    key: string,
    body: Buffer,
    opts: { contentType: string; sha256: string },
  ): Promise<void> {
    this.objects.set(key, { body: Buffer.from(body), ...opts });
  }
  async get(key: string): Promise<Buffer> {
    const o = this.objects.get(key);
    if (!o) throw new StorageError(`Object ${key} not found`, 'NOT_FOUND');
    return Buffer.from(o.body);
  }
  async getStream(key: string): Promise<Readable> {
    return Readable.from(await this.get(key));
  }
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
  async ping(): Promise<void> {}
}
