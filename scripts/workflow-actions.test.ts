import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const REQUIRED_MAJORS = new Map([
  ['actions/checkout', 6],
  ['actions/setup-node', 6],
  ['actions/setup-java', 5],
]);

const workflowDirectory = join(import.meta.dir, '..', '.github', 'workflows');

async function workflowFiles(): Promise<string[]> {
  return (await readdir(workflowDirectory)).filter((name) =>
    /\.ya?ml$/u.test(name),
  );
}

test('workflows avoid deprecated Node action runtimes', async () => {
  const files = await workflowFiles();
  const violations: string[] = [];

  for (const file of files) {
    const contents = await readFile(join(workflowDirectory, file), 'utf8');
    if (contents.includes('cloudflare/wrangler-action@')) {
      violations.push(
        `${file}: cloudflare/wrangler-action embeds a deprecated Node runtime; use the pinned Wrangler CLI`,
      );
    }
    for (const match of contents.matchAll(
      /uses:\s+(actions\/[\w-]+)@v(\d+)/gu,
    )) {
      const action = match[1];
      const actual = Number(match[2]);
      const required =
        action === undefined ? undefined : REQUIRED_MAJORS.get(action);
      if (required !== undefined && actual < required) {
        violations.push(`${file}: ${action}@v${actual} < v${required}`);
      }
    }
  }

  expect(violations).toEqual([]);
});

// Extract every `uses:` reference, tolerating unquoted, single-quoted, and
// double-quoted values, and flag any that is not immutably pinned. A prior
// version anchored on `[\w./-]+@`, so a quoted ref (`uses: "foo/bar@v2"`) or a
// `docker://` image never matched the pattern and slipped through as if
// pinned.
export function unpinnedThirdPartyRefs(contents: string): string[] {
  const problems: string[] = [];
  for (const match of contents.matchAll(/uses:\s*(['"]?)([^'"\s#]+)\1/gu)) {
    const value = match[2];
    if (value === undefined) continue;
    // Container actions pin by image digest, never by a floating tag.
    if (value.startsWith('docker://')) {
      if (!/@sha256:[0-9a-f]{64}$/u.test(value)) {
        problems.push(
          `${value} must be pinned to an image digest (docker://…@sha256:…)`,
        );
      }
      continue;
    }
    const at = value.lastIndexOf('@');
    if (at === -1) {
      // A local composite action (`./…`) carries no ref; anything else that
      // omits `@ref` is not pinned to anything.
      if (!value.startsWith('./')) {
        problems.push(`${value} must pin a ref (owner/repo@<40-char SHA>)`);
      }
      continue;
    }
    const action = value.slice(0, at);
    const ref = value.slice(at + 1);
    // First-party `actions/*` and local `./*` references may float.
    if (action.startsWith('actions/') || action.startsWith('./')) continue;
    if (!/^[0-9a-f]{40}$/u.test(ref)) {
      problems.push(`${action}@${ref} must be pinned to a 40-char commit SHA`);
    }
  }
  return problems;
}

// Mutable tags and branches on third-party actions let their maintainers (or
// an attacker with push access to the action repo) inject code into our
// runners — including the privileged OIDC publish path. First-party
// `actions/*` references may float on major tags; everything else must be
// pinned to a full commit SHA (with a trailing `# vX.Y.Z` comment naming the
// release the SHA was resolved from), and container actions to an image digest.
test('third-party actions are pinned to full commit SHAs', async () => {
  const files = await workflowFiles();
  const violations: string[] = [];

  for (const file of files) {
    const contents = await readFile(join(workflowDirectory, file), 'utf8');
    for (const problem of unpinnedThirdPartyRefs(contents)) {
      violations.push(`${file}: ${problem}`);
    }
  }

  expect(violations).toEqual([]);
});

test('the pin check resists quoting and docker:// evasion', () => {
  // First-party floats and local refs stay allowed, in every quoting style.
  expect(unpinnedThirdPartyRefs('      - uses: actions/checkout@v6')).toEqual(
    [],
  );
  expect(unpinnedThirdPartyRefs('      - uses: "actions/checkout@v6"')).toEqual(
    [],
  );
  expect(
    unpinnedThirdPartyRefs('      - uses: ./.github/actions/setup'),
  ).toEqual([]);
  // A quoted SHA-pinned third-party ref passes.
  const sha = 'a'.repeat(40);
  expect(
    unpinnedThirdPartyRefs(`      - uses: "oven-sh/setup-bun@${sha}"`),
  ).toEqual([]);
  expect(
    unpinnedThirdPartyRefs(`      - uses: 'oven-sh/setup-bun@${sha}' # v2.2.0`),
  ).toEqual([]);
  // A digest-pinned container action passes; a tagged one does not.
  expect(
    unpinnedThirdPartyRefs(
      `      - uses: docker://alpine@sha256:${'b'.repeat(64)}`,
    ),
  ).toEqual([]);
  // Quoted mutable refs are now caught rather than silently skipped.
  expect(unpinnedThirdPartyRefs('      - uses: "evil/action@v2"')).toHaveLength(
    1,
  );
  expect(
    unpinnedThirdPartyRefs("      - uses: 'evil/action@main'"),
  ).toHaveLength(1);
  // A bare (unquoted) mutable third-party tag stays caught.
  expect(unpinnedThirdPartyRefs('      - uses: evil/action@v2')).toHaveLength(
    1,
  );
  // Tag- and latest-pinned container images do not pass as pinned.
  expect(
    unpinnedThirdPartyRefs('      - uses: docker://alpine:latest'),
  ).toHaveLength(1);
  expect(
    unpinnedThirdPartyRefs('      - uses: "docker://ghcr.io/foo/bar:1.2.3"'),
  ).toHaveLength(1);
});

// The workflow-level permissions block in release.yml applies to every job,
// including the docs/demo deploy jobs that run third-party build tooling.
// `id-token: write` (npm/crates trusted publishing) must therefore be granted
// per job, on the publish jobs only.
test('release.yml scopes id-token to individual jobs', async () => {
  const contents = await readFile(
    join(workflowDirectory, 'release.yml'),
    'utf8',
  );
  const jobsIndex = contents.search(/^jobs:/mu);
  expect(jobsIndex).toBeGreaterThan(0);
  const workflowLevel = contents
    .slice(0, jobsIndex)
    .split('\n')
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n');
  expect(workflowLevel).not.toContain('id-token');
});
