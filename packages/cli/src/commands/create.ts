import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  BASE_CLIENT_PACKAGES,
  BASE_SCRIPT_COMMANDS,
  CLIENT_DIALECT_TEMPLATES,
  DEFAULT_CONFIG_PATH,
  DEFAULT_LIBRARIES_TARGETS,
  DEFAULT_MIGRATE_EXPORT,
  ELECTRON_DIALECT_TEMPLATES,
  LIBRARIES_TARGETS,
  SERVER_DIALECT_TEMPLATES,
} from '../constants';
import { readTemplate, renderTemplate, writeFileIfAllowed } from '../template';
import type {
  ClientDialect,
  CommandResult,
  DemoOptions,
  ElectronDialect,
  LibrariesOptions,
  LibrariesTarget,
  ParsedArgs,
  ServerDialect,
} from '../types';

interface PackageJsonShape {
  name?: string;
  private?: boolean;
  type?: string;
  scripts?: Record<string, string>;
}

function indentMultiline(value: string, spaces: number): string {
  const indent = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line, index) => (index === 0 ? line : `${indent}${line}`))
    .join('\n');
}

function parseTargetList(
  value: string | undefined
): LibrariesTarget[] | { error: string } {
  if (!value) return [...DEFAULT_LIBRARIES_TARGETS];

  const parsed = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (parsed.length === 0) {
    return { error: 'At least one target is required for create.' };
  }

  const allowed = new Set<string>(LIBRARIES_TARGETS);
  const invalid = parsed.find((target) => !allowed.has(target));
  if (invalid) {
    return {
      error:
        `Invalid target "${invalid}". ` +
        `Use: ${LIBRARIES_TARGETS.join(', ')}`,
    };
  }

  const deduped = Array.from(new Set(parsed));
  return deduped as LibrariesTarget[];
}

function parseServerDialect(
  value: string | undefined
): ServerDialect | { error: string } {
  if (!value || value === 'sqlite') return 'sqlite';
  if (value === 'postgres') return 'postgres';
  return {
    error: 'Invalid --server-dialect. Use sqlite or postgres.',
  };
}

function parseClientDialect(
  value: string | undefined,
  flagName: string
): ClientDialect | { error: string } {
  if (!value || value === 'wa-sqlite') return 'wa-sqlite';
  if (value === 'pglite') return 'pglite';
  if (value === 'bun-sqlite') return 'bun-sqlite';
  if (value === 'better-sqlite3') return 'better-sqlite3';
  if (value === 'sqlite3') return 'sqlite3';
  return {
    error:
      `Invalid ${flagName}. Use wa-sqlite, pglite, bun-sqlite, ` +
      'better-sqlite3, or sqlite3.',
  };
}

function parseElectronDialect(
  value: string | undefined
): ElectronDialect | { error: string } {
  if (!value || value === 'electron-sqlite') return 'electron-sqlite';
  if (value === 'better-sqlite3') return 'better-sqlite3';
  return {
    error: 'Invalid --electron-dialect. Use electron-sqlite or better-sqlite3.',
  };
}

export function resolveLibrariesOptions(
  args: ParsedArgs
): LibrariesOptions | { error: string } {
  const targets = parseTargetList(args.flagValues.get('--targets'));
  if (!Array.isArray(targets)) {
    return targets;
  }

  const serverDialect = parseServerDialect(
    args.flagValues.get('--server-dialect')
  );
  if (typeof serverDialect !== 'string') {
    return serverDialect;
  }

  const reactDialect = parseClientDialect(
    args.flagValues.get('--react-dialect'),
    '--react-dialect'
  );
  if (typeof reactDialect !== 'string') {
    return reactDialect;
  }

  const vanillaDialect = parseClientDialect(
    args.flagValues.get('--vanilla-dialect'),
    '--vanilla-dialect'
  );
  if (typeof vanillaDialect !== 'string') {
    return vanillaDialect;
  }

  const electronDialect = parseElectronDialect(
    args.flagValues.get('--electron-dialect')
  );
  if (typeof electronDialect !== 'string') {
    return electronDialect;
  }

  return {
    targetDir: resolve(process.cwd(), args.flagValues.get('--dir') ?? '.'),
    force: args.flags.has('--force'),
    targets,
    serverDialect,
    reactDialect,
    vanillaDialect,
    electronDialect,
  };
}

function resolveDemoOptions(args: ParsedArgs): DemoOptions {
  return {
    targetDir: resolve(process.cwd(), args.flagValues.get('--dir') ?? '.'),
    force: args.flags.has('--force'),
  };
}

