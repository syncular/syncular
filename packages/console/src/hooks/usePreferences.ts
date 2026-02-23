/**
 * UI preferences hook with localStorage persistence
 */

import { useLocalStorage } from './useLocalStorage';

interface ConsolePreferences {
  /** Refresh interval for auto-updating data (in seconds) */
  refreshInterval: number;
  /** Time format: 'relative' (e.g., "5 minutes ago") or 'absolute' (e.g., "2024-01-15 10:30") */
  timeFormat: 'relative' | 'absolute';
  /** Show sparklines in stats cards */
  showSparklines: boolean;
  /** Number of items per page in tables */
  pageSize: number;
}

const DEFAULT_PREFERENCES: ConsolePreferences = {
  refreshInterval: 5,
  timeFormat: 'relative',
  showSparklines: true,
  pageSize: 20,
};

export function usePreferences() {
  const [preferences, setPreferences] = useLocalStorage<ConsolePreferences>(
    'console:preferences',
    DEFAULT_PREFERENCES
  );

  const updatePreference = <K extends keyof ConsolePreferences>(
    key: K,
    value: ConsolePreferences[K]
  ) => {
    setPreferences((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const resetPreferences = () => {
    setPreferences(DEFAULT_PREFERENCES);
  };

  return {
    preferences,
    setPreferences,
    updatePreference,
    resetPreferences,
  };
}

/**
 * Available refresh interval options
 */
export const REFRESH_INTERVAL_OPTIONS = [
  { value: 5, label: '5 seconds' },
  { value: 10, label: '10 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 0, label: 'Manual only' },
];

/**
 * Available page size options
 */
export const PAGE_SIZE_OPTIONS = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
  { value: 100, label: '100' },
];
