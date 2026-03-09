import { expect } from 'bun:test';
import {
  defineDemoSmokeScenario,
  measureSplitScreenToggleLatency,
  waitForSplitScreenClientsReady,
  waitForTaskInBothPanes,
} from '../../shared/demo-smoke';

defineDemoSmokeScenario({
  scenarioName: 'Demo split-screen smoke: toggle latency',
  testName:
    'keeps source-pane toggle responsive while mirroring to target pane',
  async testBody({ demoBaseUrl, page }) {
    await page.goto(demoBaseUrl, { waitUntil: 'domcontentloaded' });
    await waitForSplitScreenClientsReady(page);

    const title = `latency-${Date.now()}`;
    const input = page.getByPlaceholder('Add a task...').first();
    await input.fill(title);
    await input.press('Enter');

    await waitForTaskInBothPanes({
      page,
      timeoutMs: 240_000,
      title,
    });

    const { mirrorPaneMs, samePaneMs } = await measureSplitScreenToggleLatency({
      page,
      timeoutMs: 240_000,
      title,
    });

    expect(samePaneMs).not.toBeNull();
    expect(mirrorPaneMs).not.toBeNull();
    expect(samePaneMs!).toBeLessThan(500);
    expect(mirrorPaneMs!).toBeGreaterThanOrEqual(samePaneMs!);
  },
});
