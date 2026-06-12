import { describe, expect, test } from 'bun:test';
import {
  detectPackageManager,
  nextStepsMessage,
  packageNameFromDirectory,
  parseCreateCliArgs,
  rewriteTemplatePackageJson,
  syncularDependencyRange,
} from './cli';

describe('parseCreateCliArgs', () => {
  test('parses the target directory', () => {
    expect(parseCreateCliArgs(['my-app'])).toEqual({
      help: false,
      targetDir: 'my-app',
    });
  });

  test('parses --help', () => {
    expect(parseCreateCliArgs(['--help']).help).toBe(true);
    expect(parseCreateCliArgs(['-h']).help).toBe(true);
  });

  test('rejects unknown options and extra arguments', () => {
    expect(() => parseCreateCliArgs(['--force'])).toThrow('Unknown option');
    expect(() => parseCreateCliArgs(['a', 'b'])).toThrow(
      'Unexpected extra argument'
    );
  });
});

describe('packageNameFromDirectory', () => {
  test('uses the directory basename', () => {
    expect(packageNameFromDirectory('/tmp/My App!')).toBe('my-app');
    expect(packageNameFromDirectory('apps/todo_app')).toBe('todo_app');
  });

  test('falls back when nothing usable remains', () => {
    expect(packageNameFromDirectory('/tmp/---')).toBe('syncular-app');
  });
});

describe('syncularDependencyRange', () => {
  test('uses a caret range on the stamped version', () => {
    expect(syncularDependencyRange('0.0.6-248')).toBe('^0.0.6-248');
    expect(syncularDependencyRange('0.1.0')).toBe('^0.1.0');
  });

  test('falls back for the unstamped development version', () => {
    expect(syncularDependencyRange('0.0.0')).toBe('^0.0.6');
    expect(syncularDependencyRange(undefined)).toBe('^0.0.6');
  });
});

describe('rewriteTemplatePackageJson', () => {
  test('renames the package and pins workspace Syncular deps', () => {
    const source = JSON.stringify({
      name: 'syncular-app-template',
      dependencies: {
        '@syncular/client': 'workspace:*',
        react: '^19.2.4',
      },
      devDependencies: {
        syncular: 'workspace:*',
        vite: '^8.0.14',
      },
    });

    const result = JSON.parse(
      rewriteTemplatePackageJson(source, {
        packageName: 'my-app',
        syncularRange: '^0.0.7',
      })
    ) as {
      name: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(result.name).toBe('my-app');
    expect(result.dependencies['@syncular/client']).toBe('^0.0.7');
    expect(result.dependencies.react).toBe('^19.2.4');
    expect(result.devDependencies.syncular).toBe('^0.0.7');
    expect(result.devDependencies.vite).toBe('^8.0.14');
  });
});

describe('detectPackageManager', () => {
  test('detects from npm_config_user_agent', () => {
    expect(detectPackageManager('bun/1.3.13 npm/? node/v24.0.0')).toBe('bun');
    expect(detectPackageManager('pnpm/10.0.0 npm/? node/v24.0.0')).toBe('pnpm');
    expect(detectPackageManager('yarn/4.5.0 npm/? node/v24.0.0')).toBe('yarn');
    expect(detectPackageManager('npm/11.0.0 node/v24.0.0')).toBe('npm');
    expect(detectPackageManager(undefined)).toBe('bun');
  });
});

describe('nextStepsMessage', () => {
  test('adapts commands to the package manager', () => {
    const bun = nextStepsMessage('my-app', 'bun');
    expect(bun).toContain('cd my-app');
    expect(bun).toContain('bun install');
    expect(bun).toContain('bun dev');

    const npm = nextStepsMessage('my-app', 'npm');
    expect(npm).toContain('npm install');
    expect(npm).toContain('npm run dev');

    const yarn = nextStepsMessage('my-app', 'yarn');
    expect(yarn).toContain('  yarn\n');
  });
});
