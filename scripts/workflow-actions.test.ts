import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const REQUIRED_MAJORS = new Map([
  ['actions/checkout', 6],
  ['actions/setup-node', 6],
  ['actions/setup-java', 5],
]);

test('workflows avoid deprecated Node action runtimes', async () => {
  const workflowDirectory = join(import.meta.dir, '..', '.github', 'workflows');
  const files = (await readdir(workflowDirectory)).filter((name) =>
    /\.ya?ml$/u.test(name),
  );
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
