function createDemoIdentitySeed(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getBrowserStorage(kind: 'local' | 'session'): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function getOrCreateStorageSeed(storage: Storage, storageKey: string): string {
  const existing = storage.getItem(storageKey);
  if (existing) return existing;

  const created = createDemoIdentitySeed();
  storage.setItem(storageKey, created);
  return created;
}

export function getPersistentDemoActorSeed(storageKey: string): string {
  const storage = getBrowserStorage('local');
  if (!storage) return 'server';
  return getOrCreateStorageSeed(storage, storageKey);
}

export function getPerTabDemoClientSeed(storageKey: string): string {
  const storage = getBrowserStorage('session');
  if (!storage) return createDemoIdentitySeed();
  return getOrCreateStorageSeed(storage, storageKey);
}
