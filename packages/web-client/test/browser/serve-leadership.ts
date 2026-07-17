const root = new URL('./', import.meta.url);
const [pageBuild, workerBuild] = await Promise.all([
  Bun.build({
    entrypoints: [new URL('leadership-page.ts', root).pathname],
    target: 'browser',
    format: 'esm',
    conditions: ['bun'],
  }),
  Bun.build({
    entrypoints: [new URL('leadership-worker.ts', root).pathname],
    target: 'browser',
    format: 'esm',
    conditions: ['bun'],
  }),
]);
if (!pageBuild.success || !workerBuild.success) {
  throw new Error('failed to build browser leadership fixture');
}

const pageBundle = await pageBuild.outputs[0]?.text();
const workerBundle = await workerBuild.outputs[0]?.text();
if (pageBundle === undefined || workerBundle === undefined) {
  throw new Error('browser leadership fixture emitted no bundle');
}

const opened = new Map<string, string[]>();
const server = Bun.serve({
  port: 0,
  routes: {
    '/': new Response(
      `<!doctype html><meta charset="utf-8"><title>Syncular leadership fixture</title><script type="module" src="/leadership-page.js"></script>`,
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    ),
    '/leadership-page.js': new Response(pageBundle, {
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    }),
    '/leadership-worker.js': new Response(workerBundle, {
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    }),
    '/opened': {
      POST(request) {
        const url = new URL(request.url);
        const suite = url.searchParams.get('suite') ?? 'manual';
        const instances = opened.get(suite) ?? [];
        instances.push(url.searchParams.get('instance') ?? 'unknown');
        opened.set(suite, instances);
        return Response.json({ ok: true });
      },
    },
    '/events': {
      GET(request) {
        const suite =
          new URL(request.url).searchParams.get('suite') ?? 'manual';
        const instances = opened.get(suite) ?? [];
        return Response.json({ opens: instances.length, instances });
      },
      DELETE(request) {
        const suite =
          new URL(request.url).searchParams.get('suite') ?? 'manual';
        opened.delete(suite);
        return new Response(null, { status: 204 });
      },
    },
  },
  fetch: () => new Response('not found', { status: 404 }),
});

console.log(`http://127.0.0.1:${server.port}`);
