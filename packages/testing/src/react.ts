/**
 * React helper for the test kit (`@syncular/testkit/react`).
 *
 * `@syncular/react`'s `SyncProvider` already accepts any `SyncClient`, so
 * mounting hooks against a test client is just:
 *
 *     <SyncProvider client={testClient.api}>…</SyncProvider>
 *
 * This module is the tiny convenience over that pattern: `syncWrapper`
 * returns the `wrapper` prop `@testing-library/react`'s `renderHook` /
 * `render` want, so a test never hand-writes the provider element.
 *
 *     import { renderHook, waitFor } from '@testing-library/react';
 *     import { useRawSql } from '@syncular/react';
 *     import { createTestSync } from '@syncular/testkit';
 *     import { syncWrapper } from '@syncular/testkit/react';
 *
 *     const sync = await createTestSync({ schema });
 *     const client = await sync.client('a');
 *     const { result } = renderHook(
 *       () => useRawSql('SELECT * FROM notes'),
 *       { wrapper: syncWrapper(client) },
 *     );
 *
 * `react` is an OPTIONAL peer of the kit: import this subpath only from a
 * test that already depends on React. The core (`@syncular/testkit`)
 * pulls in no React.
 *
 * NOTE: this file uses `createElement` (no JSX) so the kit typechecks under
 * the repo's `.ts`-only root tsconfig — same posture as `SyncProvider`.
 */
import { SyncProvider } from '@syncular/react';
import { createElement, type ReactNode } from 'react';
import type { TestClient } from './client';

/**
 * Build the `wrapper` component `renderHook` / `render` take, providing the
 * given test client to the Syncular hook tree. Pass a `TestClient` — its
 * `.api` (the real `SyncClient`) is supplied to `SyncProvider`.
 */
export function syncWrapper(
  client: TestClient,
): (props: { children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(SyncProvider, { client: client.api }, children);
}
