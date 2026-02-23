import {
  Badge,
  BottomBar,
  Button,
  ConnectionStatusBadge,
  Input,
  NavPill,
  NavPillGroup,
  navActionLinkClassName,
  SyncularBrand,
  TopNavigation,
} from '@syncular/ui';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { ArrowLeft, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useConnection } from './hooks/ConnectionContext';
import { useStats } from './hooks/useConsoleApi';
import { useInstanceContext } from './hooks/useInstanceContext';
import { usePartitionContext } from './hooks/usePartitionContext';
import { usePreferences } from './hooks/usePreferences';
import { SYNCULAR_CONSOLE_ROOT_CLASS } from './theme-scope';

interface ConsoleLayoutProps {
  basePath?: string;
  appHref?: string;
  modeBadge?: ReactNode;
}

type ConsoleNavSuffix =
  | ''
  | '/stream'
  | '/fleet'
  | '/ops'
  | '/storage'
  | '/config';

interface ConsoleNavItem {
  suffix: ConsoleNavSuffix;
  label: string;
}

const NAV_ITEMS: ConsoleNavItem[] = [
  { suffix: '', label: 'Command' },
  { suffix: '/stream', label: 'Stream' },
  { suffix: '/fleet', label: 'Fleet' },
  { suffix: '/ops', label: 'Ops' },
  { suffix: '/storage', label: 'Storage' },
  { suffix: '/config', label: 'Config' },
];

function normalizeBasePath(basePath?: string): string {
  const value = basePath?.trim() ?? '';
  if (!value || value === '/') return '';
  const withSlash = value.startsWith('/') ? value : `/${value}`;
  return withSlash.replace(/\/+$/g, '');
}

function resolvePath(basePath: string, suffix: ConsoleNavSuffix): string {
  if (!basePath) return suffix || '/';
  return suffix ? `${basePath}${suffix}` : basePath;
}

export function ConsoleLayout({
  basePath,
  appHref,
  modeBadge,
}: ConsoleLayoutProps) {
  const { connect, config, isConnected, isConnecting } = useConnection();
  const { preferences } = usePreferences();
  const { instanceId, rawInstanceId, setInstanceId, clearInstanceId } =
    useInstanceContext();
  const { partitionId, rawPartitionId, setPartitionId, clearPartitionId } =
    usePartitionContext();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { data: stats } = useStats({
    refetchIntervalMs: preferences.refreshInterval * 1000,
    partitionId,
    instanceId,
  });

  const normalizedBasePath = normalizeBasePath(basePath);
  const resolvedNavItems = useMemo(
    () =>
      NAV_ITEMS.map((item) => ({
        ...item,
        id: resolvePath(normalizedBasePath, item.suffix),
      })),
    [normalizedBasePath]
  );
  const commandPath = resolvePath(normalizedBasePath, '');
  const configPath = resolvePath(normalizedBasePath, '/config');

  const connectionState = isConnecting
    ? 'connecting'
    : isConnected
      ? 'connected'
      : config
        ? 'disconnected'
        : 'not-configured';

  const activeId =
    resolvedNavItems.find((item) =>
      item.suffix === ''
        ? pathname === commandPath || pathname === `${commandPath}/`
        : pathname.startsWith(item.id)
    )?.id ?? commandPath;

  const bottomMetrics = stats
    ? [
        { label: 'HEAD', value: `#${stats.maxCommitSeq}` },
        { label: 'COMMITS', value: `${stats.commitCount}` },
        { label: 'CHANGES', value: `${stats.changeCount}` },
        {
          label: 'CLIENTS',
          value: `${stats.activeClientCount}/${stats.clientCount}`,
        },
      ]
    : [];

  return (
    <div
      className={`${SYNCULAR_CONSOLE_ROOT_CLASS} h-screen bg-background text-foreground flex flex-col`}
    >
      <TopNavigation
        brand={
          <Link to={commandPath}>
            <SyncularBrand label="console" />
          </Link>
        }
        center={
          <NavPillGroup
            items={resolvedNavItems}
            activeId={activeId}
            renderItem={(item, { active }) => (
              <Link key={item.id} to={item.id}>
                <NavPill active={active}>{item.label}</NavPill>
              </Link>
            )}
          />
        }
        right={
          <div className="flex items-center gap-2">
            {modeBadge ? (
              <Badge
                variant="flow"
                className="hidden md:inline-flex px-2 py-1 text-[10px]"
              >
                {modeBadge}
              </Badge>
            ) : null}
            <div className="flex items-center gap-1">
              <span className="font-mono text-[9px] text-neutral-500 uppercase tracking-wide">
                Instance
              </span>
              <Input
                variant="mono"
                value={rawInstanceId}
                onChange={(event) => setInstanceId(event.target.value)}
                onBlur={(event) => setInstanceId(event.target.value.trim())}
                placeholder="all"
                className="h-7 w-[110px] px-2 py-1"
              />
              {instanceId ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[10px]"
                  onClick={clearInstanceId}
                >
                  All
                </Button>
              ) : null}
            </div>
            <div className="flex items-center gap-1">
              <span className="font-mono text-[9px] text-neutral-500 uppercase tracking-wide">
                Partition
              </span>
              <Input
                variant="mono"
                value={rawPartitionId}
                onChange={(event) => setPartitionId(event.target.value)}
                onBlur={(event) => setPartitionId(event.target.value.trim())}
                placeholder="all"
                className="h-7 w-[110px] px-2 py-1"
              />
              {partitionId ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[10px]"
                  onClick={clearPartitionId}
                >
                  All
                </Button>
              ) : null}
            </div>
            <ConnectionStatusBadge state={connectionState} />
            <Link to={configPath}>
              <Button
                variant={pathname === configPath ? 'secondary' : 'ghost'}
                size="icon"
              >
                <Settings className="h-3 w-3" />
              </Button>
            </Link>
            {appHref ? (
              <a href={appHref} className={navActionLinkClassName}>
                <ArrowLeft className="h-3 w-3" />
                Go to app
              </a>
            ) : null}
          </div>
        }
      />

      <main className="flex-1 overflow-auto pb-[32px]">
        <div className="min-h-full">
          {isConnected || pathname === configPath ? (
            <div key={pathname} style={{ animation: 'pageIn 0.3s ease-out' }}>
              <Outlet />
            </div>
          ) : (
            <NotConnectedFallback
              configPath={configPath}
              hasSavedConfig={Boolean(config)}
              isConnecting={isConnecting}
              onConnect={() => {
                void connect();
              }}
            />
          )}
        </div>
      </main>

      {isConnected && (
        <BottomBar isLive={isConnected} metrics={bottomMetrics} uptime="--" />
      )}
    </div>
  );
}

function NotConnectedFallback({
  configPath,
  hasSavedConfig,
  isConnecting,
  onConnect,
}: {
  configPath: string;
  hasSavedConfig: boolean;
  isConnecting: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <p className="mb-4 text-foreground-muted">
        Not connected to a @syncular server
      </p>
      <div className="flex items-center gap-2">
        {hasSavedConfig && (
          <Button variant="default" onClick={onConnect} disabled={isConnecting}>
            {isConnecting ? 'Connecting...' : 'Connect'}
          </Button>
        )}
        <Link to={configPath}>
          <Button variant="link">Configure connection</Button>
        </Link>
      </div>
    </div>
  );
}
