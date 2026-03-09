import { expect } from 'bun:test';
import {
  defineDemoSmokeScenario,
  resetDemoData,
  waitForSplitScreenClientsReady,
  waitForTaskInBothPanes,
} from '../../shared/demo-smoke';

defineDemoSmokeScenario({
  scenarioName: 'Demo split-screen smoke: todo mirror',
  testName: 'loads both clients and mirrors todo updates',
  async testBody({ demoBaseUrl, page }) {
    await page.goto(demoBaseUrl, { waitUntil: 'domcontentloaded' });
    await waitForSplitScreenClientsReady(page);

    expect(
      await page.getByText('Database initialization failed:').count()
    ).toBe(0);

    await resetDemoData(page);

    const title = `smoke-${Date.now()}`;
    const input = page.getByPlaceholder('Add a task...').first();
    await input.fill(title);
    await input.press('Enter');

    await waitForTaskInBothPanes({
      page,
      timeoutMs: 240_000,
      title,
    });
  },
});
