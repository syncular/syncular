/**
 * @syncular/demo-app - App shell
 *
 * TanStack Router shell. Provides unified routing for both
 * demo tabs (/) and console pages (/console/*).
 */

import { createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from './routeTree';

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return <RouterProvider router={router} />;
}
