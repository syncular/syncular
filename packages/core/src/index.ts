/**
 * @syncular/core — reference SSP2 codec (SPEC.md is normative).
 *
 * Dependency-free: primitives (Conventions), envelope + framing (§1),
 * schema-IR row codec (§2.4), SSG2 rows segments (§5.2), message codecs
 * (§1.5/§1.6), realtime control messages (§8), the §11 canonical JSON
 * debug rendering, and §11.2 canonical JSON for digests.
 */
export * from './blob-ref';
export * from './bytes';
export * from './canonical-json';
export * from './constants';
export * from './crypto';
export * from './errors';
export * from './frames';
export * from './message';
export * from './realtime';
export * from './rejection-details';
export * from './relational-identifier';
export * from './render';
export * from './row-codec';
export * from './segment';
export * from './stream';
