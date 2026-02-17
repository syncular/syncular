/**
 * @syncular/core - Blob Zod schemas
 *
 * Runtime validation schemas for blob types.
 */

import { z } from 'zod';

// ============================================================================
// Blob Reference Schema
// ============================================================================

export const BlobRefSchema = z.object({
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/i, 'Invalid blob hash format'),
  size: z.number().int().min(0),
  mimeType: z.string().min(1),
  encrypted: z.boolean().optional(),
  keyId: z.string().optional(),
});

export type BlobRef = z.infer<typeof BlobRefSchema>;

// ============================================================================
// Blob Metadata Schema
// ============================================================================

export const BlobMetadataSchema = z.object({
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
  size: z.number().int().min(0),
  mimeType: z.string().min(1),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  uploadComplete: z.boolean(),
});

export type BlobMetadata = z.infer<typeof BlobMetadataSchema>;

// ============================================================================
// Upload Request/Response Schemas
// ============================================================================

export const BlobUploadInitRequestSchema = z.object({
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/i, 'Invalid blob hash format'),
  size: z.number().int().min(0),
  mimeType: z.string().min(1),
});

export type BlobUploadInitRequest = z.infer<typeof BlobUploadInitRequestSchema>;

export const BlobUploadInitResponseSchema = z.object({
  exists: z.boolean(),
  uploadId: z.string().optional(),
  uploadUrl: z.string().url().optional(),
  uploadMethod: z.enum(['PUT', 'POST']).optional(),
  uploadHeaders: z.record(z.string(), z.string()).optional(),
  chunkSize: z.number().int().optional(),
});

export type BlobUploadInitResponse = z.infer<
  typeof BlobUploadInitResponseSchema
>;

export const BlobUploadCompleteRequestSchema = z.object({
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
});

export type BlobUploadCompleteRequest = z.infer<
  typeof BlobUploadCompleteRequestSchema
>;

export const BlobUploadCompleteResponseSchema = z.object({
  ok: z.boolean(),
  metadata: BlobMetadataSchema.optional(),
  error: z.string().optional(),
});

export type BlobUploadCompleteResponse = z.infer<
  typeof BlobUploadCompleteResponseSchema
>;

// ============================================================================
// Download URL Request/Response Schemas
// ============================================================================

export const BlobDownloadUrlRequestSchema = z.object({
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
});

export type BlobDownloadUrlRequest = z.infer<
  typeof BlobDownloadUrlRequestSchema
>;

export const BlobDownloadUrlResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string(),
  metadata: BlobMetadataSchema,
});

export type BlobDownloadUrlResponse = z.infer<
  typeof BlobDownloadUrlResponseSchema
>;
