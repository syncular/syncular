/** Names and probe shape shared by the browser local-authority test files. */
export const LOCAL_AUTHORITY_DATABASE = 'local-authority-browser';

/** What the worker observed of its OPFS pool and authority database. */
export interface LocalAuthorityProbe {
  /** The replica pool's file names, sorted. */
  files: string[];
  /** The authority database's tables, sorted. */
  authorityTables: string[];
}
