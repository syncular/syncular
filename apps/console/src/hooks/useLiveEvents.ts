/**
 * Hook for WebSocket live events from the console API
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveEvent } from '@/lib/types';
import { useConnection } from './ConnectionContext';

interface UseLiveEventsOptions {
  /** Maximum number of events to keep in the buffer */
  maxEvents?: number;
  /** Whether to connect automatically */
  enabled?: boolean;
}

interface UseLiveEventsResult {
  /** Recent events (newest first) */
  events: LiveEvent[];
  /** Whether currently connected to the WebSocket */
  isConnected: boolean;
  /** Any error that occurred */
  error: Error | null;
  /** Clear all events from the buffer */
  clearEvents: () => void;
}

export function useLiveEvents(
  options: UseLiveEventsOptions = {}
): UseLiveEventsResult {
  const { maxEvents = 100, enabled = true } = options;
  const { config, isConnected: apiConnected } = useConnection();
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  useEffect(() => {
    if (!enabled || !apiConnected || !config?.serverUrl || !config?.token) {
      return;
    }

    // Construct the WebSocket URL
    const baseUrl = config.serverUrl.replace(/\/$/, '');
    // Convert http(s) to ws(s)
    const wsBaseUrl = baseUrl.replace(/^http/, 'ws');
    const wsUrl = `${wsBaseUrl}/console/events/live?token=${config.token}`;

    let isCleanedUp = false;

    const connect = () => {
      if (isCleanedUp) return;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (isCleanedUp) {
          ws.close();
          return;
        }
        setIsConnected(true);
        setError(null);
      };

      ws.onclose = () => {
        if (isCleanedUp) return;
        setIsConnected(false);

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (!isCleanedUp) {
            connect();
          }
        }, 3000);
      };

      ws.onerror = () => {
        if (isCleanedUp) return;
        setError(new Error('WebSocket connection failed'));
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          const eventType = data.type;

          // Skip control events
          if (eventType === 'connected' || eventType === 'heartbeat') {
            return;
          }

          const liveEvent: LiveEvent = {
            type: eventType as LiveEvent['type'],
            timestamp: data.timestamp || new Date().toISOString(),
            data,
          };

          setEvents((prev) => {
            const newEvents = [liveEvent, ...prev];
            return newEvents.slice(0, maxEvents);
          });
        } catch {
          // Ignore parse errors
        }
      };
    };

    connect();

    return () => {
      isCleanedUp = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setIsConnected(false);
    };
  }, [enabled, apiConnected, config?.serverUrl, config?.token, maxEvents]);

  return {
    events,
    isConnected,
    error,
    clearEvents,
  };
}
