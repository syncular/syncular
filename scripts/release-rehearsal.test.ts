import { describe, expect, it } from 'bun:test';
import {
  applyStableReleaseBrowserRequirements,
  isStableReleaseVersion,
  type Options,
} from './release-rehearsal';

describe('release rehearsal stable browser requirements', () => {
  it('classifies stable package versions without treating prereleases as stable', () => {
    expect(isStableReleaseVersion('0.1.3')).toBe(true);
    expect(isStableReleaseVersion('1.2.3+build.4')).toBe(true);
    expect(isStableReleaseVersion('0.1.3-staging.1')).toBe(false);
    expect(isStableReleaseVersion('1.2.3-beta.0+build.4')).toBe(false);
  });

  it('requires real browser proofs for clean stable release rehearsals', () => {
    const options = applyStableReleaseBrowserRequirements(
      releaseOptions({ version: '0.1.3' })
    );

    expect(options.requireStarterBrowserPreview).toBe(true);
    expect(options.requireFrameworkViteBrowserRuntime).toBe(true);
  });

  it('keeps prerelease and local iteration browser requirements opt-in', () => {
    expect(
      applyStableReleaseBrowserRequirements(
        releaseOptions({ version: '0.1.3-staging.1' })
      )
    ).toMatchObject({
      requireStarterBrowserPreview: false,
      requireFrameworkViteBrowserRuntime: false,
    });

    expect(
      applyStableReleaseBrowserRequirements(
        releaseOptions({ allowDirty: true, version: '0.1.3' })
      )
    ).toMatchObject({
      requireStarterBrowserPreview: false,
      requireFrameworkViteBrowserRuntime: false,
    });
  });

  it('does not allow clean stable release rehearsals to skip browser proof owners', () => {
    expect(() =>
      applyStableReleaseBrowserRequirements(
        releaseOptions({ skipStarterSmoke: true, version: '0.1.3' })
      )
    ).toThrow(/built-preview smoke/u);

    expect(() =>
      applyStableReleaseBrowserRequirements(
        releaseOptions({ skipFrameworkImportSmokes: true, version: '0.1.3' })
      )
    ).toThrow(/framework import smokes/u);
  });
});

function releaseOptions(overrides: Partial<Options> = {}): Options {
  return {
    version: '0.1.3',
    allowDirty: false,
    skipPublishDryRuns: false,
    skipFreshAppSmokes: false,
    skipFrameworkImportSmokes: false,
    skipConsoleArtifactIngestion: false,
    skipOpsReadiness: false,
    skipStarterSmoke: false,
    skipDocsStaleCheck: false,
    requireOpsReadiness: false,
    requireStarterBrowserPreview: false,
    requireFrameworkViteBrowserRuntime: false,
    keepWorktree: false,
    workDir: '',
    opsConfig: '',
    ...overrides,
  };
}
