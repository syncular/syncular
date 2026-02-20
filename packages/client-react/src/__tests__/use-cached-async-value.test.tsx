import { describe, expect, it } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { StrictMode } from 'react';
import {
  clearCachedAsyncValues,
  useCachedAsyncValue,
} from '../use-cached-async-value';

function strictModeWrapper(props: { children: ReactNode }) {
  return <StrictMode>{props.children}</StrictMode>;
}

describe('useCachedAsyncValue', () => {
  it('deduplicates StrictMode initialization by key', async () => {
    clearCachedAsyncValues();
    let runs = 0;

    const { result } = renderHook(
      () =>
        useCachedAsyncValue(
          async () => {
            runs += 1;
            return 'ready';
          },
          { key: 'strictmode-init' }
        ),
      { wrapper: strictModeWrapper }
    );

    await waitFor(() => {
      expect(result.current[0]).toBe('ready');
    });
    expect(result.current[1]).toBeNull();
    expect(runs).toBe(1);
  });

  it('retries after a failure when dependencies trigger rerun', async () => {
    clearCachedAsyncValues();
    let runs = 0;

    const { result, rerender } = renderHook(
      ({ attempt }: { attempt: number }) =>
        useCachedAsyncValue(
          async () => {
            runs += 1;
            if (attempt === 0) {
              throw new Error('boom');
            }
            return 'recovered';
          },
          {
            key: 'retryable-init',
            deps: [attempt],
          }
        ),
      {
        initialProps: { attempt: 0 },
      }
    );

    await waitFor(() => {
      expect(result.current[1]?.message).toBe('boom');
    });

    rerender({ attempt: 1 });

    await waitFor(() => {
      expect(result.current[0]).toBe('recovered');
    });
    expect(result.current[1]).toBeNull();
    expect(runs).toBe(2);
  });

  it('reuses cached values across component remounts', async () => {
    clearCachedAsyncValues();
    let runs = 0;

    const first = renderHook(() =>
      useCachedAsyncValue(
        async () => {
          runs += 1;
          return 7;
        },
        { key: 'shared-init' }
      )
    );

    await waitFor(() => {
      expect(first.result.current[0]).toBe(7);
    });
    first.unmount();

    const second = renderHook(() =>
      useCachedAsyncValue(
        async () => {
          runs += 1;
          return 9;
        },
        { key: 'shared-init' }
      )
    );

    await waitFor(() => {
      expect(second.result.current[0]).toBe(7);
    });
    expect(second.result.current[1]).toBeNull();
    expect(runs).toBe(1);
    second.unmount();
  });
});
