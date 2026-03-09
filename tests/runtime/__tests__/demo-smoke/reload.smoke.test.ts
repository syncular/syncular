import {
  defineDemoSmokeScenario,
  resetDemoData,
  waitForSplitScreenClientsReady,
  waitForTaskInBothPanes,
} from '../../shared/demo-smoke';

defineDemoSmokeScenario({
  scenarioName: 'Demo split-screen smoke: reload',
  testName: 'persists synced tasks across a full reload',
  async testBody({ demoBaseUrl, page }) {
    await page.goto(demoBaseUrl, { waitUntil: 'domcontentloaded' });
    await waitForSplitScreenClientsReady(page);

    await resetDemoData(page);

    const title = `reload-${Date.now()}`;
    const input = page.getByPlaceholder('Add a task...').first();
    await input.fill(title);
    await input.press('Enter');

    await waitForTaskInBothPanes({
      page,
      timeoutMs: 240_000,
      title,
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSplitScreenClientsReady(page);

    await waitForTaskInBothPanes({
      page,
      timeoutMs: 240_000,
      title,
    });
  },
});
