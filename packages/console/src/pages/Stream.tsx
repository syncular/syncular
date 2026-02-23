import type { FilterGroup, StreamOperation } from '@syncular/ui';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FilterBar,
  Pagination,
  Spinner,
  StreamLog,
} from '@syncular/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useClearEventsMutation,
  useCommitDetail,
  usePartitionContext,
  usePreferences,
  useRequestEventDetail,
  useRequestEventPayload,
  useTimeline,
  useTimeRangeState,
} from '../hooks';
import type { ConsoleTimelineItem, TimeseriesRange } from '../lib/types';

type ViewMode = 'all' | 'commits' | 'events';
type EventTypeFilter = 'all' | 'push' | 'pull';
type OutcomeFilter = 'all' | 'applied' | 'error' | 'rejected';

function formatTime(iso: string, timeFormat: 'relative' | 'absolute'): string {
  if (timeFormat === 'absolute') {
    return new Date(iso).toLocaleString();
  }

  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffS = Math.floor(diffMs / 1000);

  if (diffS < 60) return `${diffS}s`;
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m`;
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h`;
  return `${Math.floor(diffS / 86400)}d`;
}

interface StreamSearchTokens {
  actorId?: string;
  clientId?: string;
  table?: string;
  requestId?: string;
  traceId?: string;
  search?: string;
}

function parseStreamSearchTokens(value: string): StreamSearchTokens {
  const tokens = value
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const parsed: StreamSearchTokens = {};
  const freeTextTokens: string[] = [];

  for (const token of tokens) {
    const [rawPrefix = '', ...rest] = token.split(':');
    const tokenValue = rest.join(':').trim();
    const normalizedPrefix = rawPrefix.toLowerCase();

    if (!tokenValue) {
      freeTextTokens.push(token);
      continue;
    }

    if (normalizedPrefix === 'actor') {
      parsed.actorId = tokenValue;
      continue;
    }
    if (normalizedPrefix === 'client') {
      parsed.clientId = tokenValue;
      continue;
    }
    if (normalizedPrefix === 'table') {
      parsed.table = tokenValue;
      continue;
    }
    if (normalizedPrefix === 'request') {
      parsed.requestId = tokenValue;
      continue;
    }
    if (normalizedPrefix === 'trace') {
      parsed.traceId = tokenValue;
      continue;
    }

    freeTextTokens.push(token);
  }

  if (freeTextTokens.length > 0) {
    parsed.search = freeTextTokens.join(' ');
  }

  return parsed;
}

