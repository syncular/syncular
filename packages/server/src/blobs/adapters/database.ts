/**
 * Database blob storage adapter.
 *
 * Stores blobs directly in the database. Useful for development and small deployments.
 * Since there's no external service, this adapter generates signed tokens that allow
 * uploads/downloads through the server's blob routes.
 */

import type {
  BlobSignDownloadOptions,
  BlobSignedUpload,
  BlobSignUploadOptions,
  BlobStorageAdapter,
} from '@syncular/core';
import { type Kysely, sql } from 'kysely';
import type { SyncBlobsDb } from '../types';

/**
 * Token signer interface for creating/verifying upload/download tokens.
 */
export interface BlobTokenSigner {
  /**
   * Sign a token for blob upload/download authorization.
   * @param payload The data to sign
   * @param expiresIn Expiration time in seconds
   * @returns A signed token string
   */
  sign(
    payload: { hash: string; action: 'upload' | 'download'; expiresAt: number },
    expiresIn: number
  ): Promise<string>;

  /**
   * Verify and decode a signed token.
   * @returns The payload if valid, null if invalid/expired
   */
  verify(token: string): Promise<{
    hash: string;
    action: 'upload' | 'download';
    expiresAt: number;
  } | null>;
}

/**
 * Create a simple HMAC-based token signer.
 */
export function createHmacTokenSigner(secret: string): BlobTokenSigner {
  const encoder = new TextEncoder();
  const keyPromise = crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );

  async function hmacSign(data: string): Promise<string> {
    const key = await keyPromise;
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(data)
    );
    return bufferToHex(new Uint8Array(signature));
  }

  async function hmacVerify(
    data: string,
    signatureHex: string
  ): Promise<boolean> {
    const parsedSignature = hexToBuffer(signatureHex);
    if (!parsedSignature) return false;
    const signature = new Uint8Array(parsedSignature.length);
    signature.set(parsedSignature);
    const key = await keyPromise;
    return crypto.subtle.verify('HMAC', key, signature, encoder.encode(data));
  }

  return {
    async sign(payload, _expiresIn) {
      const data = JSON.stringify(payload);
      const dataB64 = btoa(data);
      const sig = await hmacSign(dataB64);
      return `${dataB64}.${sig}`;
    },

    async verify(token) {
      const [dataB64, sig] = token.split('.');
      if (!dataB64 || !sig) return null;

      const isValidSig = await hmacVerify(dataB64, sig);
      if (!isValidSig) return null;

      try {
        const data = JSON.parse(atob(dataB64)) as {
          hash: string;
          action: 'upload' | 'download';
          expiresAt: number;
        };

        if (Date.now() > data.expiresAt) return null;

        return data;
      } catch {
        return null;
      }
    },
  };
}

function bufferToHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuffer(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-f]+$/i.test(hex)) return null;

  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const pair = hex.slice(i, i + 2);
    out[i / 2] = Number.parseInt(pair, 16);
  }
  return out;
}

export interface DatabaseBlobStorageAdapterOptions<
  DB extends SyncBlobsDb = SyncBlobsDb,
> {
  /** Kysely database instance */
  db: Kysely<DB>;
  /** Base URL for the blob routes (e.g., "https://api.example.com/api/sync") */
  baseUrl: string;
  /** Token signer for authorization */
  tokenSigner: BlobTokenSigner;
}

/**
 * Create a database blob storage adapter.
 *
 * This adapter stores blobs directly in the database and generates signed URLs
 * that point back to the server for upload/download.
 *
 * @example
 * ```typescript
 * const adapter = createDatabaseBlobStorageAdapter({
 *   db: kysely,
 *   baseUrl: 'https://api.example.com/api/sync',
 *   tokenSigner: createHmacTokenSigner(process.env.BLOB_SECRET),
 * });
 * ```
 */
