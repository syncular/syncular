import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

interface BundleBudgetTarget {
  label: string;
  entrypoint: string;
  namedImports: string[];
  baselineRawKb: number;
  baselineGzipKb: number;
  maxRawKb: number;
  maxGzipKb: number;
}

interface BundleBudgetFile {
  target: BundleBudgetTarget;
}

function roundKb(bytes: number): number {
  return Math.round((bytes / 1024) * 100) / 100;
}

async function buildBundle(target: BundleBudgetTarget, repoRoot: string) {
  const tmpParent = join(repoRoot, '.tmp');
  await mkdir(tmpParent, { recursive: true });
  const tempRoot = await mkdtemp(join(tmpParent, 'bundle-check-'));

  try {
    const resolvedEntrypoint = resolve(repoRoot, target.entrypoint);
    const entryPath = join(tempRoot, 'entry.ts');
    const outdir = join(tempRoot, 'out');
    const entryImportPath = relative(tempRoot, resolvedEntrypoint).replaceAll(
      '\\',
      '/'
    );
    const normalizedImportPath = entryImportPath.startsWith('.')
      ? entryImportPath
      : `./${entryImportPath}`;
    const source = [
      `import { ${target.namedImports.join(', ')} } from ${JSON.stringify(normalizedImportPath)};`,
      `globalThis.__syncularBundleCheck = [${target.namedImports.join(', ')}].length;`,
      'export default globalThis.__syncularBundleCheck;',
      '',
    ].join('\n');

    await writeFile(entryPath, source, 'utf8');

    const result = await Bun.build({
      entrypoints: [entryPath],
      target: 'browser',
      format: 'esm',
      splitting: true,
      minify: true,
      sourcemap: 'none',
      outdir,
    });

    if (!result.success) {
      const message =
        result.logs.map((log) => log.message).join('; ') ||
        'Bundle build failed';
      throw new Error(message);
    }

    let rawBytes = 0;
    let gzipBytes = 0;

    for (const output of result.outputs) {
      if (!output.path.endsWith('.js')) continue;
      const buffer = Buffer.from(await readFile(output.path));
      rawBytes += buffer.byteLength;
      gzipBytes += gzipSync(buffer, { level: 9 }).byteLength;
    }

    return {
      rawKb: roundKb(rawBytes),
      gzipKb: roundKb(gzipBytes),
      artifactCount: result.outputs.filter((output) =>
        output.path.endsWith('.js')
      ).length,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const repoRoot = resolve(import.meta.dir, '..');
  const budgetPath = join(repoRoot, 'config', 'bundle-budget.json');
  const budget = JSON.parse(
    await readFile(budgetPath, 'utf8')
  ) as BundleBudgetFile;
  const measured = await buildBundle(budget.target, repoRoot);

  const failures: string[] = [];
  if (measured.rawKb > budget.target.maxRawKb) {
    failures.push(
      `raw size ${measured.rawKb} KB exceeds max ${budget.target.maxRawKb} KB`
    );
  }
  if (measured.gzipKb > budget.target.maxGzipKb) {
    failures.push(
      `gzip size ${measured.gzipKb} KB exceeds max ${budget.target.maxGzipKb} KB`
    );
  }

  const report = [
    `Bundle target: ${budget.target.label}`,
    `Entry: ${budget.target.entrypoint}`,
    `Named imports: ${budget.target.namedImports.join(', ')}`,
    `Artifacts: ${measured.artifactCount}`,
    `Raw: ${measured.rawKb} KB (baseline ${budget.target.baselineRawKb} KB, max ${budget.target.maxRawKb} KB, delta ${(measured.rawKb - budget.target.baselineRawKb).toFixed(2)} KB)`,
    `Gzip: ${measured.gzipKb} KB (baseline ${budget.target.baselineGzipKb} KB, max ${budget.target.maxGzipKb} KB, delta ${(measured.gzipKb - budget.target.baselineGzipKb).toFixed(2)} KB)`,
  ];

  console.log(report.join('\n'));

  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }
}

await main();