function rangeToWindowMs(range: TimeseriesRange): number {
  if (range === '1h') return 60 * 60 * 1000;
  if (range === '6h') return 6 * 60 * 60 * 1000;
  if (range === '24h') return 24 * 60 * 60 * 1000;
  if (range === '7d') return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resolveCommitEntryId(
  commit: ConsoleTimelineItem['commit'],
  sourceInstanceId: string | undefined
): string {
  if (!commit) return '#?';
  const token =
    commit.federatedCommitId ??
    (sourceInstanceId
      ? `${sourceInstanceId}:${commit.commitSeq}`
      : String(commit.commitSeq));
  return `#${token}`;
}

function resolveEventEntryId(
  event: ConsoleTimelineItem['event'],
  sourceInstanceId: string | undefined
): string {
  if (!event) return 'E?';
  const token =
    event.federatedEventId ??
    (sourceInstanceId ? `${sourceInstanceId}:${event.eventId}` : event.eventId);
  return `E${token}`;
}

function buildTraceUrl(
  template: string | undefined,
  traceId: string | null,
  spanId: string | null
): string | null {
  if (!template || !traceId) return null;
  return template
    .replaceAll('{traceId}', encodeURIComponent(traceId))
    .replaceAll('{spanId}', encodeURIComponent(spanId ?? ''));
}

interface StreamProps {
  initialSelectedEntryId?: string;
}

export function Stream({ initialSelectedEntryId }: StreamProps = {}) {
  const { preferences } = usePreferences();
  const { partitionId } = usePartitionContext();
  const { range, setRange } = useTimeRangeState();
  const pageSize = preferences.pageSize;
  const refreshIntervalMs = preferences.refreshInterval * 1000;
  const traceUrlTemplate: string | undefined = (
    import.meta as ImportMeta & {
      env?: { VITE_CONSOLE_TRACE_URL_TEMPLATE?: string };
    }
  ).env?.VITE_CONSOLE_TRACE_URL_TEMPLATE;

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (initialSelectedEntryId?.startsWith('#')) return 'commits';
    if (initialSelectedEntryId?.startsWith('E')) return 'events';
    return 'all';
  });
  const [eventTypeFilter, setEventTypeFilter] =
    useState<EventTypeFilter>('all');
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>('all');
  const [searchValue, setSearchValue] = useState('');
  const [page, setPage] = useState(1);

  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(
    initialSelectedEntryId ?? null
  );
  const hasHandledInitialSelectionReset = useRef(false);

  const parsedSearch = useMemo(
    () => parseStreamSearchTokens(searchValue),
    [searchValue]
  );
  const from = useMemo(
    () => new Date(Date.now() - rangeToWindowMs(range)).toISOString(),
    [range]
  );

  const {
    data: timelineData,
    isLoading: timelineLoading,
    refetch: refetchTimeline,
  } = useTimeline(
    {
      limit: pageSize,
      offset: (page - 1) * pageSize,
      ...(partitionId ? { partitionId } : {}),
      view: viewMode,
      ...(viewMode !== 'commits' && eventTypeFilter !== 'all'
        ? { eventType: eventTypeFilter }
        : {}),
      ...(viewMode !== 'commits' && outcomeFilter !== 'all'
        ? { outcome: outcomeFilter }
        : {}),
      ...(parsedSearch.actorId ? { actorId: parsedSearch.actorId } : {}),
      ...(parsedSearch.clientId ? { clientId: parsedSearch.clientId } : {}),
      ...(parsedSearch.requestId ? { requestId: parsedSearch.requestId } : {}),
      ...(parsedSearch.traceId ? { traceId: parsedSearch.traceId } : {}),
      ...(parsedSearch.table ? { table: parsedSearch.table } : {}),
      ...(parsedSearch.search ? { search: parsedSearch.search } : {}),
      from,
    },
    { refetchIntervalMs: refreshIntervalMs }
  );

  const clearEvents = useClearEventsMutation();

  const selectedCommitRef = selectedEntryId?.startsWith('#')
    ? selectedEntryId.slice(1)
    : undefined;
  const selectedEventRef = selectedEntryId?.startsWith('E')
    ? selectedEntryId.slice(1)
    : undefined;
  const normalizedSelectedCommitRef =
    selectedCommitRef && selectedCommitRef !== '?'
      ? selectedCommitRef
      : undefined;
  const normalizedSelectedEventRef =
    selectedEventRef && selectedEventRef !== '?' ? selectedEventRef : undefined;

  const {
    data: selectedCommit,
    isLoading: selectedCommitLoading,
    error: selectedCommitError,
  } = useCommitDetail(normalizedSelectedCommitRef, {
    enabled: normalizedSelectedCommitRef !== undefined,
    partitionId,
  });
  const {
    data: selectedEvent,
    isLoading: selectedEventLoading,
    error: selectedEventError,
  } = useRequestEventDetail(normalizedSelectedEventRef, {
    enabled: normalizedSelectedEventRef !== undefined,
    partitionId,
  });
  const {
    data: selectedPayload,
    isLoading: selectedPayloadLoading,
    error: selectedPayloadError,
  } = useRequestEventPayload(normalizedSelectedEventRef, {
    enabled:
      normalizedSelectedEventRef !== undefined &&
      Boolean(selectedEvent?.payloadRef),
    partitionId,
  });
  const selectedTraceUrl = useMemo(
    () =>
      buildTraceUrl(
        traceUrlTemplate,
        selectedEvent?.traceId ?? null,
        selectedEvent?.spanId ?? null
      ),
    [selectedEvent?.spanId, selectedEvent?.traceId, traceUrlTemplate]
  );

  useEffect(() => {
    setPage(1);
  }, []);

  useEffect(() => {
    setPage(1);
  }, []);

  useEffect(() => {
    if (initialSelectedEntryId) {
      setSelectedEntryId(initialSelectedEntryId);
    }
  }, [initialSelectedEntryId]);

  useEffect(() => {
    if (!hasHandledInitialSelectionReset.current) {
      hasHandledInitialSelectionReset.current = true;
      return;
    }
    setSelectedEntryId(null);
  }, []);

  useEffect(() => {
    setPage(1);
    setSelectedEntryId(null);
  }, []);

  const baseEntries = useMemo((): StreamOperation[] => {
    const items = timelineData?.items ?? [];
    return items.map((item: ConsoleTimelineItem) => {
      const sourceInstanceId =
        item.instanceId ?? item.commit?.instanceId ?? item.event?.instanceId;
      const sourcePrefix = sourceInstanceId ? `[${sourceInstanceId}] ` : '';

      if (item.type === 'commit' && item.commit) {
        const commit = item.commit;
        return {
          type: 'commit',
          id: resolveCommitEntryId(commit, sourceInstanceId),
          outcome: '--',
          duration: '--',
          actor: commit.actorId,
          client: commit.clientId,
          detail: `${sourcePrefix}${commit.changeCount} chg | ${(commit.affectedTables ?? []).join(', ')}`,
          time: formatTime(item.timestamp, preferences.timeFormat),
        };
      }

      const event = item.event;
      if (!event) {
        return {
          type: 'pull',
          id: 'E?',
          outcome: 'unknown',
          duration: '--',
          actor: '',
          client: '',
          detail: '--',
          time: formatTime(item.timestamp, preferences.timeFormat),
        };
      }

      return {
        type: event.eventType as 'push' | 'pull',
        id: resolveEventEntryId(event, sourceInstanceId),
        outcome: event.outcome,
        duration: `${event.durationMs}ms`,
        actor: event.actorId,
        client: event.clientId,
        detail: `${sourcePrefix}${(event.tables ?? []).join(', ') || '--'}`,
        time: formatTime(item.timestamp, preferences.timeFormat),
      };
    });
  }, [preferences.timeFormat, timelineData?.items]);

  const streamEntries = baseEntries;

  const totalItems = timelineData?.total ?? 0;

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  const isLoading = timelineLoading;

  const filterGroups: FilterGroup[] = [
    {
      label: '',
      options: [
        { id: 'all', label: 'All' },
        { id: 'commits', label: 'Commits' },
        { id: 'events', label: 'Events' },
      ],
      activeId: viewMode,
      onActiveChange: (id) => {
        setViewMode(id as ViewMode);
        if (id === 'commits') {
          setEventTypeFilter('all');
          setOutcomeFilter('all');
        }
        setPage(1);
      },
    },
    {
      label: 'Time',
      options: [
        { id: '1h', label: '1h' },
        { id: '6h', label: '6h' },
        { id: '24h', label: '24h' },
        { id: '7d', label: '7d' },
        { id: '30d', label: '30d' },
      ],
      activeId: range,
      onActiveChange: (id) => {
        setRange(id as TimeseriesRange);
        setPage(1);
      },
    },
    {
      label: 'Type',
      options: [
        { id: 'all', label: 'All' },
        { id: 'push', label: 'Push' },
        { id: 'pull', label: 'Pull' },
      ],
      activeId: eventTypeFilter,
      onActiveChange: (id) => {
        setEventTypeFilter(id as EventTypeFilter);
        setPage(1);
      },
    },
    {
      label: 'Outcome',
      options: [
        { id: 'all', label: 'All' },
        { id: 'applied', label: 'Applied' },
        { id: 'error', label: 'Error' },
        { id: 'rejected', label: 'Rejected' },
      ],
      activeId: outcomeFilter,
      onActiveChange: (id) => {
        setOutcomeFilter(id as OutcomeFilter);
        setPage(1);
      },
    },
  ];

  function handleClearEvents() {
    clearEvents.mutate(undefined, {
      onSuccess: () => {
        setShowClearConfirm(false);
        void refetchTimeline();
      },
    });
  }

  return (
    <div className="flex flex-col h-full">
      {isLoading && streamEntries.length === 0 ? (
        <div className="flex items-center justify-center py-24">
          <Spinner size="lg" />
        </div>
      ) : (
        <StreamLog
          entries={streamEntries}
          selectedEntryId={selectedEntryId}
          onEntryClick={(entry) => setSelectedEntryId(entry.id)}
          filterBar={
            <FilterBar
              groups={filterGroups}
              searchValue={searchValue}
              searchPlaceholder="Use actor:, client:, table:, request:, trace: or free text..."
              onSearchChange={setSearchValue}
              actions={
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void refetchTimeline()}
                  >
                    Refresh
                  </Button>
                  <Button size="sm" variant="ghost">
                    Export
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setShowClearConfirm(true)}
                  >
                    Clear
                  </Button>
                </>
              }
            />
          }
          pagination={
            <Pagination
              page={page}
              totalPages={totalPages}
              totalItems={totalItems}
              onPageChange={setPage}
            />
          }
        />
      )}

      <Dialog
        open={selectedEntryId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedEntryId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {normalizedSelectedCommitRef !== undefined
                ? `Commit #${normalizedSelectedCommitRef}`
                : normalizedSelectedEventRef !== undefined
                  ? `Event E${normalizedSelectedEventRef}`
                  : 'Entry details'}
            </DialogTitle>
          </DialogHeader>

          <div className="px-5 py-4 space-y-3 max-h-[70vh] overflow-y-auto">
            {selectedCommitLoading || selectedEventLoading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner size="sm" />
              </div>
            ) : selectedCommitError || selectedEventError ? (
              <p className="font-mono text-[11px] text-offline">
                Failed to load details.
              </p>
            ) : selectedCommit ? (
              <>
                <div className="grid grid-cols-2 gap-3 font-mono text-[11px]">
                  <div>
                    <span className="text-neutral-500">Actor</span>
                    <div className="text-neutral-100">
                      {selectedCommit.actorId}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Client</span>
                    <div className="text-neutral-100">
                      {selectedCommit.clientId}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Instance</span>
                    <div className="text-neutral-100">
                      {selectedCommit.instanceId ?? '--'}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Created</span>
                    <div className="text-neutral-100">
                      {formatTime(
                        selectedCommit.createdAt,
                        preferences.timeFormat
                      )}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Changes</span>
                    <div className="text-neutral-100">
                      {selectedCommit.changeCount}
                    </div>
                  </div>
                </div>

                <div>
                  <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500 mb-2">
                    Affected Tables
                  </p>
                  <p className="font-mono text-[11px] text-neutral-200">
                    {selectedCommit.affectedTables.join(', ') || '--'}
                  </p>
                </div>

                <div className="space-y-2">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
                    Changes
                  </p>
                  {selectedCommit.changes.length === 0 ? (
                    <p className="font-mono text-[11px] text-neutral-500">
                      No changes recorded.
                    </p>
                  ) : (
                    selectedCommit.changes.map((change) => (
                      <div
                        key={change.changeId}
                        className="rounded-md border border-border p-3 space-y-2"
                      >
                        <div className="flex items-center justify-between font-mono text-[11px]">
                          <span className="text-neutral-300">
                            {change.table} | {change.op}
                          </span>
                          <span className="text-neutral-500">
                            #{change.changeId}
                          </span>
                        </div>
                        <div className="font-mono text-[11px] text-neutral-400">
                          rowId: {change.rowId}
                          {change.rowVersion !== null
                            ? ` | version: ${change.rowVersion}`
                            : ''}
                        </div>
                        <pre className="font-mono text-[10px] rounded bg-surface p-2 overflow-x-auto text-neutral-200">
                          {formatJson(change.rowJson)}
                        </pre>
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : selectedEvent ? (
              <>
                <div className="grid grid-cols-2 gap-3 font-mono text-[11px]">
                  <div>
                    <span className="text-neutral-500">Type</span>
                    <div className="text-neutral-100">
                      {selectedEvent.eventType}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Path</span>
                    <div className="text-neutral-100">
                      {selectedEvent.syncPath}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Instance</span>
                    <div className="text-neutral-100">
                      {selectedEvent.instanceId ?? '--'}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Outcome</span>
                    <div className="text-neutral-100">
                      {selectedEvent.outcome}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Response Status</span>
                    <div className="text-neutral-100">
                      {selectedEvent.responseStatus}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Actor</span>
                    <div className="text-neutral-100">
                      {selectedEvent.actorId}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Client</span>
                    <div className="text-neutral-100">
                      {selectedEvent.clientId}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Status</span>
                    <div className="text-neutral-100">
                      {selectedEvent.statusCode}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Transport</span>
                    <div className="text-neutral-100">
                      {selectedEvent.transportPath}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Duration</span>
                    <div className="text-neutral-100">
                      {selectedEvent.durationMs}ms
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Request ID</span>
                    <div className="text-neutral-100">
                      {selectedEvent.requestId}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Trace ID</span>
                    <div className="text-neutral-100">
                      {selectedEvent.traceId ?? '--'}
                    </div>
                    {selectedTraceUrl && (
                      <a
                        href={selectedTraceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-[10px] text-flow underline underline-offset-4"
                      >
                        Open external trace
                      </a>
                    )}
                  </div>
                  <div>
                    <span className="text-neutral-500">Span ID</span>
                    <div className="text-neutral-100">
                      {selectedEvent.spanId ?? '--'}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Commit Seq</span>
                    <div className="text-neutral-100">
                      {selectedEvent.commitSeq ?? '--'}
                    </div>
                    {selectedEvent.commitSeq !== null && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setSelectedEntryId(
                            `#${selectedEvent.instanceId ? `${selectedEvent.instanceId}:` : ''}${selectedEvent.commitSeq}`
                          )
                        }
                      >
                        Open linked commit
                      </Button>
                    )}
                  </div>
                  <div>
                    <span className="text-neutral-500">Subscription Count</span>
                    <div className="text-neutral-100">
                      {selectedEvent.subscriptionCount ?? '--'}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Error Code</span>
                    <div className="text-neutral-100">
                      {selectedEvent.errorCode ?? '--'}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Payload Ref</span>
                    <div className="text-neutral-100">
                      {selectedEvent.payloadRef ?? '--'}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Created</span>
                    <div className="text-neutral-100">
                      {formatTime(
                        selectedEvent.createdAt,
                        preferences.timeFormat
                      )}
                    </div>
                  </div>
                </div>

                <div>
                  <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500 mb-2">
                    Tables
                  </p>
                  <p className="font-mono text-[11px] text-neutral-200">
                    {selectedEvent.tables.join(', ') || '--'}
                  </p>
                </div>

                {selectedEvent.scopesSummary && (
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500 mb-2">
                      Scopes Summary
                    </p>
                    <pre className="font-mono text-[10px] rounded bg-surface p-2 overflow-x-auto text-neutral-200">
                      {formatJson(selectedEvent.scopesSummary)}
                    </pre>
                  </div>
                )}

                {selectedEvent.payloadRef && (
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500 mb-2">
                      Payload Snapshot
                    </p>
                    {selectedPayloadLoading ? (
                      <div className="flex items-center gap-2">
                        <Spinner size="sm" />
                        <span className="font-mono text-[11px] text-neutral-400">
                          Loading payload snapshot...
                        </span>
                      </div>
                    ) : selectedPayloadError ? (
                      <p className="font-mono text-[11px] text-offline">
                        Failed to load payload snapshot.
                      </p>
                    ) : selectedPayload ? (
                      <div className="space-y-2">
                        <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
                          Request
                        </p>
                        <pre className="font-mono text-[10px] rounded bg-surface p-2 overflow-x-auto text-neutral-200">
                          {formatJson(selectedPayload.requestPayload)}
                        </pre>
                        <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
                          Response
                        </p>
                        <pre className="font-mono text-[10px] rounded bg-surface p-2 overflow-x-auto text-neutral-200">
                          {formatJson(selectedPayload.responsePayload)}
                        </pre>
                      </div>
                    ) : (
                      <p className="font-mono text-[11px] text-neutral-500">
                        No payload snapshot available.
                      </p>
                    )}
                  </div>
                )}

                {selectedEvent.errorMessage && (
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500 mb-2">
                      Error
                    </p>
                    <p className="font-mono text-[11px] text-offline">
                      {selectedEvent.errorMessage}
                    </p>
                  </div>
                )}
              </>
            ) : (
              <p className="font-mono text-[11px] text-neutral-500">
                No details available for this row.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="default"
              size="sm"
              onClick={() => setSelectedEntryId(null)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear confirmation dialog */}
      <Dialog
        open={showClearConfirm}
        onOpenChange={(open) => {
          if (!open) setShowClearConfirm(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear all events</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            <span className="font-mono text-[11px] text-neutral-400">
              This will permanently delete all request events. Commits are not
              affected. Are you sure?
            </span>
          </div>
          <DialogFooter>
            <Button
              variant="default"
              size="sm"
              onClick={() => setShowClearConfirm(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleClearEvents}
              disabled={clearEvents.isPending}
            >
              {clearEvents.isPending ? 'Clearing...' : 'Clear all'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
