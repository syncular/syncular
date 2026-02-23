import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, Outlet } from '@tanstack/react-router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
    },
  },
});

function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="syncular-ui-root min-h-screen">
        <Outlet />
      </div>
    </QueryClientProvider>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
});
