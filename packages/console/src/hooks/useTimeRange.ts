/**
 * Global time range context for dashboard charts
 */

import { createContext } from 'react';
import type { TimeseriesRange } from '../lib/types';
import { useLocalStorage } from './useLocalStorage';

interface TimeRangeContextValue {
  /** Current time range */
  range: TimeseriesRange;
  /** Set the time range */
  setRange: (range: TimeseriesRange) => void;
}

export const TimeRangeContext = createContext<TimeRangeContextValue | null>(
  null
);

/**
 * Hook to create time range state with localStorage persistence.
 * Use this at the provider level.
 */
export function useTimeRangeState(): TimeRangeContextValue {
  const [range, setRange] = useLocalStorage<TimeseriesRange>(
    'console:time-range',
    '24h'
  );

  return {
    range,
    setRange,
  };
}
