import { describe, expect, it } from 'bun:test';
import { createAsyncInitRegistry } from '../async-init-registry';

describe('createAsyncInitRegistry', () => {
  it('runs initializer once per key and shares the same result', async () => {
    const registry = createAsyncInitRegistry<string, string>();
    let runs = 0;

    const first = registry.run('client-a', async () => {
      runs += 1;
      return 'ok';
    });
    const second = registry.run('client-a', async () => {
      runs += 1;
      return 'unexpected';
    });

    await expect(first).resolves.toBe('ok');
    await expect(second).resolves.toBe('ok');
    expect(runs).toBe(1);
  });

  it('evicts failed initializers so retry can succeed', async () => {
    const registry = createAsyncInitRegistry<string, string>();
    let runs = 0;

    await expect(
      registry.run('client-a', async () => {
        runs += 1;
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    await expect(
      registry.run('client-a', async () => {
        runs += 1;
        return 'recovered';
      })
    ).resolves.toBe('recovered');

    expect(runs).toBe(2);
  });

  it('supports explicit invalidation', async () => {
    const registry = createAsyncInitRegistry<string, number>();
    let seed = 0;

    await expect(
      registry.run('client-a', async () => {
        seed += 1;
        return seed;
      })
    ).resolves.toBe(1);

    registry.invalidate('client-a');

    await expect(
      registry.run('client-a', async () => {
        seed += 1;
        return seed;
      })
    ).resolves.toBe(2);
  });
});
