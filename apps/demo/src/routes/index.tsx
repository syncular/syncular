import type { NavItem } from '@syncular/ui';
import {
  NavPillGroup,
  navActionLinkClassName,
  StatusDot,
  SyncularBrand,
  TopNavigation,
} from '@syncular/ui/navigation';
import { Badge } from '@syncular/ui/primitives';
import {
  createRoute,
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { DemoResetAllButton } from '../components/demo-reset-all-button';
import { Route as rootRoute } from './__root';

type DemoRoutePath = '/' | '/media' | '/catalog' | '/keyshare' | '/symmetric';
type DemoNavItem = NavItem & { href: DemoRoutePath };

const TABS: DemoNavItem[] = [
  { id: 'split', label: 'Split Screen', href: '/' },
  { id: 'media', label: 'Media Sync', href: '/media' },
  { id: 'catalog', label: 'Large Catalog', href: '/catalog' },
  { id: 'keyshare', label: 'E2EE Key Share', href: '/keyshare' },
  { id: 'symmetric', label: 'Symmetric E2EE', href: '/symmetric' },
];

function pathToTabId(pathname: string): string {
  const normalized =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname;
  const tab = TABS.find((item) => item.href === normalized);
  return tab?.id ?? 'split';
}

function DemoShell() {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const activeTab = pathToTabId(pathname);

  const handleTabChange = useCallback(
    (id: string) => {
      const tab = TABS.find((item) => item.id === id);
      if (!tab) return;
      navigate({ to: tab.href });
    },
    [navigate]
  );

  const brand = useMemo(() => <SyncularBrand label="DEMO" />, []);

  const center = useMemo(
    () => (
      <NavPillGroup
        items={TABS}
        activeId={activeTab}
        onItemChange={handleTabChange}
      />
    ),
    [activeTab, handleTabChange]
  );

  const right = useMemo(
    () => (
      <div className="flex items-center gap-3">
        <DemoResetAllButton />
        <Badge
          variant="flow"
          className="px-2 py-1 text-[10px]"
          title="This demo runs fully in-browser via a service-worker server and local SQLite storage."
        >
          <StatusDot color="flow" pulse />
          SW Offline
        </Badge>
        <Link to="/console" className={navActionLinkClassName}>
          Go to console
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    ),
    []
  );

  return (
    <div className="min-h-screen bg-background">
      <TopNavigation brand={brand} center={center} right={right} />

      <main>
        <div className="max-w-[1440px] mx-auto px-6 py-6">
          <div className="mb-4 rounded-md border border-flow/30 bg-flow/[0.08] px-3 py-2 font-mono text-[10px] text-flow">
            This demo runs the full server stack — Hono, Database, Blob Storage,
            realtime sync — entirely in your browser via Service Worker. No
            backend needed.
          </div>
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  id: 'demo',
  component: DemoShell,
});