export function createDatabaseBlobStorageAdapter<DB extends SyncBlobsDb>(
  options: DatabaseBlobStorageAdapterOptions<DB>
): BlobStorageAdapter {
  const { db, baseUrl, tokenSigner } = options;

  // Normalize base URL (remove trailing slash)
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');

  return {
    name: 'database',

    async signUpload(opts: BlobSignUploadOptions): Promise<BlobSignedUpload> {
      const expiresAt = Date.now() + opts.expiresIn * 1000;
      const token = await tokenSigner.sign(
        { hash: opts.hash, action: 'upload', expiresAt },
        opts.expiresIn
      );

      // URL points to server's blob upload endpoint
      const url = `${normalizedBaseUrl}/blobs/${encodeURIComponent(opts.hash)}/upload?token=${encodeURIComponent(token)}`;

      return {
        url,
        method: 'PUT',
        headers: {
          'Content-Type': opts.mimeType,
          'Content-Length': String(opts.size),
        },
      };
    },

    async signDownload(opts: BlobSignDownloadOptions): Promise<string> {
      const expiresAt = Date.now() + opts.expiresIn * 1000;
      const token = await tokenSigner.sign(
        { hash: opts.hash, action: 'download', expiresAt },
        opts.expiresIn
      );

      return `${normalizedBaseUrl}/blobs/${encodeURIComponent(opts.hash)}/download?token=${encodeURIComponent(token)}`;
    },

    async exists(hash: string): Promise<boolean> {
      const rowResult = await sql<{ hash: string }>`
        select hash
        from ${sql.table('sync_blobs')}
        where hash = ${hash}
        limit 1
      `.execute(db);
      return rowResult.rows.length > 0;
    },

    async delete(hash: string): Promise<void> {
      await sql`
        delete from ${sql.table('sync_blobs')}
        where hash = ${hash}
      `.execute(db);
    },

    async getMetadata(
      hash: string
    ): Promise<{ size: number; mimeType?: string } | null> {
      const rowResult = await sql<{ size: number; mime_type: string }>`
        select size, mime_type
        from ${sql.table('sync_blobs')}
        where hash = ${hash}
        limit 1
      `.execute(db);
      const row = rowResult.rows[0];

      if (!row) return null;

      return {
        size: row.size,
        mimeType: row.mime_type,
      };
    },

    async put(
      hash: string,
      data: Uint8Array,
      metadata?: Record<string, unknown>
    ): Promise<void> {
      const mimeType =
        typeof metadata?.mimeType === 'string'
          ? metadata.mimeType
          : 'application/octet-stream';
      await storeBlobInDatabase(db, {
        hash,
        size: data.length,
        mimeType,
        body: data,
      });
    },

    async get(hash: string): Promise<Uint8Array | null> {
      const result = await readBlobFromDatabase(db, hash);
      return result?.body ?? null;
    },
  };
}

/**
 * Store a blob in the database.
 * Called by the server routes when handling direct uploads.
 */
export async function storeBlobInDatabase<DB extends SyncBlobsDb>(
  db: Kysely<DB>,
  args: {
    hash: string;
    size: number;
    mimeType: string;
    body: Uint8Array;
  }
): Promise<void> {
  await sql`
    insert into ${sql.table('sync_blobs')} (
      hash,
      size,
      mime_type,
      body,
      created_at
    )
    values (
      ${args.hash},
      ${args.size},
      ${args.mimeType},
      ${args.body},
      ${new Date().toISOString()}
    )
    on conflict (hash) do nothing
  `.execute(db);
}

/**
 * Read a blob from the database.
 * Called by the server routes when handling direct downloads.
 */
export async function readBlobFromDatabase<DB extends SyncBlobsDb>(
  db: Kysely<DB>,
  hash: string
): Promise<{ body: Uint8Array; mimeType: string; size: number } | null> {
  const rowResult = await sql<{
    body: Uint8Array;
    mime_type: string;
    size: number;
  }>`
    select body, mime_type, size
    from ${sql.table('sync_blobs')}
    where hash = ${hash}
    limit 1
  `.execute(db);
  const row = rowResult.rows[0];

  if (!row) return null;

  return {
    body: row.body,
    mimeType: row.mime_type,
    size: row.size,
  };
}
