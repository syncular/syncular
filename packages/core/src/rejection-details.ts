/**
 * Bounded host rejection metadata carried by the additive
 * `PUSH_RESULT_DETAILS` companion frame.
 *
 * Every member is deliberately code-like rather than free-form display text.
 * A host opts values into replication by placing them here, so references MUST
 * be non-sensitive identifiers that are safe for the authorized client to
 * persist and render. Diagnostic prose stays in the ordinary `message` field.
 */
export interface RejectionDetails {
  /** Schema/domain paths affected by the rejection. */
  readonly fieldPaths?: readonly string[];
  /** Stable machine reason, for example `outside_schedule_day`. */
  readonly reason?: string;
  /** Stable recovery action, for example `edit_fields`. */
  readonly requiredAction?: string;
  /** Explicitly safe, non-sensitive identifiers needed by recovery UI. */
  readonly references?: Readonly<Record<string, string>>;
}

export const REJECTION_DETAILS_LIMITS = {
  maxEncodedBytes: 4_096,
  maxFieldPaths: 32,
  maxFieldPathLength: 160,
  maxTokenLength: 96,
  maxReferences: 16,
  maxReferenceKeyLength: 64,
  maxReferenceValueBytes: 256,
} as const;

const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TOKEN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function recordOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('rejection details must be an object');
  }
  return value as Record<string, unknown>;
}

function stableToken(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    !TOKEN.test(value)
  ) {
    throw new Error(
      `${label} must be a lowercase stable token of at most ${maxLength} characters`,
    );
  }
  return value;
}

/** Validate, clone, and normalize a host-supplied details object. */
export function normalizeRejectionDetails(value: unknown): RejectionDetails {
  const source = recordOf(value);
  const allowed = new Set([
    'fieldPaths',
    'reason',
    'requiredAction',
    'references',
  ]);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      throw new Error(
        `unknown rejection details member ${JSON.stringify(key)}`,
      );
    }
  }

  const normalized: {
    fieldPaths?: string[];
    reason?: string;
    requiredAction?: string;
    references?: Record<string, string>;
  } = {};

  if (source.fieldPaths !== undefined) {
    if (
      !Array.isArray(source.fieldPaths) ||
      source.fieldPaths.length === 0 ||
      source.fieldPaths.length > REJECTION_DETAILS_LIMITS.maxFieldPaths
    ) {
      throw new Error(
        `fieldPaths must contain 1-${REJECTION_DETAILS_LIMITS.maxFieldPaths} paths`,
      );
    }
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const path of source.fieldPaths) {
      if (
        typeof path !== 'string' ||
        path.length === 0 ||
        path.length > REJECTION_DETAILS_LIMITS.maxFieldPathLength ||
        !FIELD_PATH.test(path)
      ) {
        throw new Error(
          `fieldPaths entries must be schema paths of at most ${REJECTION_DETAILS_LIMITS.maxFieldPathLength} characters`,
        );
      }
      if (seen.has(path))
        throw new Error(`duplicate field path ${JSON.stringify(path)}`);
      seen.add(path);
      paths.push(path);
    }
    normalized.fieldPaths = paths;
  }

  if (source.reason !== undefined) {
    normalized.reason = stableToken(
      source.reason,
      'reason',
      REJECTION_DETAILS_LIMITS.maxTokenLength,
    );
  }
  if (source.requiredAction !== undefined) {
    normalized.requiredAction = stableToken(
      source.requiredAction,
      'requiredAction',
      REJECTION_DETAILS_LIMITS.maxTokenLength,
    );
  }

  if (source.references !== undefined) {
    const references = recordOf(source.references);
    const keys = Object.keys(references).sort();
    if (
      keys.length === 0 ||
      keys.length > REJECTION_DETAILS_LIMITS.maxReferences
    ) {
      throw new Error(
        `references must contain 1-${REJECTION_DETAILS_LIMITS.maxReferences} entries`,
      );
    }
    const safe: Record<string, string> = {};
    for (const key of keys) {
      stableToken(
        key,
        'reference key',
        REJECTION_DETAILS_LIMITS.maxReferenceKeyLength,
      );
      const member = references[key];
      if (
        typeof member !== 'string' ||
        member.length === 0 ||
        new TextEncoder().encode(member).length >
          REJECTION_DETAILS_LIMITS.maxReferenceValueBytes ||
        member.trim() !== member ||
        hasControlCharacter(member)
      ) {
        throw new Error(
          `reference values must be non-empty safe strings of at most ${REJECTION_DETAILS_LIMITS.maxReferenceValueBytes} encoded bytes`,
        );
      }
      safe[key] = member;
    }
    normalized.references = safe;
  }

  if (Object.keys(normalized).length === 0) {
    throw new Error(
      'rejection details must contain at least one supported member',
    );
  }
  const encodedBytes = new TextEncoder().encode(
    JSON.stringify(normalized),
  ).length;
  if (encodedBytes > REJECTION_DETAILS_LIMITS.maxEncodedBytes) {
    throw new Error(
      `rejection details exceed ${REJECTION_DETAILS_LIMITS.maxEncodedBytes} encoded bytes`,
    );
  }
  return normalized;
}
