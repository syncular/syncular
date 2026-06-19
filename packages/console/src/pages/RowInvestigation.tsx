import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { usePartitionContext, useRowInvestigation } from '../hooks';
import type { ConsoleRowInvestigationResponse } from '../lib/types';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  SectionCard,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui';

interface RowInvestigationProps {
  table: string;
  rowId: string;
}

type Finding = ConsoleRowInvestigationResponse['findings'][number];
type HistoryEntry = ConsoleRowInvestigationResponse['history'][number];
type RelevantEvent = ConsoleRowInvestigationResponse['relevantEvents'][number];

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '--';
  return new Date(value).toLocaleString();
}

function findingVariant(
  severity: Finding['severity']
): 'destructive' | 'secondary' | 'flow' {
  if (severity === 'error') return 'destructive';
  if (severity === 'warning') return 'secondary';
  return 'flow';
}

function HistoryRows({ history }: { history: HistoryEntry[] }) {
  if (history.length === 0) {
    return (
      <p className="font-mono text-[11px] text-neutral-500">
        No audit rows recorded for this row.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Commit</TableHead>
          <TableHead>Op</TableHead>
          <TableHead>Client</TableHead>
          <TableHead>Fields</TableHead>
          <TableHead>Events</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {history.map((entry) => (
          <TableRow key={entry.changeId}>
            <TableCell className="font-mono text-[11px]">
              <Link
                to="/investigate/commit/$seq"
                params={{ seq: String(entry.commitSeq) }}
                className="text-flow underline underline-offset-4"
              >
                #{entry.commitSeq}
              </Link>
            </TableCell>
            <TableCell>
              <Badge variant={entry.op === 'delete' ? 'offline' : 'healthy'}>
                {entry.op}
              </Badge>
            </TableCell>
            <TableCell className="font-mono text-[11px]">
              {entry.clientId}
            </TableCell>
            <TableCell className="font-mono text-[11px]">
              {entry.fields.length > 0 ? entry.fields.join(', ') : '--'}
            </TableCell>
            <TableCell className="font-mono text-[11px]">
              {entry.requestEventIds.length > 0
                ? entry.requestEventIds.map((eventId) => (
                    <Link
                      key={eventId}
                      to="/investigate/event/$id"
                      params={{ id: String(eventId) }}
                      className="mr-2 text-flow underline underline-offset-4"
                    >
                      E{eventId}
                    </Link>
                  ))
                : '--'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function EventRows({ events }: { events: RelevantEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="font-mono text-[11px] text-neutral-500">
        No matching request events found.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Event</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Client</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead>Rows</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((event) => (
          <TableRow key={event.eventId}>
            <TableCell className="font-mono text-[11px]">
              <Link
                to="/investigate/event/$id"
                params={{ id: String(event.eventId) }}
                className="text-flow underline underline-offset-4"
              >
                E{event.eventId}
              </Link>
            </TableCell>
            <TableCell>
              <Badge variant="ghost">{event.eventType}</Badge>
            </TableCell>
            <TableCell className="font-mono text-[11px]">
              {event.clientId}
            </TableCell>
            <TableCell className="font-mono text-[11px]">
              {event.outcome} / {event.responseStatus}
            </TableCell>
            <TableCell className="font-mono text-[11px]">
              {event.rowCount ?? '--'}
            </TableCell>
            <TableCell className="font-mono text-[11px]">
              {formatDateTime(event.createdAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RowInvestigation({ table, rowId }: RowInvestigationProps) {
  const { partitionId } = usePartitionContext();
  const [clientIdInput, setClientIdInput] = useState('');
  const clientId = clientIdInput.trim() || undefined;
  const { data, isLoading, error, refetch } = useRowInvestigation({
    table,
    rowId,
    clientId,
    partitionId,
    limit: 25,
  });

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="font-mono text-[13px] uppercase tracking-widest text-neutral-200">
            Row Investigation
          </h1>
          <p className="mt-1 font-mono text-[11px] text-neutral-500">
            {table} / {rowId}
          </p>
        </div>
        <div className="flex items-end gap-2">
          <Field>
            <FieldLabel>Client ID</FieldLabel>
            <Input
              variant="mono"
              value={clientIdInput}
              onChange={(event) => setClientIdInput(event.target.value)}
              placeholder="optional"
              className="w-[260px]"
            />
            <FieldDescription>
              Add a client id to check cursor and scope coverage.
            </FieldDescription>
          </Field>
          <Button size="md" variant="primary" onClick={() => void refetch()}>
            Refresh
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-24">
          <Spinner size="lg" />
        </div>
      ) : error ? (
        <Alert variant="destructive">
          <AlertTitle>Investigation Failed</AlertTitle>
          <AlertDescription>
            The console could not load the row investigation.
          </AlertDescription>
        </Alert>
      ) : data ? (
        <>
          <div className="grid gap-4 xl:grid-cols-4">
            <SectionCard
              title="Row"
              description="Payload redacted by default."
              contentClassName="space-y-3"
            >
              <div className="grid grid-cols-2 gap-3 font-mono text-[11px]">
                <div>
                  <span className="text-neutral-500">Known</span>
                  <div className="text-neutral-100">
                    {data.rowKnown ? 'yes' : 'no'}
                  </div>
                </div>
                <div>
                  <span className="text-neutral-500">Latest Op</span>
                  <div className="text-neutral-100">
                    {data.latestOp ?? '--'}
                  </div>
                </div>
                <div>
                  <span className="text-neutral-500">Commit</span>
                  <div className="text-neutral-100">
                    {data.latestCommitSeq !== null
                      ? `#${data.latestCommitSeq}`
                      : '--'}
                  </div>
                </div>
                <div>
                  <span className="text-neutral-500">Partition</span>
                  <div className="text-neutral-100">{data.partitionId}</div>
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title="Client"
              description="Cursor and scope keys only."
              contentClassName="space-y-3"
            >
              {data.client ? (
                <div className="grid grid-cols-2 gap-3 font-mono text-[11px]">
                  <div>
                    <span className="text-neutral-500">Client</span>
                    <div className="text-neutral-100">
                      {data.client.clientId}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Actor</span>
                    <div className="text-neutral-100">
                      {data.client.actorId}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Cursor</span>
                    <div className="text-neutral-100">
                      #{data.client.cursor}
                    </div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Last Request</span>
                    <div className="text-neutral-100">
                      {data.client.lastRequestOutcome ?? '--'}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="font-mono text-[11px] text-neutral-500">
                  No client selected or no cursor found.
                </p>
              )}
            </SectionCard>

            <SectionCard
              title="Scopes"
              description="Scope values are not exposed."
              contentClassName="space-y-3"
            >
              <div className="font-mono text-[11px] space-y-2">
                <Badge
                  variant={
                    data.scopeEligibility.status === 'eligible'
                      ? 'healthy'
                      : data.scopeEligibility.status === 'not_eligible'
                        ? 'offline'
                        : 'ghost'
                  }
                >
                  {data.scopeEligibility.status}
                </Badge>
                <div className="text-neutral-400">
                  required:{' '}
                  {data.scopeEligibility.requiredScopeKeys.join(', ') || '--'}
                </div>
                <div className="text-neutral-400">
                  missing:{' '}
                  {data.scopeEligibility.missingScopeKeys.join(', ') || '--'}
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title="Subscription"
              description="Derived from request-event metadata."
              contentClassName="space-y-3"
            >
              <div className="font-mono text-[11px] space-y-2">
                <Badge
                  variant={
                    data.subscriptionEvidence.status === 'observed'
                      ? 'healthy'
                      : data.subscriptionEvidence.status === 'revoked' ||
                          data.subscriptionEvidence.status === 'not_observed'
                        ? 'offline'
                        : 'ghost'
                  }
                >
                  {data.subscriptionEvidence.status}
                </Badge>
                <div className="text-neutral-400">
                  events: {data.subscriptionEvidence.matchingEventCount}
                </div>
                <div className="text-neutral-400">
                  latest: {data.subscriptionEvidence.latestRequestId ?? '--'}
                </div>
                <div className="text-neutral-400">
                  count:{' '}
                  {data.subscriptionEvidence.latestSubscriptionCount ?? '--'}
                </div>
                <div className="text-neutral-400">
                  scope keys:{' '}
                  {data.subscriptionEvidence.observedScopeKeys.join(', ') ||
                    '--'}
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title="Requests"
              description="Success and rejection evidence for this table."
              contentClassName="space-y-3"
            >
              <div className="font-mono text-[11px] space-y-2">
                <Badge
                  variant={
                    data.requestEvidence.latestResponseStatus === 'success'
                      ? 'healthy'
                      : data.requestEvidence.latestResponseStatus
                        ? 'offline'
                        : 'ghost'
                  }
                >
                  {data.requestEvidence.latestResponseStatus ?? 'none'}
                </Badge>
                <div className="text-neutral-400">
                  events: {data.requestEvidence.matchingEventCount}
                </div>
                <div className="text-neutral-400">
                  success: {data.requestEvidence.successEventCount}
                </div>
                <div className="text-neutral-400">
                  non-success: {data.requestEvidence.nonSuccessEventCount}
                </div>
                <div className="text-neutral-400">
                  latest: {data.requestEvidence.latestRequestId ?? '--'}
                </div>
                <div className="text-neutral-400">
                  latest error: {data.requestEvidence.latestErrorCode ?? '--'}
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title="Bootstrap"
              description="Snapshot transport evidence from pull summaries."
              contentClassName="space-y-3"
            >
              <div className="font-mono text-[11px] space-y-2">
                <Badge
                  variant={
                    data.snapshotEvidence.artifactCount > 0
                      ? 'healthy'
                      : data.snapshotEvidence.chunkCount > 0
                        ? 'ghost'
                        : data.snapshotEvidence.pageCount > 0
                          ? 'ghost'
                          : 'offline'
                  }
                >
                  {data.snapshotEvidence.artifactCount > 0
                    ? 'artifact'
                    : data.snapshotEvidence.chunkCount > 0
                      ? 'chunk'
                      : data.snapshotEvidence.pageCount > 0
                        ? 'inline'
                        : 'none'}
                </Badge>
                <div className="text-neutral-400">
                  pages: {data.snapshotEvidence.pageCount}
                </div>
                <div className="text-neutral-400">
                  inline rows: {data.snapshotEvidence.inlineRowCount}
                </div>
                <div className="text-neutral-400">
                  chunks: {data.snapshotEvidence.chunkCount}
                </div>
                <div className="text-neutral-400">
                  chunk bytes: {data.snapshotEvidence.chunkBytes}
                </div>
                <div className="text-neutral-400">
                  artifacts: {data.snapshotEvidence.artifactCount}
                </div>
                <div className="text-neutral-400">
                  artifact bytes: {data.snapshotEvidence.artifactBytes}
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title="Realtime"
              description="Client-level websocket recovery evidence."
              contentClassName="space-y-3"
            >
              <div className="font-mono text-[11px] space-y-2">
                <Badge
                  variant={
                    data.realtimeEvidence.pullRequiredEventCount > 0 ||
                    data.realtimeEvidence.errorEventCount > 0 ||
                    data.realtimeEvidence.rejectedEventCount > 0
                      ? 'offline'
                      : data.realtimeEvidence.connectedEventCount > 0
                        ? 'healthy'
                        : 'ghost'
                  }
                >
                  {data.realtimeEvidence.latestEventType ?? 'none'}
                </Badge>
                <div className="text-neutral-400">
                  events: {data.realtimeEvidence.matchingEventCount}
                </div>
                <div className="text-neutral-400">
                  connected: {data.realtimeEvidence.connectedEventCount}
                </div>
                <div className="text-neutral-400">
                  pull required: {data.realtimeEvidence.pullRequiredEventCount}
                </div>
                <div className="text-neutral-400">
                  ack: {data.realtimeEvidence.ackEventCount}
                </div>
                <div className="text-neutral-400">
                  errors: {data.realtimeEvidence.errorEventCount}
                </div>
                <div className="text-neutral-400">
                  latest reason: {data.realtimeEvidence.latestReason ?? '--'}
                </div>
              </div>
            </SectionCard>
          </div>

          <SectionCard title="Findings" contentClassName="space-y-2">
            {data.findings.length === 0 ? (
              <p className="font-mono text-[11px] text-neutral-500">
                No obvious diagnostic findings.
              </p>
            ) : (
              data.findings.map((finding) => (
                <div
                  key={finding.code}
                  className="flex flex-col gap-1 rounded-md border border-border p-3 md:flex-row md:items-center md:justify-between"
                >
                  <div>
                    <div className="font-mono text-[11px] text-neutral-200">
                      {finding.code}
                    </div>
                    <div className="font-mono text-[10px] text-neutral-500">
                      {finding.message}
                    </div>
                  </div>
                  <Badge variant={findingVariant(finding.severity)}>
                    {finding.severity}
                  </Badge>
                </div>
              ))
            )}
          </SectionCard>

          <SectionCard title="Row History">
            <HistoryRows history={data.history} />
          </SectionCard>

          <SectionCard title="Relevant Events">
            <EventRows events={data.relevantEvents} />
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}
