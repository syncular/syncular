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

// Mutable tags and branches on third-party actions let their maintainers (or
// an attacker with push access to the action repo) inject code into our
// runners — including the privileged OIDC publish path. First-party
// `actions/*` references may float on major tags; everything else must be
// pinned to a full commit SHA (with a trailing `# vX.Y.Z` comment naming the
// release the SHA was resolved from).
test('third-party actions are pinned to full commit SHAs', async () => {
  const files = await workflowFiles();
  const violations: string[] = [];

  for (const file of files) {
    const contents = await readFile(join(workflowDirectory, file), 'utf8');
    for (const match of contents.matchAll(/uses:\s+([\w./-]+)@([^\s#]+)/gu)) {
      const action = match[1];
      const ref = match[2];
      if (action === undefined || ref === undefined) continue;
      if (action.startsWith('actions/') || action.startsWith('./')) continue;
      if (!/^[0-9a-f]{40}$/u.test(ref)) {
        violations.push(
          `${file}: ${action}@${ref} must be pinned to a 40-char commit SHA`,
        );
      }
    }
  }

  expect(violations).toEqual([]);
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
