/** Revision-1 SYQL import graph and predicate-library resolver (§4). */
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  SyqlFrontendError,
  type SyqlSourcePosition,
  type SyqlSourceSpan,
} from './syql-lexer';
import {
  parseSyqlSyntaxFile,
  type SyqlImportDeclaration,
  type SyqlSyntaxFile,
} from './syql-parser';

export type SyqlModuleErrorCode =
  | 'SYQL4001_IMPORT_OUTSIDE_ROOT'
  | 'SYQL4002_MODULE_NOT_FOUND'
  | 'SYQL4003_IMPORT_CYCLE'
  | 'SYQL4004_UNKNOWN_PREDICATE'
  | 'SYQL4005_DUPLICATE_IMPORT_TARGET'
  | 'SYQL4006_DUPLICATE_QUERY';

export type SyqlSourceLoader = (canonicalPath: string) => string | undefined;

export interface SyqlImportEdge {
  readonly from: string;
  readonly to: string;
  readonly declaration: SyqlImportDeclaration;
}

export interface SyqlModuleGraph {
  readonly root: string;
  readonly entries: readonly string[];
  /** Dependency-first deterministic module order. */
  readonly modules: readonly SyqlSyntaxFile[];
  readonly moduleByPath: ReadonlyMap<string, SyqlSyntaxFile>;
  readonly edges: readonly SyqlImportEdge[];
}

function startPosition(): SyqlSourcePosition {
  return { offset: 0, line: 1, column: 1 };
}

function startSpan(file: string): SyqlSourceSpan {
  const position = startPosition();
  return { file, start: position, end: position };
}

function isWithinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  );
}

function displayPath(root: string, file: string): string {
  const path = relative(root, file);
  return path === '' ? '.' : path.split(sep).join('/');
}

class ModuleGraphBuilder {
  readonly #root: string;
  readonly #load: SyqlSourceLoader;
  readonly #moduleByPath = new Map<string, SyqlSyntaxFile>();
  readonly #edges: SyqlImportEdge[] = [];
  readonly #order: SyqlSyntaxFile[] = [];
  readonly #state = new Map<string, 'active' | 'complete'>();
  readonly #stack: string[] = [];
  readonly #queryNames = new Map<string, SyqlSourceSpan>();

  constructor(root: string, load: SyqlSourceLoader) {
    this.#root = resolve(root);
    this.#load = load;
  }

  build(entries: readonly string[]): SyqlModuleGraph {
    const canonicalEntries = entries.map((entry) => this.#entryPath(entry));
    for (const entry of canonicalEntries) this.#visit(entry);
    this.#validateImports();
    this.#validateGlobalQueryNames();
    return {
      root: this.#root,
      entries: canonicalEntries,
      modules: this.#order,
      moduleByPath: this.#moduleByPath,
      edges: this.#edges,
    };
  }

  #entryPath(entry: string): string {
    const candidate = resolve(this.#root, entry);
    if (!isWithinRoot(this.#root, candidate)) {
      this.#fail(
        'SYQL4001_IMPORT_OUTSIDE_ROOT',
        startSpan(candidate),
        `entry ${JSON.stringify(entry)} resolves outside the configured queries root`,
      );
    }
    return candidate;
  }

  #visit(file: string, incoming?: SyqlImportDeclaration): SyqlSyntaxFile {
    const state = this.#state.get(file);
    if (state === 'complete')
      return this.#moduleByPath.get(file) as SyqlSyntaxFile;
    if (state === 'active') {
      const cycleStart = this.#stack.indexOf(file);
      const cycle = [...this.#stack.slice(cycleStart), file]
        .map((item) => displayPath(this.#root, item))
        .join(' -> ');
      this.#fail(
        'SYQL4003_IMPORT_CYCLE',
        incoming?.span ?? startSpan(file),
        `SYQL import cycle: ${cycle}`,
      );
    }

    const source = this.#load(file);
    if (source === undefined) {
      this.#fail(
        'SYQL4002_MODULE_NOT_FOUND',
        incoming?.span ?? startSpan(file),
        `SYQL module not found: ${displayPath(this.#root, file)}`,
      );
    }
    const module = parseSyqlSyntaxFile(file, source);
    this.#moduleByPath.set(file, module);
    this.#state.set(file, 'active');
    this.#stack.push(file);

    for (const declaration of module.imports) {
      const target = resolve(dirname(file), declaration.path);
      if (!isWithinRoot(this.#root, target)) {
        this.#fail(
          'SYQL4001_IMPORT_OUTSIDE_ROOT',
          declaration.span,
          `import ${JSON.stringify(declaration.path)} escapes the configured queries root`,
        );
      }
      this.#edges.push({ from: file, to: target, declaration });
      this.#visit(target, declaration);
    }

    this.#stack.pop();
    this.#state.set(file, 'complete');
    this.#order.push(module);
    return module;
  }

  #validateImports(): void {
    const importedTargetsByModule = new Map<string, Set<string>>();
    for (const edge of this.#edges) {
      const target = this.#moduleByPath.get(edge.to) as SyqlSyntaxFile;
      const predicates = new Set(
        target.predicates.map((predicate) => predicate.name),
      );
      let targets = importedTargetsByModule.get(edge.from);
      if (targets === undefined) {
        targets = new Set();
        importedTargetsByModule.set(edge.from, targets);
      }
      for (const item of edge.declaration.items) {
        const key = `${edge.to}\0${item.imported}`;
        if (targets.has(key)) {
          this.#fail(
            'SYQL4005_DUPLICATE_IMPORT_TARGET',
            item.span,
            `predicate ${JSON.stringify(item.imported)} is imported more than once from ${displayPath(this.#root, edge.to)}`,
          );
        }
        targets.add(key);
        if (!predicates.has(item.imported)) {
          this.#fail(
            'SYQL4004_UNKNOWN_PREDICATE',
            item.span,
            `${displayPath(this.#root, edge.to)} does not export predicate ${JSON.stringify(item.imported)}`,
          );
        }
      }
    }
  }

  #validateGlobalQueryNames(): void {
    for (const module of this.#order) {
      for (const query of module.queries) {
        if (this.#queryNames.has(query.name)) {
          this.#fail(
            'SYQL4006_DUPLICATE_QUERY',
            query.nameSpan,
            `duplicate query name ${JSON.stringify(query.name)} across the configured SYQL graph`,
          );
        }
        this.#queryNames.set(query.name, query.nameSpan);
      }
    }
  }

  #fail(
    code: SyqlModuleErrorCode,
    span: SyqlSourceSpan,
    message: string,
  ): never {
    throw new SyqlFrontendError(code, span, message);
  }
}

/**
 * Parse and resolve every module reachable from the configured entry files.
 * Paths passed to `load` are absolute, normalized paths under `root`.
 */
export function buildSyqlModuleGraph(
  root: string,
  entries: readonly string[],
  load: SyqlSourceLoader,
): SyqlModuleGraph {
  return new ModuleGraphBuilder(root, load).build(entries);
}
