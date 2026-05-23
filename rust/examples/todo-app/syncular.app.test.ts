import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { syncularCodegenConfig } from './syncular.app';

describe('todo app Syncular authoring contract', () => {
  it('serializes to the checked-in low-level codegen config', () => {
    const expected = JSON.parse(
      readFileSync(new URL('./syncular.codegen.json', import.meta.url), 'utf8')
    );

    expect(syncularCodegenConfig).toEqual(expected);
  });
});
