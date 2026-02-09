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
import { useMemo, useState } from 'react';
import { useCommits } from '../hooks/useConsoleApi';
import {
  useClearEventsMutation,
  useRequestEvents,
} from '../hooks/useRequestEvents';
import type { ConsoleCommitListItem, ConsoleRequestEvent } from '../lib/types';

type ViewMode = 'all' | 'commits' | 'events';
type EventTypeFilter = 'all' | 'push' | 'pull';
type OutcomeFilter = 'all' | 'applied' | 'error' | 'rejected';

interface TimelineItem {
  type: 'commit' | 'event';
  timestamp: string;
  data: ConsoleCommitListItem | ConsoleRequestEvent;
}

const PAGE_SIZE = 20;

function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffS = Math.floor(diffMs / 1000);

  if (diffS < 60) return `${diffS}s`;
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m`;
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h`;
  return `${Math.floor(diffS / 86400)}d`;
}

export function Stream() {
  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [eventTypeFilter, setEventTypeFilter] =
    useState<EventTypeFilter>('all');
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>('all');
  const [searchValue, setSearchValue] = useState('');
  const [page, setPage] = useState(1);

  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const eventQueryParams = {
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    ...(eventTypeFilter !== 'all' ? { eventType: eventTypeFilter } : {}),
    ...(outcomeFilter !== 'all' ? { outcome: outcomeFilter } : {}),
  };

  const { data: commitsData, isLoading: commitsLoading } = useCommits({
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const {
    data: eventsData,
    isLoading: eventsLoading,
    refetch: refetchEvents,
  } = useRequestEvents(eventQueryParams);

  const clearEvents = useClearEventsMutation();

  const timelineItems = useMemo((): TimelineItem[] => {
    const items: TimelineItem[] = [];

    if (viewMode !== 'events' && commitsData?.items) {
      for (const commit of commitsData.items) {
        items.push({
          type: 'commit',
          timestamp: commit.createdAt,
          data: commit,
        });
      }
    }

    if (viewMode !== 'commits' && eventsData?.items) {
      for (const event of eventsData.items) {
        items.push({
          type: 'event',
          timestamp: event.createdAt,
          data: event,
        });
      }
    }

    items.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    return items;
  }, [viewMode, commitsData?.items, eventsData?.items]);

  const filteredTimeline = useMemo(() => {
    if (!searchValue) return timelineItems;
    const lower = searchValue.toLowerCase();
    return timelineItems.filter((item) => {
      if (item.type === 'commit') {
        const commit = item.data as ConsoleCommitListItem;
        return (
          commit.actorId.toLowerCase().includes(lower) ||
          commit.clientId.toLowerCase().includes(lower) ||
          String(commit.commitSeq).includes(lower)
        );
      }
      const event = item.data as ConsoleRequestEvent;
      return (
        event.actorId.toLowerCase().includes(lower) ||
        event.clientId.toLowerCase().includes(lower) ||
        String(event.eventId).includes(lower)
      );
    });
  }, [timelineItems, searchValue]);

  const streamEntries = useMemo(
    (): StreamOperation[] =>
      filteredTimeline.map((item) => {
        if (item.type === 'commit') {
          const commit = item.data as ConsoleCommitListItem;
          return {
            type: 'commit',
            id: `#${commit.commitSeq}`,
            outcome: '\u2014',
            duration: '\u2014',
            actor: commit.actorId,
            client: commit.clientId,
            detail: `${commit.changeCount} chg \u00b7 ${(commit.affectedTables ?? []).join(', ')}`,
            time: formatTime(item.timestamp),
          };
        }
        const event = item.data as ConsoleRequestEvent;
        return {
          type: event.eventType as 'push' | 'pull',
          id: `E${event.eventId}`,
          outcome: event.outcome,
          duration: `${event.durationMs}ms`,
          actor: event.actorId,
          client: event.clientId,
          detail: (event.tables ?? []).join(', ') || '\u2014',
          time: formatTime(item.timestamp),
        };
      }),
    [filteredTimeline]
  );

  const totalItems = useMemo(() => {
    let count = 0;
    if (viewMode !== 'events') count += commitsData?.total ?? 0;
    if (viewMode !== 'commits') count += eventsData?.total ?? 0;
    return count;
  }, [viewMode, commitsData?.total, eventsData?.total]);

  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));

  const isLoading = commitsLoading || eventsLoading;

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
      onSuccess: () => setShowClearConfirm(false),
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
          filterBar={
            <FilterBar
              groups={filterGroups}
              searchValue={searchValue}
              searchPlaceholder="Filter by client or actor..."
              onSearchChange={setSearchValue}
              actions={
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => refetchEvents()}
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
