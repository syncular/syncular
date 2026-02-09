import type { NavItem } from '@syncular/ui';
import {
  NavPillGroup,
  StatusDot,
  SyncularBrand,
  TopNavigation,
} from '@syncular/ui/navigation';
import {
  createRoute,
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
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
        <div className="flex items-center gap-1.5">
          <StatusDot color="healthy" pulse />
          <span className="font-mono text-[10px] uppercase tracking-wider text-foreground-muted">
            Live
          </span>
        </div>
        <Link
          to="/console"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-flow/30 text-flow text-[10px] font-mono uppercase tracking-wider hover:bg-flow/8 transition-colors"
        >
          Console
        </Link>
      </div>
    ),
    []
  );

  return (
    <div className="min-h-screen bg-background">
      <TopNavigation brand={brand} center={center} right={right} />

      <main className="pt-[52px]">
        <div className="max-w-[1440px] mx-auto px-6 py-6">
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
