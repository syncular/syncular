/**
 * `@syncular-v2/react/typed` — the Kysely-typed live-query hook, kept behind
 * this subpath so the main barrel never imports Kysely. Requires the
 * `@syncular-v2/kysely` and `kysely` peer dependencies.
 */
export { useTypedQuery } from './use-typed-query';
