/**
 * The JSON validity rule (SPEC.md Conventions): the one definition of a valid
 * JSON document for envelope `json` fields, push-payload `json` columns and
 * `blob_ref` values. The Rust core (`ssp2::primitives::parse_json_document`)
 * accepts exactly the same documents.
 */
import { DecodeError } from './errors';

const MAX_DEPTH = 64;

/**
 * Parse `raw` as a JSON document under the validity rule, which is defined on
 * the raw text: RFC 8259, at most 64 nested containers anywhere in the text,
 * every number token a finite binary64, no U+0000 and no unpaired surrogate in
 * any string token (key or value), written literally or as a `\u` escape.
 * `JSON.parse` drops values shadowed by a duplicate key, so one lexical pass
 * over the text checks what the parser cannot see. A violation throws
 * `DecodeError` (`sync.invalid_request`); `what` names the field in the
 * message.
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
  let depth = 0;
  for (const [token] of raw.matchAll(
    /"(?:[^"\\]|\\.)*"|[[{\]}]|-?\d[\d.eE+-]*/g,
  )) {
    const head = token[0];
    if (head === '[' || head === '{') {
      if (++depth > MAX_DEPTH) {
        throw new DecodeError(
          'sync.invalid_request',
          `${what} nests deeper than ${MAX_DEPTH} containers`,
        );
      }
    } else if (head === ']' || head === '}') {
      depth--;
    } else if (head === '"') {
      // In `u` mode `\p{Cs}` matches only a surrogate outside a pair.
      const text: string = token.includes('\\') ? JSON.parse(token) : token;
      if (text.includes('\u0000') || /\p{Cs}/u.test(text)) {
        throw new DecodeError(
          'sync.invalid_request',
          `${what} holds a string with U+0000 or an unpaired surrogate`,
        );
      }
    } else if (!Number.isFinite(Number(token))) {
      throw new DecodeError(
        'sync.invalid_request',
        `${what} holds a number outside finite binary64`,
      );
    }
  }
  return value;
}
