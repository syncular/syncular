/**
 * @syncular/core - Common Zod schemas
 */

import { z } from 'zod';

// ============================================================================
// Error Response Schemas
// ============================================================================

export const SyncularErrorCategorySchema = z.enum([
  'auth-required',
  'forbidden',
  'conflict',
  'invalid-request',
  'not-found',
  'schema-mismatch',
  'integrity-rejected',
  'rate-limited',
  'transport',
  'storage',
  'blob',
  'server',
  'internal',
]);

export const SyncularErrorRecommendedActionSchema = z.enum([
  'refreshAuth',
  'checkPermissions',
  'fixRequest',
  'resetClientId',
  'splitBatch',
  'retryLater',
  'forceResync',
  'regenerateClient',
  'inspectStorage',
  'inspectServer',
  'resolveConflict',
]);

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  code: z.string().optional(),
  category: SyncularErrorCategorySchema.optional(),
  retryable: z.boolean().optional(),
  recommendedAction: SyncularErrorRecommendedActionSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type SyncularErrorCategory = z.infer<typeof SyncularErrorCategorySchema>;
export type SyncularErrorRecommendedAction = z.infer<
  typeof SyncularErrorRecommendedActionSchema
>;

// ============================================================================
// Pagination Schemas
// ============================================================================

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const PaginatedResponseSchema = <T extends z.ZodTypeAny>(
  itemSchema: T
) =>
  z.object({
    items: z.array(itemSchema),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
  });

export type PaginatedResponse<T> = {
  items: T[];
  total: number;
  offset: number;
  limit: number;
};
