import { useCallback, useEffect, useState } from 'react';

export function useLocalStorage<T>(
  key: string,
  defaultValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return defaultValue;

    try {
      const item = window.localStorage.getItem(key);
      if (item === null) return defaultValue;
      return JSON.parse(item) as T;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      if (value === null || value === undefined) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, JSON.stringify(value));
      }
    } catch {
      // Ignore write errors
    }
  }, [key, value]);

  const setValueWrapper = useCallback((newValue: T | ((prev: T) => T)) => {
    setValue((prev) =>
      typeof newValue === 'function'
        ? (newValue as (prev: T) => T)(prev)
        : newValue
    );
  }, []);

  return [value, setValueWrapper];
}
