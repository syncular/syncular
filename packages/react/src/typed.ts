/**
 * `@syncular/react/typed` — the Kysely-typed live-query hook, kept behind
 * this subpath so the main barrel never imports Kysely. Requires the
 * `@syncular/kysely` and `kysely` peer dependencies.
 */
export { useTypedQuery } from './use-typed-query';
