import {
  type SyncCombinedResponse,
  SyncCombinedResponseSchema,
  type SyncPullResponse,
  SyncPullResponseSchema,
  type SyncPushResponse,
  SyncPushResponseSchema,
} from '@syncular/core';

interface ParseIssue {
  path: ReadonlyArray<PropertyKey>;
  message: string;
}

type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: ReadonlyArray<ParseIssue> } };

function formatIssue(issue: ParseIssue): string {
  const path =
    issue.path.length > 0
      ? issue.path
          .map((segment) =>
            typeof segment === 'symbol' ? segment.toString() : String(segment)
          )
          .join('.')
      : 'root';
  return `${path}: ${issue.message}`;
}

function formatIssues(issues: ReadonlyArray<ParseIssue>): string {
  return issues.map((issue) => formatIssue(issue)).join('; ');
}

function parseOrThrow<T>(
  label: string,
  value: unknown,
  parse: (input: unknown) => ParseResult<T>
): T {
  const parsed = parse(value);
  if (parsed.success) {
    return parsed.data;
  }

  throw new Error(
    `${label} validation failed: ${formatIssues(parsed.error.issues)}`
  );
}

export function parseSyncCombinedResponse(
  value: unknown
): SyncCombinedResponse {
  return parseOrThrow('SyncCombinedResponse', value, (input) =>
    SyncCombinedResponseSchema.safeParse(input)
  );
}

export function parseSyncPushResponse(value: unknown): SyncPushResponse {
  return parseOrThrow('SyncPushResponse', value, (input) =>
    SyncPushResponseSchema.safeParse(input)
  );
}

export function parseSyncPullResponse(value: unknown): SyncPullResponse {
  return parseOrThrow('SyncPullResponse', value, (input) =>
    SyncPullResponseSchema.safeParse(input)
  );
}

export async function readSyncCombinedResponse(
  response: Response
): Promise<SyncCombinedResponse> {
  return parseSyncCombinedResponse(await response.json());
}

export async function readSyncPushResponse(
  response: Response
): Promise<SyncPushResponse> {
  return parseSyncPushResponse(await response.json());
}

export async function readSyncPullResponse(
  response: Response
): Promise<SyncPullResponse> {
  return parseSyncPullResponse(await response.json());
}
