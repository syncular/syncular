import type { SyncularNetworkStatusSource } from './types';

export function browserSyncularNetworkStatusSource():
  | SyncularNetworkStatusSource
  | undefined {
  const target = globalThis as unknown as {
    navigator?: { onLine?: boolean };
    addEventListener?: (
      type: string,
      listener: EventListenerOrEventListenerObject
    ) => void;
    removeEventListener?: (
      type: string,
      listener: EventListenerOrEventListenerObject
    ) => void;
  };
  if (
    typeof target.navigator?.onLine !== 'boolean' &&
    (!target.addEventListener || !target.removeEventListener)
  ) {
    return undefined;
  }
  return {
    isOnline: () => target.navigator?.onLine,
    addEventListener: target.addEventListener
      ? (type, listener) => target.addEventListener?.(type, listener)
      : undefined,
    removeEventListener: target.removeEventListener
      ? (type, listener) => target.removeEventListener?.(type, listener)
      : undefined,
  };
}
