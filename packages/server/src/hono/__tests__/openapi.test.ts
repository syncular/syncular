import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import {
  createOpenAPIDocsRoutes,
  createOpenAPIHandler,
  createScalarReferenceHandler,
} from '../openapi';

describe('OpenAPI helpers', () => {
  it('serves an OpenAPI document with configured metadata', async () => {
    const sourceApp = new Hono();
    const app = new Hono();

    app.get(
      '/openapi.json',
      createOpenAPIHandler(sourceApp, {
        title: 'Test API',
        version: '1.2.3',
        description: 'Test description',
      })
    );

    const response = await app.request('/openapi.json');
    expect(response.status).toBe(200);

    const document = await response.json();
    expect(document.info).toEqual({
      title: 'Test API',
      version: '1.2.3',
      description: 'Test description',
    });
  });

  it('serves a Scalar API reference that points at the configured document', async () => {
    const app = new Hono();
    app.get(
      '/spec',
      createScalarReferenceHandler({
        url: '/docs/openapi.json',
      })
    );

    const response = await app.request('/spec');
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain('/docs/openapi.json');
  });

  it('creates paired OpenAPI and Scalar routes', async () => {
    const sourceApp = new Hono();
    const app = new Hono();

    app.route(
      '/',
      createOpenAPIDocsRoutes(sourceApp, {
        title: 'Docs API',
        version: '9.9.9',
        openAPIPath: '/api-docs.json',
        scalarPath: '/docs',
      })
    );

    const openApiResponse = await app.request('/api-docs.json');
    expect(openApiResponse.status).toBe(200);
    const document = await openApiResponse.json();
    expect(document.info).toEqual({
      title: 'Docs API',
      version: '9.9.9',
      description: 'Sync infrastructure API for real-time data synchronization',
    });

    const docsResponse = await app.request('/docs');
    expect(docsResponse.status).toBe(200);
    const html = await docsResponse.text();
    expect(html).toContain('/api-docs.json');
  });
});
