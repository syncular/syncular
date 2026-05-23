import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { toSyncularCodegenJson } from '@syncular/typegen';
import { app, syncularCodegenConfig } from './syncular.app';

describe('todo app Syncular authoring contract', () => {
  it('serializes to the checked-in low-level codegen config', () => {
    const expected = JSON.parse(
      readFileSync(new URL('./syncular.codegen.json', import.meta.url), 'utf8')
    );

    expect(syncularCodegenConfig).toEqual(expected);
  });

  it('writes the checked-in codegen handoff JSON from the typed app contract', () => {
    const expected = readFileSync(
      new URL('./syncular.codegen.json', import.meta.url),
      'utf8'
    );

    expect(toSyncularCodegenJson(app)).toBe(expected);
  });
});
