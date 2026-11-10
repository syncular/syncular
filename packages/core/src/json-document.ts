/**
 * The JSON validity rule (SPEC.md Conventions): the one definition of a valid
 * JSON document for envelope `json` fields, push-payload `json` columns and
 * `blob_ref` values. The Rust core (`ssp2::primitives::parse_json_document`)
 * accepts exactly the same documents.
 */
import { DecodeError } from './errors';

const MAX_DEPTH = 64;

/**
 * Parse `raw` as a JSON document under the validity rule: RFC 8259, at most
 * 64 nested containers, finite numbers only, no U+0000 and no unpaired
 * surrogate in any string or key. A violation throws `DecodeError`
 * (`sync.invalid_request`); `what` names the field in the message.
 */
export function parseJsonDocument(raw: string, what: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DecodeError(
      'sync.invalid_request',
      `${what} does not parse as a JSON document`,
    );
  }
  const visit = (node: unknown, depth: number): void => {
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) {
        throw new DecodeError(
          'sync.invalid_request',
          `${what} holds a number outside finite binary64`,
        );
      }
      return;
    }
    if (typeof node === 'string') {
      // In `u` mode `\p{Cs}` matches only a surrogate outside a pair.
      if (node.includes('\u0000') || /\p{Cs}/u.test(node)) {
        throw new DecodeError(
          'sync.invalid_request',
          `${what} holds a string with U+0000 or an unpaired surrogate`,
        );
      }
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    if (depth === MAX_DEPTH) {
      throw new DecodeError(
        'sync.invalid_request',
        `${what} nests deeper than ${MAX_DEPTH} containers`,
      );
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(node)) {
      visit(key, depth);
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
  return value;
}
