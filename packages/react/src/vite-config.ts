/**
 * First-party Syncular browser packages are already ESM. Keeping them out of
 * Vite's dependency optimizer prevents a live worker from referring to a
 * retired hashed optimizer chunk after a package upgrade.
 */
export const SYNCULAR_VITE_OPTIMIZE_DEPS_EXCLUDE = [
  '@syncular/client',
  '@syncular/client/worker',
  '@syncular/core',
  '@syncular/crypto',
  '@syncular/react',
] as const;