function collectLibrariesInstallPackages(options: LibrariesOptions): string[] {
  const packages = new Set<string>();

  if (options.targets.includes('server')) {
    for (const item of SERVER_DIALECT_TEMPLATES[options.serverDialect]
      .installPackages) {
      packages.add(item);
    }
  }

  if (options.targets.includes('react')) {
    for (const item of BASE_CLIENT_PACKAGES) packages.add(item);
    packages.add('@syncular/client-react');
    for (const item of CLIENT_DIALECT_TEMPLATES[options.reactDialect]
      .installPackages) {
      packages.add(item);
    }
  }

  if (options.targets.includes('vanilla')) {
    for (const item of BASE_CLIENT_PACKAGES) packages.add(item);
    for (const item of CLIENT_DIALECT_TEMPLATES[options.vanillaDialect]
      .installPackages) {
      packages.add(item);
    }
  }

  if (options.targets.includes('expo')) {
    for (const item of BASE_CLIENT_PACKAGES) packages.add(item);
    packages.add('@syncular/dialect-expo-sqlite');
  }

  if (options.targets.includes('react-native')) {
    for (const item of BASE_CLIENT_PACKAGES) packages.add(item);
    packages.add('@syncular/dialect-react-native-nitro-sqlite');
  }

  if (options.targets.includes('electron')) {
    for (const item of BASE_CLIENT_PACKAGES) packages.add(item);
    for (const item of ELECTRON_DIALECT_TEMPLATES[options.electronDialect]
      .installPackages) {
      packages.add(item);
    }
  }

  if (options.targets.includes('proxy-api')) {
    packages.add('@syncular/server');
    packages.add('@syncular/server-hono');
    packages.add('@syncular/client');
    packages.add('kysely');
    packages.add('hono');
  }

  packages.add('@syncular/migrations');
  packages.add('@syncular/typegen');

  return Array.from(packages).sort();
}

