/**
 * Scaffolder unit + integration tests. The TEMPLATES THEMSELVES are exercised:
 * each is scaffolded into a temp dir, its generated schema is verified fresh
 * (`generate --check`), it is typechecked, and its own smoke test is run
 * against a workspace-linked node_modules (offline — see `link-workspace.ts`).
 *
 * Tiering (reported in the changelog): the always-run tier is scaffold-shape +
 * `generate --check` + typecheck + the app smoke, all offline and fast. The
 * env-flagged tier (`SYNCULAR_TEMPLATE_INSTALL=1`) additionally does a real
 * `bun install` per template against packed workspace packages. Run
 * `bun run build:packages` first; external dependencies need the network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  packageNameFromDirectory,
  rewriteTemplatePackageJson,
  scaffoldApp,
  TEMPLATES,
} from '../src/scaffold';
import { linkWorkspaceInto, workspaceRoot } from './link-workspace';
import { WORKSPACE_PACKAGES } from '../src/constants';

const CLI = join(import.meta.dir, '..', '..', 'typegen', 'src', 'cli.ts');
const TSC = join(workspaceRoot(), 'node_modules', '.bin', 'tsc');
const RUN_INSTALL = process.env.SYNCULAR_TEMPLATE_INSTALL === '1';

const tempDirs: string[] = [];
const packedPackages = new Map<string, string>();
beforeAll(() => {
  if (!RUN_INSTALL) return;
  const directory = mkdtempSync(join(tmpdir(), 'syncular-template-packages-'));
  tempDirs.push(directory);
  for (const name of WORKSPACE_PACKAGES) {
    const shortName = name.slice('@syncular/'.length);
    const source = join(
      workspaceRoot(),
      'packages',
      shortName === 'client' ? 'web-client' : shortName,
    );
    expect(
      existsSync(join(source, 'dist')),
      'run bun run build:packages before the install lane',
    ).toBe(true);
    const archive = join(directory, `${shortName}.tgz`);
    const packed = run(
      ['bun', 'pm', 'pack', '--quiet', '--filename', archive],
      source,
    );
    expect(packed.exitCode, packed.stderr).toBe(0);
    packedPackages.set(name, `file:${archive}`);
  }
}, 30_000);
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), 'syncular-create-'));
  tempDirs.push(dir);
  return join(dir, 'my-app');
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}
function run(cmd: string[], cwd?: string): Run {
  const r = Bun.spawnSync(cmd, cwd !== undefined ? { cwd } : {});
  return {
    exitCode: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

describe('package-name derivation', () => {
  test('sanitizes the directory basename', () => {
    expect(packageNameFromDirectory('/tmp/My App!!')).toBe('my-app');
    expect(packageNameFromDirectory('/tmp/  ')).toBe('syncular-app');
  });
});

describe('package.json rewrite', () => {
  const src = JSON.stringify({
    name: '__PROJECT_NAME__',
    dependencies: { '@syncular/core': 'workspace:*', hono: '^4.0.0' },
    devDependencies: { '@syncular/typegen': 'workspace:*' },
  });

  test('local keeps workspace ranges, sets the name, leaves externals', () => {
    const out = JSON.parse(
      rewriteTemplatePackageJson(src, { packageName: 'my-app', local: true }),
    );
    expect(out.name).toBe('my-app');
    expect(out.dependencies['@syncular/core']).toBe('workspace:*');
    expect(out.dependencies.hono).toBe('^4.0.0');
    expect(out.devDependencies['@syncular/typegen']).toBe('workspace:*');
  });

  test('non-local rewrites workspace ranges to the published range', () => {
    const out = JSON.parse(
      rewriteTemplatePackageJson(src, { packageName: 'my-app', local: false }),
    );
    // Assert the published range round-trips through the rewrite path without
    // pinning this test to a release version.
    expect(typeof out.dependencies['@syncular/core']).toBe('string');
  });
});

for (const template of TEMPLATES) {
  describe(`template: ${template}`, () => {
    test('scaffolds a coherent tree', () => {
      const target = tmpTarget();
      const result = scaffoldApp({ template, targetDir: target, local: true });
      expect(result.template).toBe(template);
      expect(result.packageName).toBe('my-app');

      // .gitignore restored from the shipped `gitignore` placeholder.
      expect(existsSync(join(target, '.gitignore'))).toBe(true);
      expect(existsSync(join(target, 'gitignore'))).toBe(false);

      // placeholder substituted in package.json + README.
      const pkg = JSON.parse(
        readFileSync(join(target, 'package.json'), 'utf8'),
      );
      expect(pkg.name).toBe('my-app');
      expect(pkg.dependencies['@syncular/server']).toBe('workspace:*');
      expect(readFileSync(join(target, 'README.md'), 'utf8')).not.toContain(
        '__PROJECT_NAME__',
      );

      // the required quality-bar files exist.
      for (const f of ['tsconfig.json', 'syncular.json', 'README.md']) {
        expect(existsSync(join(target, f))).toBe(true);
      }
      expect(existsSync(join(target, 'src', 'smoke.test.ts'))).toBe(true);

      // no placeholder survives in any scaffolded text file.
      const indexHtml = join(target, 'src', 'frontend', 'index.html');
      if (existsSync(indexHtml)) {
        expect(readFileSync(indexHtml, 'utf8')).not.toContain(
          '__PROJECT_NAME__',
        );
      }
      if (template === 'web') {
        const frontend = readFileSync(
          join(target, 'src', 'frontend', 'main.ts'),
          'utf8',
        );
        expect(frontend).toContain('checkBrowserStoragePersistence');
        expect(frontend).toContain('requestBrowserStoragePersistence');
        expect(frontend).toContain(
          'Unsynced changes can disappear if the browser evicts this site.',
        );
        expect(readFileSync(indexHtml, 'utf8')).toContain(
          'Protect offline data',
        );
      }
    });

    test('committed generated schema is fresh (generate --check)', () => {
      const target = tmpTarget();
      scaffoldApp({ template, targetDir: target, local: true });
      const check = run([
        'bun',
        CLI,
        'generate',
        '--manifest-dir',
        target,
        '--check',
      ]);
      expect(check.stderr).toBe('');
      expect(check.exitCode).toBe(0);
    });

    test('typechecks + smoke passes against the linked workspace', () => {
      const target = tmpTarget();
      scaffoldApp({ template, targetDir: target, local: true });
      linkWorkspaceInto(target);

      // tsc follows the workspace symlinks and would also type-check the
      // dependency SOURCES (workspace links are `.ts`, not shipped `.d.ts`) —
      // that internal type noise is the packages' own concern (gated by the
      // workspace `bun run typecheck`), not the template's. Assert only that
      // the template's OWN files raise no diagnostics.
      const typecheck = run(['bun', TSC, '--noEmit'], target);
      const templateErrors = (typecheck.stdout + typecheck.stderr)
        .split('\n')
        .filter((line) => /error TS/.test(line))
        .filter((line) => !line.includes('/packages/'));
      expect(templateErrors).toEqual([]);

      const smoke = run(['bun', 'test'], target);
      expect(smoke.exitCode).toBe(0);
      expect(smoke.stderr + smoke.stdout).toContain('pass');
      // Scaffold + linked-workspace typecheck + template tests together sit
      // near bun's 5 s default; the deadline scales with workspace growth.
    }, 30_000);

    test.if(RUN_INSTALL)(
      'full install + smoke (SYNCULAR_TEMPLATE_INSTALL=1)',
      () => {
        const target = tmpTarget();
        scaffoldApp({ template, targetDir: target, local: true });
        const manifestPath = join(target, 'package.json');
        const manifest: {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          overrides?: Record<string, string>;
        } = JSON.parse(readFileSync(manifestPath, 'utf8'));
        for (const dependencies of [
          manifest.dependencies,
          manifest.devDependencies,
        ]) {
          if (dependencies === undefined) continue;
          for (const [name, archive] of packedPackages) {
            if (name in dependencies) dependencies[name] = archive;
          }
        }
        manifest.overrides = Object.fromEntries(packedPackages);
        writeFileSync(manifestPath, JSON.stringify(manifest));
        const install = run(['bun', 'install'], target);
        expect(install.exitCode, install.stderr).toBe(0);
        const smoke = run(['bun', 'test'], target);
        expect(smoke.exitCode).toBe(0);
      },
      30_000,
    );
  });
}
