import { describe, expect, test } from 'bun:test';
import {
  isReleaseVersion,
  materializeBunLockWorkspace,
  materializeCargoLock,
  materializeCargoManifest,
} from './version';

describe('root-authoritative release versioning', () => {
  test('accepts full SemVer and rejects ranges or partial versions', () => {
    expect(isReleaseVersion('1.2.3')).toBe(true);
    expect(isReleaseVersion('1.2.3-rc.1+build.4')).toBe(true);
    expect(isReleaseVersion('0.0.0')).toBe(true);
    expect(isReleaseVersion('1.2')).toBe(false);
    expect(isReleaseVersion('^1.2.3')).toBe(false);
    expect(isReleaseVersion('01.2.3')).toBe(false);
    expect(isReleaseVersion('1.2.3-01')).toBe(false);
  });

  test('materializes only the package and internal path constraints', () => {
    const source = `[package]\nname = "syncular-client"\nversion = "0.0.0"\n\n[dependencies]\nssp2 = { package = "syncular-ssp2", path = "../ssp2", version = "0.0.0" }\nserde = { version = "1", features = ["derive"] }\n`;
    expect(materializeCargoManifest(source, '2.3.4')).toBe(
      `[package]\nname = "syncular-client"\nversion = "2.3.4"\n\n[dependencies]\nssp2 = { package = "syncular-ssp2", path = "../ssp2", version = "2.3.4" }\nserde = { version = "1", features = ["derive"] }\n`,
    );
  });

  test('materializes named Cargo.lock packages exactly once', () => {
    const source = `[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "syncular-client"\nversion = "0.0.0"\ndependencies = []\n`;
    expect(materializeCargoLock(source, ['syncular-client'], '2.3.4')).toBe(
      source.replace('version = "0.0.0"', 'version = "2.3.4"'),
    );
    expect(() =>
      materializeCargoLock(source, ['syncular-command'], '2.3.4'),
    ).toThrow('found 0');
  });

  test('materializes one Bun workspace stamp without touching siblings', () => {
    const source = `{
  "workspaces": {
    "packages/core": {
      "name": "@syncular/core",
      "version": "0.0.0",
    },
    "packages/server": {
      "name": "@syncular/server",
      "version": "0.0.0",
    },
  },
}\n`;
    const updated = materializeBunLockWorkspace(
      source,
      'packages/core',
      '2.3.4',
    );
    expect(updated).toContain(
      `"packages/core": {\n      "name": "@syncular/core",\n      "version": "2.3.4"`,
    );
    expect(updated).toContain(
      `"packages/server": {\n      "name": "@syncular/server",\n      "version": "0.0.0"`,
    );
  });
});
