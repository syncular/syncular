import { expect } from 'bun:test';
import { Buffer } from 'node:buffer';
import { defineDemoSmokeScenario } from '../../shared/demo-smoke';

defineDemoSmokeScenario({
  scenarioName: 'Demo split-screen smoke: media',
  testName: 'uploads media and syncs thumbnails across both clients',
  async testBody({ demoBaseUrl, page }) {
    await page.goto(`${demoBaseUrl}/media`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.querySelector('input[type="file"]') !== null,
      undefined,
      { timeout: 120_000 }
    );

    expect(
      await page.getByText('Database initialization failed:').count()
    ).toBe(0);

    await page.waitForFunction(
      () => !document.body.innerText.includes('Initializing PGlite...'),
      undefined,
      { timeout: 180_000 }
    );

    const initialThumbnailCount = await page
      .locator('[data-testid="media-thumbnail"]')
      .count();
    const fileName = `smoke-media-${Date.now()}.png`;
    const png1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8LhB4AAAAASUVORK5CYII=',
      'base64'
    );

    await page.locator('input[type="file"]').first().setInputFiles({
      buffer: png1x1,
      mimeType: 'image/png',
      name: fileName,
    });

    await page.waitForFunction(
      (name) => document.body.innerText.includes(name),
      fileName,
      { timeout: 120_000 }
    );

    await page.waitForFunction(
      (minThumbnails) =>
        document.querySelectorAll('[data-testid="media-thumbnail"]').length >=
        minThumbnails,
      initialThumbnailCount + 2,
      { timeout: 240_000 }
    );
  },
});
