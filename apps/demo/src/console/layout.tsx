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
import { useConnection } from './hooks/ConnectionContext';
import { useStats } from './hooks/useConsoleApi';

const navItems = [
  { id: '/console', label: 'Command' },
  { id: '/console/stream', label: 'Stream' },
  { id: '/console/fleet', label: 'Fleet' },
  { id: '/console/ops', label: 'Ops' },
  { id: '/console/config', label: 'Config' },
] as const;

export function ConsoleLayout() {
  const { isConnected, isConnecting, config } = useConnection();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { data: stats } = useStats();

  const connectionState = isConnecting
    ? 'connecting'
    : isConnected
      ? 'connected'
      : config
        ? 'disconnected'
        : 'not-configured';

  const activeId =
    navItems.find((item) =>
      item.id === '/console'
        ? pathname === '/console' || pathname === '/console/'
        : pathname.startsWith(item.id)
    )?.id ?? '/console';

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
          <Link to="/console">
            <SyncularBrand label="console" />
          </Link>
        }
        center={
          <NavPillGroup
            items={navItems}
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
            <Link to="/console/config">
              <Button
                variant={
                  pathname.startsWith('/console/config') ? 'secondary' : 'ghost'
                }
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
          {isConnected || pathname.startsWith('/console/config') ? (
            <div key={pathname} style={{ animation: 'pageIn 0.3s ease-out' }}>
              <Outlet />
            </div>
          ) : (
            <NotConnectedFallback />
          )}
        </div>
      </main>

      {isConnected && (
        <BottomBar isLive={isConnected} metrics={bottomMetrics} uptime="—" />
      )}
    </div>
  );
}

function NotConnectedFallback() {
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <p className="mb-4 text-foreground-muted">
        Not connected to a @syncular server
      </p>
      <Link to="/console/config">
        <Button variant="link">Configure connection</Button>
      </Link>
    </div>
  );
}
