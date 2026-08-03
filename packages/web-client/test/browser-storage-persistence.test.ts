import { afterEach, describe, expect, test } from 'bun:test';
import {
  checkBrowserStoragePersistence,
  requestBrowserStoragePersistence,
} from '@syncular/client';

const navigatorDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  'navigator',
);

afterEach(() => {
  if (navigatorDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, 'navigator');
  } else {
    Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  }
});

function installStorage(storage?: {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: storage === undefined ? {} : { storage },
  });
}

describe('browser storage persistence', () => {
  test('checks persistent, best-effort, unavailable, and failed states', async () => {
    installStorage({ persisted: async () => true });
    expect(await checkBrowserStoragePersistence()).toEqual({
      state: 'persistent',
    });

    installStorage({ persisted: async () => false });
    expect(await checkBrowserStoragePersistence()).toEqual({
      state: 'best-effort',
      reason: 'not-granted',
    });

    installStorage();
    expect(await checkBrowserStoragePersistence()).toEqual({
      state: 'best-effort',
      reason: 'unavailable',
    });

    installStorage({
      persisted: () => Promise.reject(new Error('private browser detail')),
    });
    expect(await checkBrowserStoragePersistence()).toEqual({
      state: 'best-effort',
      reason: 'check-failed',
    });
  });

  test('reports granted and denied persistence requests', async () => {
    installStorage({
      persist: async () => true,
    });
    expect(await requestBrowserStoragePersistence()).toEqual({
      state: 'persistent',
    });

    installStorage({
      persist: async () => false,
    });
    expect(await requestBrowserStoragePersistence()).toEqual({
      state: 'best-effort',
      reason: 'not-granted',
    });
  });

  test('reports unavailable and request failure precisely', async () => {
    installStorage();
    expect(await requestBrowserStoragePersistence()).toEqual({
      state: 'best-effort',
      reason: 'unavailable',
    });

    installStorage({
      persist: () => Promise.reject(new Error('request failed')),
    });
    expect(await requestBrowserStoragePersistence()).toEqual({
      state: 'best-effort',
      reason: 'request-failed',
    });
  });
});
