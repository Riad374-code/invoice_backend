import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { StorageError, type ObjectStorage } from './types.js';

export interface S3Options {
  endpoint?: string | undefined;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

const isNotFound = (err: unknown) =>
  err instanceof S3ServiceException &&
  (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata.httpStatusCode === 404);

export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: S3Options, client?: S3Client) {
    this.bucket = opts.bucket;
    this.client =
      client ??
      new S3Client({
        region: opts.region,
        ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        // MinIO və digər on-prem S3 üçün path-style
        forcePathStyle: Boolean(opts.endpoint),
        credentials: { accessKeyId: opts.accessKey, secretAccessKey: opts.secretKey },
      });
  }

  async put(
    key: string,
    body: Buffer,
    opts: { contentType: string; sha256: string },
  ): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: opts.contentType,
          // S3 özü də yoxlayır: yüklənən bayt-lar sha256-ya uyğun deyilsə rədd edir
          ChecksumSHA256: Buffer.from(opts.sha256, 'hex').toString('base64'),
          ServerSideEncryption: undefined,
        }),
      );
    } catch (err) {
      throw new StorageError(`Failed to store object: ${(err as Error).message}`, 'UNAVAILABLE', {
        cause: err,
      });
    }
  }

  async get(key: string): Promise<Buffer> {
    const stream = await this.getStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  }

  async getStream(key: string): Promise<Readable> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) throw new StorageError(`Object ${key} has no body`, 'NOT_FOUND');
      return res.Body as Readable;
    } catch (err) {
      if (err instanceof StorageError) throw err;
      if (isNotFound(err))
        throw new StorageError(`Object ${key} not found`, 'NOT_FOUND', { cause: err });
      throw new StorageError(`Failed to read object: ${(err as Error).message}`, 'UNAVAILABLE', {
        cause: err,
      });
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw new StorageError(`Failed to check object: ${(err as Error).message}`, 'UNAVAILABLE', {
        cause: err,
      });
    }
  }

  async ping(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      throw new StorageError(
        `Bucket "${this.bucket}" is not reachable: ${(err as Error).message}`,
        'UNAVAILABLE',
        {
          cause: err,
        },
      );
    }
  }

  /** Yalnız dev/test: bucket yoxdursa yaradır. Production-da bucket infra tərəfindən yaradılır. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }
}
