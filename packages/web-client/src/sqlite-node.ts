import type { ClientDatabase } from './database';
import { openNodeDatabase } from './node-database';

export function openSqliteDatabase(path = ':memory:'): ClientDatabase {
  return openNodeDatabase(path);
}
