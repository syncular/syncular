import { useRef } from 'react';

export function useKeyedConstant<Key, Value>(
  key: Key,
  create: () => Value
): Value {
  const slotRef = useRef<{ key: Key; value: Value } | null>(null);

  if (slotRef.current === null || !Object.is(slotRef.current.key, key)) {
    slotRef.current = { key, value: create() };
  }

  return slotRef.current.value;
}
