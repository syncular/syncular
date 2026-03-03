/**
 * Hook for WebSocket live events from the console API
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveEvent } from '../lib/types';
import { useConnection } from './ConnectionContext';
import { useInstanceContext } from './useInstanceContext';

interface UseLiveEventsOptions {
  /** Maximum number of events to keep in the buffer */
  maxEvents?: number;
  /** Whether to connect automatically */
  enabled?: boolean;
  /** Mark socket stale when no control/data messages are received in this window */
  staleAfterMs?: number;
  /** Maximum number of server replayed events per reconnect (1-500) */
  replayLimit?: number;
  /** Optional partition filter for emitted events */
  partitionId?: string;
  /** Optional instance filter for emitted events */
  instanceId?: string;
}

interface UseLiveEventsResult {
  /** Recent events (newest first) */
  events: LiveEvent[];
  /** Whether currently connected to the WebSocket */
  isConnected: boolean;
  /** Connection lifecycle state */
  connectionState: 'connecting' | 'connected' | 'stale' | 'disconnected';
  /** Any error that occurred */
  error: Error | null;
  /** Clear all events from the buffer */
  clearEvents: () => void;
}

export function useLiveEvents(
  options: UseLiveEventsOptions = {}
): UseLiveEventsResult {
  const {
    maxEvents = 100,
    enabled = true,
    staleAfterMs = 65_000,
    replayLimit = 100,
    partitionId,
    instanceId,
  } = options;
  const { config, isConnected: apiConnected } = useConnection();
  const { instanceId: selectedInstanceId } = useInstanceContext();
  const effectiveInstanceId = instanceId ?? selectedInstanceId;
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<
    'connecting' | 'connected' | 'stale' | 'disconnected'
  >('disconnected');
  const [error, setError] = useState<Error | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const staleCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  );
  const reconnectAttemptsRef = useRef(0);
  const lastActivityAtRef = useRef(0);
  const lastEventTimestampRef = useRef<string | null>(null);

  const clearEvents = useCallback(() => {
    setEvents([]);
    lastEventTimestampRef.current = null;
  }, []);

  useEffect(() => {
    if (!enabled || !apiConnected || !config?.serverUrl || !config?.token) {
      return;
    }

    let isCleanedUp = false;
    const normalizedReplayLimit = Number.isFinite(replayLimit)
      ? Math.max(1, Math.min(500, Math.floor(replayLimit)))
      : 100;
    if (typeof WebSocket === 'undefined') return;

    const clearReconnectTimeout = () => {
      if (!reconnectTimeoutRef.current) return;
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    };

    const clearStaleInterval = () => {
      if (!staleCheckIntervalRef.current) return;
      clearInterval(staleCheckIntervalRef.current);
      staleCheckIntervalRef.current = null;
    };

    const scheduleReconnect = () => {
      if (isCleanedUp || reconnectTimeoutRef.current) return;
      reconnectAttemptsRef.current += 1;
      const baseDelayMs = Math.min(
        30_000,
        1_000 * 2 ** Math.max(0, reconnectAttemptsRef.current - 1)
      );
      const jitterMs = Math.floor(baseDelayMs * 0.2 * Math.random());
      const delayMs = baseDelayMs + jitterMs;
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null;
        if (!isCleanedUp) {
          connect();
        }
      }, delayMs);
    };

    const markActivity = () => {
      lastActivityAtRef.current = Date.now();
      setIsConnected(true);
      setConnectionState('connected');
    };

    const connect = () => {
      if (isCleanedUp) return;
      setConnectionState('connecting');
      clearReconnectTimeout();

      const wsUrl = (() => {
        const baseUrl = new URL(config.serverUrl, window.location.origin);
        baseUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        const normalizedPath = baseUrl.pathname.endsWith('/')
          ? baseUrl.pathname.slice(0, -1)
          : baseUrl.pathname;
        baseUrl.pathname = `${normalizedPath}/console/events/live`;
        baseUrl.search = '';
        if (lastEventTimestampRef.current) {
          baseUrl.searchParams.set('since', lastEventTimestampRef.current);
        }
        baseUrl.searchParams.set('replayLimit', String(normalizedReplayLimit));
        if (partitionId) {
          baseUrl.searchParams.set('partitionId', partitionId);
        }
        if (effectiveInstanceId) {
          baseUrl.searchParams.set('instanceId', effectiveInstanceId);
        }
        return baseUrl.toString();
      })();

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (isCleanedUp) {
          ws.close();
          return;
        }
        reconnectAttemptsRef.current = 0;
        setError(null);
        setConnectionState('connecting');
        setIsConnected(false);

        try {
          ws.send(
            JSON.stringify({
              type: 'auth',
              token: config.token,
            })
          );
        } catch {
          ws.close();
          return;
        }

        clearStaleInterval();
        staleCheckIntervalRef.current = setInterval(() => {
          const socket = wsRef.current;
          if (!socket || socket.readyState !== WebSocket.OPEN) return;
          const lastActivityAt = lastActivityAtRef.current;
          if (!lastActivityAt) return;
          const elapsedMs = Date.now() - lastActivityAt;
          if (elapsedMs <= staleAfterMs) return;

          setIsConnected(false);
          setConnectionState('stale');
          socket.close();
        }, 1000);
      };

      ws.onclose = () => {
        if (isCleanedUp) return;
        setIsConnected(false);
        setConnectionState('disconnected');
        clearStaleInterval();
        scheduleReconnect();
      };

      ws.onerror = () => {
        if (isCleanedUp) return;
        setError(new Error('WebSocket connection failed'));
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          const eventType = data.type;
          markActivity();

          // Skip control events
          if (
            eventType === 'connected' ||
            eventType === 'heartbeat' ||
            eventType === 'auth_required'
          ) {
            return;
          }
          if (eventType === 'error') {
            const message =
              typeof data.message === 'string'
                ? data.message
                : 'Live events authentication failed';
            setError(new Error(message));
            return;
          }

          const liveEvent: LiveEvent = {
            type: eventType as LiveEvent['type'],
            timestamp: data.timestamp || new Date().toISOString(),
            data,
          };

          if (partitionId && liveEvent.data.partitionId !== partitionId) {
            return;
          }
          if (
            effectiveInstanceId &&
            liveEvent.data.instanceId !== effectiveInstanceId
          ) {
            return;
          }

          const lastEventTimestampMs = Date.parse(
            lastEventTimestampRef.current ?? ''
          );
          const liveEventTimestampMs = Date.parse(liveEvent.timestamp);
          if (
            Number.isFinite(liveEventTimestampMs) &&
            (!Number.isFinite(lastEventTimestampMs) ||
              liveEventTimestampMs > lastEventTimestampMs)
          ) {
            lastEventTimestampRef.current = liveEvent.timestamp;
          }

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
      clearReconnectTimeout();
      clearStaleInterval();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setIsConnected(false);
      setConnectionState('disconnected');
    };
  }, [
    enabled,
    apiConnected,
    config?.serverUrl,
    config?.token,
    maxEvents,
    partitionId,
    effectiveInstanceId,
    replayLimit,
    staleAfterMs,
  ]);

  return {
    events,
    isConnected,
    connectionState,
    error,
    clearEvents,
  };
}
