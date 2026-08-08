import { openBunDatabase } from './bun-database';
import type { ClientDatabase } from './database';

export function openSqliteDatabase(path = ':memory:'): ClientDatabase {
  return openBunDatabase(path);
}
