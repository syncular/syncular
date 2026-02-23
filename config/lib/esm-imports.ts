import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.node']);

const IMPORT_EXPORT_FROM_PATTERN =
  /(^|[\n;])(\s*(?:import|export)\s+[^\n;]*?\sfrom\s*)(['"])([^'"]+)\3/gm;
const SIDE_EFFECT_IMPORT_PATTERN = /(^|[\n;])(\s*import\s*)(['"])([^'"]+)\3/gm;
const DYNAMIC_IMPORT_PATTERN = /\bimport\(\s*(['"])([^'"]+)\1\s*\)/g;

function hasRuntimeExtension(specifier: string): boolean {
  const extension = path.extname(specifier);
  return JS_EXTENSIONS.has(extension);
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function resolveRuntimeSpecifier(
  importerPath: string,
  specifier: string
): string | null {
  if (!isRelativeSpecifier(specifier) || hasRuntimeExtension(specifier)) {
    return specifier;
  }

  const importerDir = path.dirname(importerPath);
  const resolvedBase = path.resolve(importerDir, specifier);
  const fileCandidate = `${resolvedBase}.js`;
  if (existsSync(fileCandidate) && statSync(fileCandidate).isFile()) {
    return `${specifier}.js`;
  }

  const indexCandidate = path.join(resolvedBase, 'index.js');
  if (existsSync(indexCandidate) && statSync(indexCandidate).isFile()) {
    const normalized = specifier.endsWith('/')
      ? specifier.slice(0, -1)
      : specifier;
    return `${normalized}/index.js`;
  }

  return null;
}

function collectJsFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];

  const files: string[] = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    if (!currentDir) continue;

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (entry.isFile() && fullPath.endsWith('.js')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function rewriteJsModuleFile(filePath: string): string[] {
  const unresolvedSpecifiers: string[] = [];
  let source = readFileSync(filePath, 'utf8');

  const rewriteSpecifier = (original: string): string => {
    const resolved = resolveRuntimeSpecifier(filePath, original);
    if (resolved) return resolved;

    if (!isRelativeSpecifier(original) || hasRuntimeExtension(original)) {
      return original;
    }

    unresolvedSpecifiers.push(original);
    return original;
  };

  source = source.replace(
    IMPORT_EXPORT_FROM_PATTERN,
    (_match, prefix, statementPrefix, quote, specifier) => {
      const rewritten = rewriteSpecifier(specifier);
      return `${prefix}${statementPrefix}${quote}${rewritten}${quote}`;
    }
  );

  source = source.replace(
    SIDE_EFFECT_IMPORT_PATTERN,
    (_match, prefix, statementPrefix, quote, specifier) => {
      const rewritten = rewriteSpecifier(specifier);
      return `${prefix}${statementPrefix}${quote}${rewritten}${quote}`;
    }
  );

  source = source.replace(
    DYNAMIC_IMPORT_PATTERN,
    (_match, quote, specifier) => {
      const rewritten = rewriteSpecifier(specifier);
      return `import(${quote}${rewritten}${quote})`;
    }
  );

  writeFileSync(filePath, source, 'utf8');

  return unresolvedSpecifiers;
}

export function fixEsmImportsInDirectory(distDir: string): void {
  const absoluteDistDir = path.resolve(distDir);
  const files = collectJsFiles(absoluteDistDir);

  const unresolvedByFile = new Map<string, string[]>();

  for (const file of files) {
    const unresolved = rewriteJsModuleFile(file);
    if (unresolved.length > 0) {
      unresolvedByFile.set(file, unresolved);
    }
  }

  if (unresolvedByFile.size > 0) {
    const messages = Array.from(unresolvedByFile.entries()).map(
      ([file, specifiers]) =>
        `${file}: ${Array.from(new Set(specifiers)).join(', ')}`
    );
    throw new Error(
      `Unable to resolve relative ESM specifiers in dist output:\n${messages.join('\n')}`
    );
  }
}
