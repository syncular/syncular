import {
  BottomBar,
  Button,
  ConnectionStatusBadge,
  NavPill,
  NavPillGroup,
  SyncularBrand,
  TopNavigation,
} from '@syncular/ui';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Settings } from 'lucide-react';
import { useMemo } from 'react';
import { useConnection } from './hooks/ConnectionContext';
import { useStats } from './hooks/useConsoleApi';

interface ConsoleLayoutProps {
  basePath?: string;
}

type ConsoleNavSuffix = '' | '/stream' | '/fleet' | '/ops' | '/config';

interface ConsoleNavItem {
  suffix: ConsoleNavSuffix;
  label: string;
}

const NAV_ITEMS: ConsoleNavItem[] = [
  { suffix: '', label: 'Command' },
  { suffix: '/stream', label: 'Stream' },
  { suffix: '/fleet', label: 'Fleet' },
  { suffix: '/ops', label: 'Ops' },
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

export function ConsoleLayout({ basePath }: ConsoleLayoutProps) {
  const { isConnected, isConnecting, config } = useConnection();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { data: stats } = useStats();

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
        { label: 'OPS/S', value: `${stats.commitCount}` },
        { label: 'LATENCY', value: '—' },
        {
          label: 'CLIENTS',
          value: `${stats.activeClientCount}/${stats.clientCount}`,
        },
        { label: 'ERRORS', value: '0' },
      ]
    : [];

  return (
    <div className="h-screen bg-background text-foreground flex flex-col">
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
            <ConnectionStatusBadge state={connectionState} />
            <Link to={configPath}>
              <Button
                variant={pathname === configPath ? 'secondary' : 'ghost'}
                size="icon"
              >
                <Settings />
              </Button>
            </Link>
          </div>
        }
      />

      <main className="flex-1 overflow-auto pt-[42px] pb-[32px]">
        <div className="min-h-full">
          {isConnected || pathname === configPath ? (
            <div key={pathname} style={{ animation: 'pageIn 0.3s ease-out' }}>
              <Outlet />
            </div>
          ) : (
            <NotConnectedFallback configPath={configPath} />
          )}
        </div>
      </main>

      {isConnected && (
        <BottomBar isLive={isConnected} metrics={bottomMetrics} uptime="—" />
      )}
    </div>
  );
}

function NotConnectedFallback({ configPath }: { configPath: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <p className="mb-4 text-foreground-muted">
        Not connected to a @syncular server
      </p>
      <Link to={configPath}>
        <Button variant="link">Configure connection</Button>
      </Link>
    </div>
  );
}