async function updatePackageJsonScripts(args: {
  targetDir: string;
  scripts: Record<string, string>;
  force: boolean;
}): Promise<'created' | 'updated' | 'skipped'> {
  const packagePath = join(args.targetDir, 'package.json');
  let current: PackageJsonShape | null = null;

  try {
    const raw = await readFile(packagePath, 'utf8');
    current = JSON.parse(raw) as PackageJsonShape;
  } catch {
    current = null;
  }

  const next: PackageJsonShape = current ?? {
    name: basename(args.targetDir) || 'syncular-app',
    private: true,
    type: 'module',
    scripts: {},
  };

  const existingScripts = next.scripts ?? {};
  const mergedScripts = { ...existingScripts };

  let changed = current === null;
  for (const [name, cmd] of Object.entries(args.scripts)) {
    const prev = mergedScripts[name];
    if (prev === undefined || args.force) {
      if (prev !== cmd) {
        mergedScripts[name] = cmd;
        changed = true;
      }
    }
  }

  next.scripts = mergedScripts;

  if (!changed && current !== null) return 'skipped';

  await writeFile(packagePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return current === null ? 'created' : 'updated';
}

async function scaffoldLibraries(
  options: LibrariesOptions
): Promise<CommandResult> {
  const lines: string[] = [];

  const configTemplate = await readTemplate(
    'libraries/syncular.config.json.tpl'
  );
  const migrateTemplate = await readTemplate(
    'libraries/syncular-migrate.ts.tpl'
  );
  const typegenTemplate = await readTemplate(
    'libraries/syncular-typegen.ts.tpl'
  );

  const dialects: Record<string, string> = {};
  if (options.targets.includes('server'))
    dialects.server = options.serverDialect;
  if (options.targets.includes('react')) dialects.react = options.reactDialect;
  if (options.targets.includes('vanilla')) {
    dialects.vanilla = options.vanillaDialect;
  }
  if (options.targets.includes('electron')) {
    dialects.electron = options.electronDialect;
  }
  if (options.targets.includes('expo')) dialects.expo = 'expo-sqlite';
  if (options.targets.includes('react-native')) {
    dialects['react-native'] = 'react-native-nitro-sqlite';
  }

  const configContent = renderTemplate(configTemplate, {
    MODE_JSON: JSON.stringify('libraries'),
    TARGETS_JSON: indentMultiline(JSON.stringify(options.targets, null, 2), 2),
    DIALECTS_JSON: indentMultiline(JSON.stringify(dialects, null, 2), 2),
    ADAPTER_PATH: './scripts/syncular-migrate.ts',
    ADAPTER_EXPORT: DEFAULT_MIGRATE_EXPORT,
  });

  const configState = await writeFileIfAllowed({
    targetPath: join(options.targetDir, DEFAULT_CONFIG_PATH),
    content: configContent,
    force: options.force,
  });
  lines.push(
    `Config file: ${join(options.targetDir, DEFAULT_CONFIG_PATH)} (${configState})`
  );

  const migrateState = await writeFileIfAllowed({
    targetPath: join(options.targetDir, 'scripts/syncular-migrate.ts'),
    content: renderTemplate(migrateTemplate, {
      ADAPTER_EXPORT: DEFAULT_MIGRATE_EXPORT,
    }),
    force: options.force,
  });
  lines.push(
    `Migration script: ${join(options.targetDir, 'scripts/syncular-migrate.ts')} (${migrateState})`
  );

  const typegenState = await writeFileIfAllowed({
    targetPath: join(options.targetDir, 'scripts/syncular-typegen.ts'),
    content: typegenTemplate,
    force: options.force,
  });
  lines.push(
    `Typegen script: ${join(options.targetDir, 'scripts/syncular-typegen.ts')} (${typegenState})`
  );

  const targetTemplates: Array<Promise<string>> = [];

  if (options.targets.includes('server')) {
    const serverTemplate = await readTemplate(
      SERVER_DIALECT_TEMPLATES[options.serverDialect].templateFile
    );
    targetTemplates.push(
      writeFileIfAllowed({
        targetPath: join(options.targetDir, 'src/syncular/server/index.ts'),
        content: serverTemplate,
        force: options.force,
      }).then(
        (state) =>
          `Library module: ${join(options.targetDir, 'src/syncular/server/index.ts')} (${state})`
      )
    );
  }

  if (options.targets.includes('react')) {
    const template = await readTemplate('libraries/syncular-react.ts.tpl');
    const dialect = CLIENT_DIALECT_TEMPLATES[options.reactDialect];
    targetTemplates.push(
      writeFileIfAllowed({
        targetPath: join(options.targetDir, 'src/syncular/react/index.ts'),
        content: renderTemplate(template, {
          CLIENT_DIALECT: dialect.id,
          CLIENT_DIALECT_LABEL: dialect.label,
          CLIENT_DIALECT_IMPORT: dialect.importStatement,
          CLIENT_DB_FACTORY_LINE: dialect.dbFactoryLine,
        }),
        force: options.force,
      }).then(
        (state) =>
          `Library module: ${join(options.targetDir, 'src/syncular/react/index.ts')} (${state})`
      )
    );
  }

  if (options.targets.includes('vanilla')) {
    const template = await readTemplate('libraries/syncular-vanilla.ts.tpl');
    const dialect = CLIENT_DIALECT_TEMPLATES[options.vanillaDialect];
    targetTemplates.push(
      writeFileIfAllowed({
        targetPath: join(options.targetDir, 'src/syncular/vanilla/index.ts'),
        content: renderTemplate(template, {
          CLIENT_DIALECT: dialect.id,
          CLIENT_DIALECT_LABEL: dialect.label,
          CLIENT_DIALECT_IMPORT: dialect.importStatement,
          CLIENT_DB_FACTORY_LINE: dialect.dbFactoryLine,
        }),
        force: options.force,
      }).then(
        (state) =>
          `Library module: ${join(options.targetDir, 'src/syncular/vanilla/index.ts')} (${state})`
      )
    );
  }

  if (options.targets.includes('expo')) {
    const template = await readTemplate('libraries/syncular-expo.ts.tpl');
    targetTemplates.push(
      writeFileIfAllowed({
        targetPath: join(options.targetDir, 'src/syncular/expo/index.ts'),
        content: template,
        force: options.force,
      }).then(
        (state) =>
          `Library module: ${join(options.targetDir, 'src/syncular/expo/index.ts')} (${state})`
      )
    );
  }

  if (options.targets.includes('react-native')) {
    const template = await readTemplate(
      'libraries/syncular-react-native.ts.tpl'
    );
    targetTemplates.push(
      writeFileIfAllowed({
        targetPath: join(
          options.targetDir,
          'src/syncular/react-native/index.ts'
        ),
        content: template,
        force: options.force,
      }).then(
        (state) =>
          `Library module: ${join(options.targetDir, 'src/syncular/react-native/index.ts')} (${state})`
      )
    );
  }

  if (options.targets.includes('electron')) {
    const template = await readTemplate('libraries/syncular-electron.ts.tpl');
    const dialect = ELECTRON_DIALECT_TEMPLATES[options.electronDialect];
    targetTemplates.push(
      writeFileIfAllowed({
        targetPath: join(options.targetDir, 'src/syncular/electron/index.ts'),
        content: renderTemplate(template, {
          ELECTRON_DIALECT: dialect.id,
          ELECTRON_DIALECT_LABEL: dialect.label,
          ELECTRON_DIALECT_IMPORT: dialect.importStatement,
          ELECTRON_DB_FACTORY_LINE: dialect.dbFactoryLine,
        }),
        force: options.force,
      }).then(
        (state) =>
          `Library module: ${join(options.targetDir, 'src/syncular/electron/index.ts')} (${state})`
      )
    );
  }

  if (options.targets.includes('proxy-api')) {
    const template = await readTemplate('libraries/syncular-proxy-api.ts.tpl');
    targetTemplates.push(
      writeFileIfAllowed({
        targetPath: join(options.targetDir, 'src/syncular/proxy-api/index.ts'),
        content: template,
        force: options.force,
      }).then(
        (state) =>
          `Library module: ${join(options.targetDir, 'src/syncular/proxy-api/index.ts')} (${state})`
      )
    );
  }

  const moduleStates = await Promise.all(targetTemplates);
  lines.push(...moduleStates);

  const scriptsState = await updatePackageJsonScripts({
    targetDir: options.targetDir,
    force: options.force,
    scripts: {
      'db:migrate:status': BASE_SCRIPT_COMMANDS.migrateStatus,
      'db:migrate': BASE_SCRIPT_COMMANDS.migrate,
      'db:migrate:reset': BASE_SCRIPT_COMMANDS.migrateReset,
      'db:typegen': BASE_SCRIPT_COMMANDS.typegen,
      'db:prepare': BASE_SCRIPT_COMMANDS.prepare,
    },
  });
  lines.push(
    `Package scripts: ${join(options.targetDir, 'package.json')} (${scriptsState})`
  );

  const packages = collectLibrariesInstallPackages(options);
  lines.push(`Targets: ${options.targets.join(', ')}`);
  if (options.targets.includes('server')) {
    lines.push(`Server dialect: ${options.serverDialect}`);
  }
  if (options.targets.includes('react')) {
    lines.push(`React dialect: ${options.reactDialect}`);
  }
  if (options.targets.includes('vanilla')) {
    lines.push(`Vanilla dialect: ${options.vanillaDialect}`);
  }
  if (options.targets.includes('electron')) {
    lines.push(`Electron dialect: ${options.electronDialect}`);
  }
  lines.push('Recommended install command:');
  lines.push(`npm install ${packages.join(' ')}`);

  return {
    title: 'Create Libraries',
    ok: true,
    lines,
  };
}

async function scaffoldDemo(options: DemoOptions): Promise<CommandResult> {
  const projectName = basename(options.targetDir) || 'syncular-demo';
  const files = [
    { path: 'package.json', template: 'demo/package.json.tpl' },
    { path: 'tsconfig.json', template: 'demo/tsconfig.json.tpl' },
    { path: 'vite.config.ts', template: 'demo/vite.config.ts.tpl' },
    { path: 'index.html', template: 'demo/index.html.tpl' },
    { path: DEFAULT_CONFIG_PATH, template: 'demo/syncular.config.json.tpl' },
    {
      path: 'scripts/syncular-migrate.ts',
      template: 'demo/syncular-migrate.ts.tpl',
    },
    {
      path: 'scripts/syncular-typegen.ts',
      template: 'demo/syncular-typegen.ts.tpl',
    },
    { path: 'src/shared/db.ts', template: 'demo/src/shared/db.ts.tpl' },
    { path: 'src/server/index.ts', template: 'demo/src/server/index.ts.tpl' },
    { path: 'src/client/main.tsx', template: 'demo/src/client/main.tsx.tpl' },
    { path: 'src/client/App.tsx', template: 'demo/src/client/App.tsx.tpl' },
    {
      path: 'src/client/syncular.ts',
      template: 'demo/src/client/syncular.ts.tpl',
    },
    {
      path: 'src/client/styles.css',
      template: 'demo/src/client/styles.css.tpl',
    },
  ] as const;

  const lines: string[] = [];
  for (const file of files) {
    const template = await readTemplate(file.template);
    const content = renderTemplate(template, {
      PROJECT_NAME: projectName,
      ADAPTER_EXPORT: DEFAULT_MIGRATE_EXPORT,
      ADAPTER_PATH: './scripts/syncular-migrate.ts',
    });
    const state = await writeFileIfAllowed({
      targetPath: join(options.targetDir, file.path),
      content,
      force: options.force,
    });
    lines.push(`Demo file: ${join(options.targetDir, file.path)} (${state})`);
  }

  return {
    title: 'Create Demo',
    ok: true,
    lines: [
      ...lines,
      'Install dependencies with: bun install (or npm install)',
      'Run demo with: bun dev (or npm run dev)',
    ],
  };
}

export async function runCreateLibraries(
  args: ParsedArgs
): Promise<CommandResult> {
  const options = resolveLibrariesOptions(args);
  if ('error' in options) {
    return {
      title: 'Create Libraries',
      ok: false,
      lines: [options.error],
    };
  }

  return runCreateLibrariesWithOptions(options);
}

export async function runCreateLibrariesWithOptions(
  options: LibrariesOptions
): Promise<CommandResult> {
  return scaffoldLibraries(options);
}

export async function runCreateDemo(args: ParsedArgs): Promise<CommandResult> {
  const options = resolveDemoOptions(args);
  return scaffoldDemo(options);
}
