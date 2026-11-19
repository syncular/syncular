/**
 * Pins the surface tabs share to `MULTI_TAB_PROTOCOL_VERSION` (SPEC §7.1,
 * browser tab identity).
 *
 * A follower forwards `WorkerApi` calls to the leader's core and receives its
 * events, so every type a forwarded call, result, event or tab message carries
 * is part of the protocol. The fingerprint hashes those declarations, without
 * comments and with whitespace collapsed, together with every type they name
 * (transitively, across the client and core sources) and the worker core's
 * forwarded method list. A change to any of them changes the fingerprint.
 * Never repin a fingerprint without bumping the protocol.
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MULTI_TAB_PROTOCOL_VERSION } from '../src/multi-tab';

const PINNED = {
  protocol: 6,
  fingerprint:
    'ea6627aafcde2e8124fbf02f233b8d40e52877a9ca1a71d75f12502b7151b18d',
};

const ROOTS = [
  'WorkerApi',
  'WorkerInitConfig',
  'SyncWorkerEvent',
  'MultiTabMessage',
];

/**
 * The declaration starting at `start`, up to its closing brace (interface) or
 * its `;` (type alias), without comments and with whitespace collapsed.
 */
function declarationAt(
  text: string,
  start: number,
  isInterface: boolean,
): string {
  let out = '';
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      out += ' ';
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i) + 1;
      out += ' ';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const end = text.indexOf(char, i + 1);
      out += text.slice(i, end + 1);
      i = end;
      continue;
    }
    out += char;
    if (char === '{' || char === '(' || char === '[') depth += 1;
    else if (char === '}' || char === ')' || char === ']') {
      depth -= 1;
      if (depth === 0 && isInterface && char === '}') break;
    } else if (char === ';' && depth === 0 && !isInterface) break;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function surfaceFingerprint(): { fingerprint: string; types: string[] } {
  const declarations = new Map<string, string[]>();
  for (const dir of [
    join(import.meta.dir, '../src'),
    join(import.meta.dir, '../../core/src'),
  ]) {
    // Sorted: readdir order is filesystem-specific (APFS sorts, ext4 does not),
    // and a type declared in several files hashes its bodies in file order.
    for (const file of readdirSync(dir, {
      recursive: true,
      encoding: 'utf8',
    }).sort()) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const text = readFileSync(join(dir, file), 'utf8');
      for (const match of text.matchAll(
        /^[ \t]*(?:export\s+)?(interface|type)\s+([A-Za-z_]\w*)/gm,
      )) {
        const kind = match[1]!;
        const name = match[2]!;
        const body = declarationAt(
          text,
          match.index + match[0].indexOf(kind),
          kind === 'interface',
        );
        declarations.set(name, [...(declarations.get(name) ?? []), body]);
      }
    }
  }
  const seen = new Set<string>();
  const pending = [...ROOTS];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    const bodies = declarations.get(name);
    if (bodies === undefined || seen.has(name)) continue;
    seen.add(name);
    for (const body of bodies)
      for (const [reference] of body.matchAll(/\b[A-Z]\w*\b/g))
        pending.push(reference);
  }
  for (const root of ROOTS) expect(seen.has(root)).toBe(true);
  const methods = /const coreMethods = \[[^\]]*\]/.exec(
    readFileSync(join(import.meta.dir, '../src/worker-core.ts'), 'utf8'),
  )?.[0];
  if (methods === undefined)
    throw new Error('worker-core.ts declares no coreMethods list');
  const types = [...seen].sort();
  const hasher = new Bun.CryptoHasher('sha256');
  for (const name of types)
    for (const body of declarations.get(name) ?? []) hasher.update(`${body}\n`);
  hasher.update(methods.replace(/\s+/g, ' '));
  return { fingerprint: hasher.digest('hex'), types };
}

test('the forwarded surface is pinned to MULTI_TAB_PROTOCOL_VERSION', () => {
  const { fingerprint, types } = surfaceFingerprint();
  if (
    MULTI_TAB_PROTOCOL_VERSION !== PINNED.protocol ||
    fingerprint !== PINNED.fingerprint
  ) {
    throw new Error(
      `the multi-tab surface (${types.length} types and the forwarded method list) no longer matches protocol ${PINNED.protocol}. ` +
        `Bump MULTI_TAB_PROTOCOL_VERSION in src/multi-tab.ts to ${PINNED.protocol + 1} and pin ` +
        `{ protocol: ${PINNED.protocol + 1}, fingerprint: '${fingerprint}' } here, so tabs of different builds never serve each other (SPEC §7.1).`,
    );
  }
});
