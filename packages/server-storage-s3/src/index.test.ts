import { describe, expect, test } from 'bun:test';
import {
  createS3BlobStorageAdapter,
  type GetSignedUrlFn,
  type S3ClientLike,
  type S3Commands,
} from './index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_BUCKET = 'test-bucket';
const TEST_HASH =
  'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
const TEST_HEX =
  'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

/** Compute the expected base64 of a hex hash (used in checksum headers). */
function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

// ---------------------------------------------------------------------------
// Tag types so the mock client can identify which command was sent
// ---------------------------------------------------------------------------

const PUT_TAG = Symbol('PutObjectCommand');
const GET_TAG = Symbol('GetObjectCommand');
const HEAD_TAG = Symbol('HeadObjectCommand');
const DELETE_TAG = Symbol('DeleteObjectCommand');

interface MockCommand {
  __tag: symbol;
  input: Record<string, unknown>;
}

function createMockCommands(): S3Commands {
  return {
    PutObjectCommand: class {
      __tag = PUT_TAG;
      input: Record<string, unknown>;
      constructor(input: Record<string, unknown>) {
        this.input = input;
      }
    } as unknown as S3Commands['PutObjectCommand'],

    GetObjectCommand: class {
      __tag = GET_TAG;
      input: Record<string, unknown>;
      constructor(input: Record<string, unknown>) {
        this.input = input;
      }
    } as unknown as S3Commands['GetObjectCommand'],

    HeadObjectCommand: class {
      __tag = HEAD_TAG;
      input: Record<string, unknown>;
      constructor(input: Record<string, unknown>) {
        this.input = input;
      }
    } as unknown as S3Commands['HeadObjectCommand'],

    DeleteObjectCommand: class {
      __tag = DELETE_TAG;
      input: Record<string, unknown>;
      constructor(input: Record<string, unknown>) {
        this.input = input;
      }
    } as unknown as S3Commands['DeleteObjectCommand'],
  };
}

// ---------------------------------------------------------------------------
// Mock S3 client
// ---------------------------------------------------------------------------

interface SendCall {
  tag: symbol;
  input: Record<string, unknown>;
}

function createMockS3Client(options?: {
  /** Value returned by send(). Can be a function of the command tag. */
  response?:
    | Record<string, unknown>
    | ((tag: symbol) => Record<string, unknown>);
  /** When true, send() rejects with a NotFound-style error. */
  notFound?: boolean;
}) {
  const calls: SendCall[] = [];

  const client: S3ClientLike = {
    async send(command: unknown) {
      const cmd = command as MockCommand;
      calls.push({ tag: cmd.__tag, input: cmd.input });

      if (options?.notFound) {
        const err = new Error('NotFound') as Error & {
          name: string;
          $metadata: { httpStatusCode: number };
        };
        err.name = 'NotFound';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }

      if (typeof options?.response === 'function') {
        return options.response(cmd.__tag);
      }
      return options?.response ?? {};
    },
  };

  return { client, calls };
}

// ---------------------------------------------------------------------------
// Mock getSignedUrl
// ---------------------------------------------------------------------------

interface SignedUrlCall {
  command: MockCommand;
  options: { expiresIn: number };
}

