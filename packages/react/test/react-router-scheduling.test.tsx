import { afterEach, describe, expect, test } from 'bun:test';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import {
  createBrowserRouter,
  RouterProvider,
  useSearchParams,
} from 'react-router-dom';
import { SyncProvider } from '../src/provider';
import { useSyncStatus } from '../src/use-sync-status';
import { FakeClient } from './fake-client';
import { installHappyDom } from './setup';

installHappyDom();

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

function RouteStateProbe() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = useSyncStatus();
  const selected = searchParams.get('mode') ?? 'plan';
  return (
    <main>
      <output aria-label="outbox">{status.outbox}</output>
      {(['plan', 'timeline'] as const).map((mode) => (
        <label key={mode}>
          <input
            type="radio"
            name="mode"
            value={mode}
            checked={selected === mode}
            onChange={() => setSearchParams({ mode })}
          />
          {mode}
        </label>
      ))}
      <output aria-label="rendered-location">{selected}</output>
    </main>
  );
}

describe('React Router scheduling integration fixture', () => {
  test('keeps controls, router state, and the browser URL converged under sustained Syncular updates', async () => {
    (
      window as Window & {
        readonly happyDOM: { setURL(url: string): void };
      }
    ).happyDOM.setURL('http://localhost/');
    window.history.replaceState(null, '', '/?mode=plan');
    const client = new FakeClient();
    const router = createBrowserRouter([
      {
        path: '/',
        element: (
          <SyncProvider client={client}>
            <RouteStateProbe />
          </SyncProvider>
        ),
      },
    ]);
    const view = render(
      <RouterProvider router={router} useTransitions={false} />,
    );

    for (let round = 0; round < 24; round += 1) {
      const mode = round % 2 === 0 ? 'timeline' : 'plan';
      await act(async () => {
        client.setPending(
          Array.from({ length: round % 4 }, (_, index) => index),
        );
        client.emitStatus();
        fireEvent.click(view.getByRole('radio', { name: mode }));
        for (let burst = 0; burst < 8; burst += 1) client.emitStatus();
      });
      await waitFor(() => {
        expect(
          (view.getByRole('radio', { name: mode }) as HTMLInputElement).checked,
        ).toBe(true);
        expect(view.getByLabelText('rendered-location').textContent).toBe(mode);
        expect(router.state.location.search).toBe(`?mode=${mode}`);
        expect(window.location.search).toBe(`?mode=${mode}`);
      });
    }

    view.unmount();
    router.dispose();
  });
});
