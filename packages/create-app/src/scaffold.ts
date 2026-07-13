/**
 * The scaffolder's heart: copy a template tree into a target directory, with
 * dumb, greppable placeholder substitution and a single dependency-range
 * decision. Kept pure of process/argv concerns so tests drive it directly.
 */
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_SCOPE,
  PLACEHOLDER,
  PUBLISHED_DEPENDENCY_RANGE,
} from './constants';

/** The templates this rung ships. */
export const TEMPLATES = ['minimal', 'web', 'tauri'] as const;
export type TemplateName = (typeof TEMPLATES)[number];

export function isTemplateName(value: string): value is TemplateName {
  return (TEMPLATES as readonly string[]).includes(value);
}

/** Absolute path to `template/` inside this package (works for src or dist). */
export function templatesRoot(): string {
  return fileURLToPath(new URL('../template', import.meta.url));
}

/** Derive a safe npm package name from the target directory basename. */
export function packageNameFromDirectory(targetDir: string): string {
  const name = basename(resolve(targetDir))
    .toLowerCase()
    .replace(/[^a-z0-9-_.~]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return name.length > 0 ? name : `${PACKAGE_SCOPE.slice(1)}-app`;
}

function isWorkspacePackage(dependencyName: string): boolean {
  return dependencyName.startsWith(`${PACKAGE_SCOPE}/`);
}

/**
 * Rewrite a template's package.json: set `name`, and resolve the dependency
 * range for every `@<scope>/*` workspace dependency.
 *
 * The local-vs-published question, decided honestly (also documented in the
 * package README):
 * - `local: true` keeps `workspace:*` verbatim — the only ranges that resolve
 *   when the scaffolded app sits inside this repo's workspace (the in-tree
 *   smoke test path, and `--local` for anyone hacking on the tree).
 * - `local: false` rewrites to {@link PUBLISHED_DEPENDENCY_RANGE}. Today that
 *   is *also* `workspace:*` because the v2 packages are unpublished and
 *   version-less (TODO 6.3); the CLI warns. It is one constant to flip the day
 *   they publish.
 */
export function rewriteTemplatePackageJson(
  source: string,
  options: { packageName: string; local: boolean },
): string {
  const pkg = JSON.parse(source) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  pkg.name = options.packageName;
  const range = options.local ? 'workspace:*' : PUBLISHED_DEPENDENCY_RANGE;
  for (const section of [pkg.dependencies, pkg.devDependencies]) {
    if (section === undefined) continue;
    for (const [name, current] of Object.entries(section)) {
      if (isWorkspacePackage(name) && current.startsWith('workspace:')) {
        section[name] = range;
      }
    }
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Replace `__PROJECT_NAME__` everywhere in a text file body. */
function substitutePlaceholders(body: string, projectName: string): string {
  return body.replaceAll(PLACEHOLDER.projectName, projectName);
}

export interface ScaffoldOptions {
  readonly template: TemplateName;
  readonly targetDir: string;
  /** Keep `workspace:*` ranges (in-tree testing / repo hacking). */
  readonly local?: boolean;
}

export interface ScaffoldResult {
  readonly targetDir: string;
  readonly packageName: string;
  readonly template: TemplateName;
  readonly local: boolean;
}

/**
 * Files whose bodies get `__PROJECT_NAME__` substitution. Everything else is
 * copied byte-for-byte. Deliberately a short allow-list (missing paths are
 * skipped per-template) — substitution stays dumb and auditable rather than
 * scanning every file. Paths are relative + POSIX-joined below.
 */
const SUBSTITUTE_FILES = [
  'README.md',
  'src/frontend/index.html',
  'src/frontend/main.tsx',
  'src-tauri/tauri.conf.json',
] as const;

function directoryIsEmpty(path: string): boolean {
  return readdirSync(path).length === 0;
}

/**
 * Copy `template/<template>` into `targetDir` and finalize it: restore the
 * `.gitignore` name (npm strips real dotfiles from tarballs, so templates ship
 * `gitignore`), rewrite package.json, and substitute placeholders.
 */
export function scaffoldApp(options: ScaffoldOptions): ScaffoldResult {
  const targetDir = resolve(options.targetDir);
  const templateDir = join(templatesRoot(), options.template);
  const local = options.local ?? false;

  if (!existsSync(templateDir)) {
    throw new Error(`unknown template directory: ${templateDir}`);
  }
  if (existsSync(targetDir) && !directoryIsEmpty(targetDir)) {
    throw new Error(`target directory is not empty: ${targetDir}`);
  }

  cpSync(templateDir, targetDir, { recursive: true });

  const gitignorePlaceholder = join(targetDir, 'gitignore');
  if (existsSync(gitignorePlaceholder)) {
    renameSync(gitignorePlaceholder, join(targetDir, '.gitignore'));
  }

  const packageName = packageNameFromDirectory(targetDir);

  const packageJsonPath = join(targetDir, 'package.json');
  writeFileSync(
    packageJsonPath,
    rewriteTemplatePackageJson(readFileSync(packageJsonPath, 'utf8'), {
      packageName,
      local,
    }),
  );

  for (const relPath of SUBSTITUTE_FILES) {
    const path = join(targetDir, relPath);
    if (existsSync(path)) {
      writeFileSync(
        path,
        substitutePlaceholders(readFileSync(path, 'utf8'), packageName),
      );
    }
  }

  return { targetDir, packageName, template: options.template, local };
}