function createMockGetSignedUrl(): {
  fn: GetSignedUrlFn;
  calls: SignedUrlCall[];
} {
  const calls: SignedUrlCall[] = [];
  const fn: GetSignedUrlFn = async (_client, command, options) => {
    const cmd = command as MockCommand;
    calls.push({ command: cmd, options });
    return `https://s3.example.com/presigned/${cmd.input.Key as string}`;
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createS3BlobStorageAdapter', () => {
  // ---- signUpload ----
  describe('signUpload', () => {
    test('returns presigned URL with correct method and headers', async () => {
      const commands = createMockCommands();
      const { client } = createMockS3Client();
      const { fn: getSignedUrl, calls: signCalls } = createMockGetSignedUrl();

      const adapter = createS3BlobStorageAdapter({
        client,
        bucket: TEST_BUCKET,
        commands,
        getSignedUrl,
        requireChecksum: false,
      });

      const result = await adapter.signUpload({
        hash: TEST_HASH,
        size: 1024,
        mimeType: 'image/png',
        expiresIn: 300,
      });

      expect(result.method).toBe('PUT');
      expect(result.url).toContain(TEST_HEX);
      expect(result.headers).toBeDefined();
      expect(result.headers!['Content-Type']).toBe('image/png');
      expect(result.headers!['Content-Length']).toBe('1024');
      // No checksum header when requireChecksum=false
      expect(result.headers!['x-amz-checksum-sha256']).toBeUndefined();

      // Verify the presigner was called with the right expiresIn
      expect(signCalls).toHaveLength(1);
      expect(signCalls[0]!.options.expiresIn).toBe(300);

      // Verify PutObjectCommand was constructed with correct bucket/key
      const cmdInput = signCalls[0]!.command.input;
      expect(cmdInput.Bucket).toBe(TEST_BUCKET);
      expect(cmdInput.Key).toBe(TEST_HEX);
    });

    test('includes checksum header when requireChecksum=true', async () => {
      const commands = createMockCommands();
      const { client } = createMockS3Client();
      const { fn: getSignedUrl } = createMockGetSignedUrl();

      const adapter = createS3BlobStorageAdapter({
        client,
        bucket: TEST_BUCKET,
        commands,
        getSignedUrl,
        requireChecksum: true,
      });

      const result = await adapter.signUpload({
        hash: TEST_HASH,
        size: 512,
        mimeType: 'application/octet-stream',
        expiresIn: 60,
      });

      const expectedBase64 = hexToBase64(TEST_HEX);
      expect(result.headers!['x-amz-checksum-sha256']).toBe(expectedBase64);
    });
  });

  // ---- signDownload ----
  describe('signDownload', () => {
    test('returns presigned URL', async () => {
      const commands = createMockCommands();
      const { client } = createMockS3Client();
      const { fn: getSignedUrl, calls: signCalls } = createMockGetSignedUrl();

      const adapter = createS3BlobStorageAdapter({
        client,
        bucket: TEST_BUCKET,
        commands,
        getSignedUrl,
      });

      const url = await adapter.signDownload({
        hash: TEST_HASH,
        expiresIn: 120,
      });

      expect(url).toContain(TEST_HEX);
      expect(signCalls).toHaveLength(1);
      expect(signCalls[0]!.options.expiresIn).toBe(120);

      // Verify GetObjectCommand was used
      expect(signCalls[0]!.command.__tag).toBe(GET_TAG);
      expect(signCalls[0]!.command.input.Bucket).toBe(TEST_BUCKET);
      expect(signCalls[0]!.command.input.Key).toBe(TEST_HEX);
    });
  });

  // ---- exists ----
  describe('exists', () => {
    test('returns true when HeadObject succeeds', async () => {
      const commands = createMockCommands();
      const { client } = createMockS3Client();
      const { fn: getSignedUrl } = createMockGetSignedUrl();

      const adapter = createS3BlobStorageAdapter({
        client,
        bucket: TEST_BUCKET,
        commands,
        getSignedUrl,
      });

      expect(await adapter.exists(TEST_HASH)).toBe(true);
    });

    test('returns false on NotFound error', async () => {
      const commands = createMockCommands();
      const { client } = createMockS3Client({ notFound: true });
      const { fn: getSignedUrl } = createMockGetSignedUrl();

      const adapter = createS3BlobStorageAdapter({
        client,
        bucket: TEST_BUCKET,
        commands,
        getSignedUrl,
      });

      expect(await adapter.exists(TEST_HASH)).toBe(false);
    });
  });

  // ---- delete ----
  describe('delete', () => {
    test('calls DeleteObjectCommand with correct bucket and key', async () => {
      const commands = createMockCommands();
      const { client, calls } = createMockS3Client();
      const { fn: getSignedUrl } = createMockGetSignedUrl();

      const adapter = createS3BlobStorageAdapter({
        client,
        bucket: TEST_BUCKET,
        commands,
        getSignedUrl,
      });

      await adapter.delete(TEST_HASH);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.tag).toBe(DELETE_TAG);
      expect(calls[0]!.input.Bucket).toBe(TEST_BUCKET);
      expect(calls[0]!.input.Key).toBe(TEST_HEX);
    });
  });

  // ---- getMetadata ----
  describe('getMetadata', () => {
    test('returns size and mimeType from HeadObject', async () => {
      const commands = createMockCommands();
      const { client } = createMockS3Client({
        response: { ContentLength: 2048, ContentType: 'image/jpeg' },
      });
      const { fn: getSignedUrl } = createMockGetSignedUrl();

      const adapter = createS3BlobStorageAdapter({
        client,
        bucket: TEST_BUCKET,
        commands,
        getSignedUrl,
      });

      const meta = await adapter.getMetadata!(TEST_HASH);
      expect(meta).toEqual({ size: 2048, mimeType: 'image/jpeg' });
    });

    test('returns null on NotFound', async () => {
      const commands = createMockCommands();
      const { client } = createMockS3Client({ notFound: true });
      const { fn: getSignedUrl } = createMockGetSignedUrl();

      const adapter = createS3BlobStorageAdapter({
        client,
        bucket: TEST_BUCKET,
        commands,
        getSignedUrl,
      });

      const meta = await adapter.getMetadata!(TEST_HASH);
      expect(meta).toBeNull();
    });
  });

  // ---- put ----
  describe('put', () => {
    test('calls PutObjectCommand with Body and correct key', async () => {
      const commands = createMockCommands();
      const { client, calls } = createMockS3Client();
      const { fn: getSignedUrl } = createMockGetSignedUrl();

      const adapter = createS3BlobStorageAdapter({
        client,
        bucket: TEST_BUCKET,
        commands,
        getSignedUrl,
      });

      const data = new Uint8Array([1, 2, 3, 4]);
      await adapter.put!(TEST_HASH, data);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.tag).toBe(PUT_TAG);
      expect(calls[0]!.input.Bucket).toBe(TEST_BUCKET);
      expect(calls[0]!.input.Key).toBe(TEST_HEX);
      expect(calls[0]!.input.Body).toBe(data);
      expect(calls[0]!.input.ContentLength).toBe(4);
      expect(calls[0]!.input.ContentType).toBe('application/octet-stream');
    });
  });

  // ---- get ----
  describe('get', () => {
    test('returns Uint8Array from transformToByteArray', async () => {
      const expectedBytes = new Uint8Array([10, 20, 30]);
      const commands = createMockCommands();
      const { client } = createMockS3Client({
        response: {
          Body: {
            transformToByteArray: async () => expectedBytes,
          },
        },
      });
      const { fn: getSignedUrl } = createMockGetSignedUrl();

      const adapter = createS3BlobStorageAdapter({
        client,
        bucket: TEST_BUCKET,
        commands,
        getSignedUrl,
      });

      const result = await adapter.get!(TEST_HASH);
      expect(result).toBe(expectedBytes);
    });

    test('returns null on NotFound', async () => {
      const commands = createMockCommands();
      const { client } = createMockS3Client({ notFound: true });
      const { fn: getSignedUrl } = createMockGetSignedUrl();

      const adapter = createS3BlobStorageAdapter({
        client,
        bucket: TEST_BUCKET,
        commands,
        getSignedUrl,
      });

      const result = await adapter.get!(TEST_HASH);
      expect(result).toBeNull();
    });
  });

  // ---- getStream ----
  describe('getStream', () => {
    test('returns ReadableStream from transformToWebStream', async () => {
      const mockStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([5, 6, 7]));
          controller.close();
        },
      });

      const commands = createMockCommands();
      const { client } = createMockS3Client({
        response: {
          Body: {
            transformToWebStream: () => mockStream,
          },
        },
      });
      const { fn: getSignedUrl } = createMockGetSignedUrl();

      const adapter = createS3BlobStorageAdapter({
        client,
        bucket: TEST_BUCKET,
        commands,
        getSignedUrl,
      });

      const result = await adapter.getStream!(TEST_HASH);
      expect(result).toBe(mockStream);
    });

    test('returns null on NotFound', async () => {
      const commands = createMockCommands();
      const { client } = createMockS3Client({ notFound: true });
      const { fn: getSignedUrl } = createMockGetSignedUrl();

      const adapter = createS3BlobStorageAdapter({
        client,
        bucket: TEST_BUCKET,
        commands,
        getSignedUrl,
      });

      const result = await adapter.getStream!(TEST_HASH);
      expect(result).toBeNull();
    });
  });

  // ---- key prefix ----
  describe('key prefix', () => {
    test('prepends keyPrefix to all keys', async () => {
      const commands = createMockCommands();
      const { client, calls } = createMockS3Client();
      const { fn: getSignedUrl, calls: signCalls } = createMockGetSignedUrl();

      const adapter = createS3BlobStorageAdapter({
        client,
        bucket: TEST_BUCKET,
        keyPrefix: 'blobs/',
        commands,
        getSignedUrl,
      });

      // exists -> HeadObjectCommand
      await adapter.exists(TEST_HASH);
      expect(calls[0]!.input.Key).toBe(`blobs/${TEST_HEX}`);

      // delete -> DeleteObjectCommand
      await adapter.delete(TEST_HASH);
      expect(calls[1]!.input.Key).toBe(`blobs/${TEST_HEX}`);

      // signUpload -> PutObjectCommand via presigner
      await adapter.signUpload({
        hash: TEST_HASH,
        size: 100,
        mimeType: 'text/plain',
        expiresIn: 60,
      });
      expect(signCalls[0]!.command.input.Key).toBe(`blobs/${TEST_HEX}`);

      // signDownload -> GetObjectCommand via presigner
      await adapter.signDownload({ hash: TEST_HASH, expiresIn: 60 });
      expect(signCalls[1]!.command.input.Key).toBe(`blobs/${TEST_HEX}`);
    });
  });

  // ---- hash stripping ----
  describe('hash stripping', () => {
    test('strips "sha256:" prefix from hash to form the key', async () => {
      const commands = createMockCommands();
      const { client, calls } = createMockS3Client();
      const { fn: getSignedUrl } = createMockGetSignedUrl();

      const adapter = createS3BlobStorageAdapter({
        client,
        bucket: TEST_BUCKET,
        commands,
        getSignedUrl,
      });

      await adapter.exists('sha256:deadbeef');
      expect(calls[0]!.input.Key).toBe('deadbeef');
    });

    test('leaves hashes without "sha256:" prefix unchanged', async () => {
      const commands = createMockCommands();
      const { client, calls } = createMockS3Client();
      const { fn: getSignedUrl } = createMockGetSignedUrl();

      const adapter = createS3BlobStorageAdapter({
        client,
        bucket: TEST_BUCKET,
        commands,
        getSignedUrl,
      });

      await adapter.exists('deadbeef');
      expect(calls[0]!.input.Key).toBe('deadbeef');
    });
  });
});
