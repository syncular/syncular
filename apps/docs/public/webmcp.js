(() => {
  const modelContext = navigator.modelContext;
  if (!modelContext || typeof modelContext.registerTool !== 'function') return;

  const controller = new AbortController();
  let indexPromise;

  const getIndex = () => {
    indexPromise ??= fetch('/.well-known/docs-index.json').then((response) =>
      response.json(),
    );
    return indexPromise;
  };

  const normalizePath = (path) => {
    if (!path || path === 'current') return location.pathname;
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin) {
      throw new Error('Only syncular.dev documentation paths are supported.');
    }
    return url.pathname;
  };

  const register = (tool) => {
    modelContext.registerTool(tool, { signal: controller.signal });
  };

  register({
    name: 'syncular_list_docs',
    description: 'List canonical Syncular documentation pages.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async () => getIndex(),
  });

  register({
    name: 'syncular_search_docs',
    description: 'Search Syncular documentation page titles and paths.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive title or path query.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async ({ query }) => {
      const needle = String(query ?? '').toLowerCase();
      const index = await getIndex();
      return {
        results: index.pages.filter(
          (page) =>
            page.title.toLowerCase().includes(needle) ||
            page.path.toLowerCase().includes(needle),
        ),
      };
    },
  });

  register({
    name: 'syncular_get_page_markdown',
    description: 'Fetch a Syncular docs page as Markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Docs path or "current".',
        },
      },
      additionalProperties: false,
    },
    execute: async ({ path = 'current' } = {}) => {
      const pathname = normalizePath(path);
      const response = await fetch(pathname, {
        headers: { Accept: 'text/markdown' },
      });
      return {
        path: pathname,
        markdown: await response.text(),
        contentType: response.headers.get('content-type'),
      };
    },
  });

  register({
    name: 'syncular_open_doc',
    description: 'Navigate the current browser tab to a Syncular docs page.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Canonical docs path, such as /quickstart/.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async ({ path }) => {
      const pathname = normalizePath(path);
      const index = await getIndex();
      const allowed = new Set(index.pages.map((page) => page.path));
      if (!allowed.has(pathname)) {
        return { opened: false, error: `Unknown docs path: ${pathname}` };
      }
      location.assign(pathname);
      return { opened: true, path: pathname };
    },
  });

  addEventListener('pagehide', () => controller.abort(), { once: true });
})();
