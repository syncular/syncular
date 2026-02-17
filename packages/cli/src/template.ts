import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Eta } from 'eta';

const templateEngine = new Eta({ autoEscape: false, autoTrim: false });

export async function readTemplate(name: string): Promise<string> {
  const url = new URL(`../templates/${name}`, import.meta.url);
  return readFile(url, 'utf8');
}

export function renderTemplate(
  template: string,
  values: Record<string, string>
): string {
  const output = templateEngine.renderString(template, values);
  if (typeof output !== 'string') {
    throw new Error('Failed to render template.');
  }
  return output;
}

export async function writeFileIfAllowed(args: {
  targetPath: string;
  content: string;
  force: boolean;
}): Promise<'created' | 'updated' | 'skipped'> {
  const fileExists = existsSync(args.targetPath);
  if (fileExists && !args.force) {
    return 'skipped';
  }

  await mkdir(dirname(args.targetPath), { recursive: true });
  await writeFile(args.targetPath, args.content, 'utf8');
  return fileExists ? 'updated' : 'created';
}
