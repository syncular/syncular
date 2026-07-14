import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packagePath = fileURLToPath(
  new URL('../../../package.json', import.meta.url),
);
const rootPackage = JSON.parse(readFileSync(packagePath, 'utf8'));

if (
  typeof rootPackage.version !== 'string' ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    rootPackage.version,
  ) ||
  rootPackage.version === '0.0.0'
) {
  throw new Error('root package.json must contain the release version');
}

export const releaseVersion = rootPackage.version;
export const reflectReleaseVersion = (text) =>
  text.replaceAll('0.0.0', releaseVersion);
