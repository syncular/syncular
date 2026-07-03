/**
 * `SyncProvider` — supplies a `SyncClient` or `SyncClientHandle` to the
 * hook tree through React context. One provider per client; the hooks read
 * the normalized facade. Written with `createElement` (no JSX) so the whole
 * package typechecks under the repo's `.ts`-only root tsconfig with no jsx
 * setting — the bindings are plain function components either way.
 */
import { createContext, createElement, type ReactNode, useMemo } from 'react';
import {
  type NormalizedClient,
  normalizeClient,
  type SyncClientLike,
} from './client';

export const SyncContext = createContext<NormalizedClient | undefined>(
  undefined,
);

export interface SyncProviderProps {
  /** A `SyncClient` (direct) or `SyncClientHandle` (worker) — both satisfy it. */
  readonly client: SyncClientLike;
  readonly children?: ReactNode;
}

export function SyncProvider(props: SyncProviderProps): ReactNode {
  // Re-normalize only when the client identity changes.
  const normalized = useMemo(
    () => normalizeClient(props.client),
    [props.client],
  );
  return createElement(
    SyncContext.Provider,
    { value: normalized },
    props.children,
  );
}
