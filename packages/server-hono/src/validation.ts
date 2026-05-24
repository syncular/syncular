import {
  createSyncularErrorResponse,
  type SyncularErrorCode,
} from '@syncular/core';
import type { Context } from 'hono';
import { validator as openApiValidator } from 'hono-openapi';

type OpenApiValidatorArgs = Parameters<typeof openApiValidator>;
type ValidationIssue = {
  message?: unknown;
  path?: unknown;
};
type ValidationResult = {
  success: boolean;
  error?: readonly ValidationIssue[];
  target?: unknown;
};

export function createSyncularValidator(
  code: SyncularErrorCode
): typeof openApiValidator {
  return ((...args: OpenApiValidatorArgs) => {
    const [target, schema, hook, options] = args;
    return openApiValidator(
      target,
      schema,
      async (result: ValidationResult, c: Context) => {
        if (!result.success) {
          return c.json(
            createSyncularErrorResponse(code, {
              message: 'Invalid request.',
              details: {
                target: String(result.target ?? target),
                issues: serializeValidationIssues(result.error ?? []),
              },
            }),
            400
          );
        }
        return hook?.(result as never, c as never);
      },
      options
    );
  }) as typeof openApiValidator;
}

export const syncValidator = createSyncularValidator('sync.invalid_request');
export const blobValidator = createSyncularValidator('blob.invalid_request');
export const consoleValidator = createSyncularValidator(
  'console.invalid_request'
);

function serializeValidationIssues(
  issues: readonly ValidationIssue[]
): Array<{ message: string; path?: string[] }> {
  return issues.map((issue) => {
    const path = serializeIssuePath(issue.path);
    return {
      message:
        typeof issue.message === 'string'
          ? issue.message
          : 'Validation failed.',
      ...(path.length > 0 ? { path } : {}),
    };
  });
}

function serializeIssuePath(path: unknown): string[] {
  if (!Array.isArray(path)) return [];
  return path.map((segment) => {
    if (
      segment &&
      typeof segment === 'object' &&
      'key' in segment &&
      typeof segment.key !== 'symbol'
    ) {
      return String(segment.key);
    }
    return String(segment);
  });
}
