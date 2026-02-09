import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { ConnectionProvider } from './hooks/ConnectionContext';
import { routeTree } from './routeTree.gen';

function getInjectedBasepath(): string {
  if (typeof document === 'undefined') return '/';
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="syncular-console-basepath"]'
  );
  const value = meta?.content?.trim();
  if (!value) return '/';
  if (value === '/') return '/';
  return value.startsWith('/') ? value.replace(/\/$/, '') : '/';
}

const basepath = getInjectedBasepath();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
    },
  },
});

const router = createRouter({ routeTree, basepath });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider>
        <RouterProvider router={router} />
      </ConnectionProvider>
    </QueryClientProvider>
  );
}
