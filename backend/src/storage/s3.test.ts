import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorage } from './memory.js';
import { S3Storage } from './s3.js';
import { StorageError, blobKey } from './types.js';

const s3Mock = mockClient(S3Client);
const storage = new S3Storage({
  region: 'eu-central-1',
  bucket: 'bkt',
  accessKey: 'a',
  secretKey: 's',
  endpoint: 'http://minio:9000',
});
const notFound = () =>
  new S3ServiceException({
    name: 'NotFound',
    $fault: 'client',
    $metadata: { httpStatusCode: 404 },
    message: 'nf',
  });

beforeEach(() => s3Mock.reset());

describe('S3Storage', () => {
  it('uploads with the SHA-256 checksum so S3 verifies integrity', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const body = Buffer.from('hello');
    const sha256 = createHash('sha256').update(body).digest('hex');
    await storage.put('k', body, { contentType: 'text/plain', sha256 });
    const input = s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ Bucket: 'bkt', Key: 'k', ContentType: 'text/plain' });
    expect(input.ChecksumSHA256).toBe(Buffer.from(sha256, 'hex').toString('base64'));
  });

  it('maps a failing PUT to StorageError(UNAVAILABLE)', async () => {
    s3Mock.on(PutObjectCommand).rejects(new Error('connect ECONNREFUSED'));
    await expect(
      storage.put('k', Buffer.from('x'), { contentType: 'a/b', sha256: 'a'.repeat(64) }),
    ).rejects.toMatchObject({
      kind: 'UNAVAILABLE',
    });
  });

  it('reads objects, and maps 404 to NOT_FOUND', async () => {
    s3Mock
      .on(GetObjectCommand)
      .resolves({ Body: Readable.from([Buffer.from('he'), Buffer.from('llo')]) as never });
    expect((await storage.get('k')).toString()).toBe('hello');
    s3Mock.on(GetObjectCommand).rejects(notFound());
    await expect(storage.get('k')).rejects.toMatchObject({ kind: 'NOT_FOUND' });
  });

  it('exists() distinguishes missing objects from outages', async () => {
    s3Mock.on(HeadObjectCommand).resolves({});
    expect(await storage.exists('k')).toBe(true);
    s3Mock.on(HeadObjectCommand).rejects(notFound());
    expect(await storage.exists('k')).toBe(false);
    s3Mock.on(HeadObjectCommand).rejects(new Error('boom'));
    await expect(storage.exists('k')).rejects.toBeInstanceOf(StorageError);
  });

  it('ping() fails when the bucket is unreachable', async () => {
    s3Mock.on(HeadBucketCommand).resolves({});
    await expect(storage.ping()).resolves.toBeUndefined();
    s3Mock.on(HeadBucketCommand).rejects(new Error('denied'));
    await expect(storage.ping()).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
  });
});

describe('MemoryStorage + blobKey', () => {
  it('round-trips and reports missing objects', async () => {
    const m = new MemoryStorage();
    await m.put('a', Buffer.from('x'), { contentType: 't', sha256: 'h' });
    expect((await m.get('a')).toString()).toBe('x');
    expect(await m.exists('a')).toBe(true);
    await expect(m.get('missing')).rejects.toMatchObject({ kind: 'NOT_FOUND' });
  });
  it('blob keys are tenant-scoped and content-addressed', () => {
    const sha = 'ab' + 'c'.repeat(62);
    expect(blobKey('co1', sha)).toBe(`companies/co1/blobs/ab/${sha}`);
    expect(blobKey('co1', sha)).not.toBe(blobKey('co2', sha));
  });
});
