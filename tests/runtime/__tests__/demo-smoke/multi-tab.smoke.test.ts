import { expect } from 'bun:test';
import { collectBrowserErrors } from '../../shared/browser-errors';
import {
  defineDemoSmokeScenario,
  resetDemoData,
  waitForSplitScreenClientsReady,
  waitForTaskInBothPanes,
} from '../../shared/demo-smoke';

defineDemoSmokeScenario({
  scenarioName: 'Demo split-screen smoke: multi-tab',
  testName:
    'syncs persisted state across a second browser tab in the same profile',
  async testBody({ context, demoBaseUrl, page }) {
    await page.goto(demoBaseUrl, { waitUntil: 'domcontentloaded' });
    await waitForSplitScreenClientsReady(page);

    await resetDemoData(page);

    const existingTitle = `tab-one-${Date.now()}`;
    const pageOneInput = page.getByPlaceholder('Add a task...').first();
    await pageOneInput.fill(existingTitle);
    await pageOneInput.press('Enter');

    await waitForTaskInBothPanes({
      page,
      timeoutMs: 240_000,
      title: existingTitle,
    });

    const secondPage = await context.newPage();
    const secondPageErrors = collectBrowserErrors(secondPage);

    try {
      await secondPage.goto(demoBaseUrl, { waitUntil: 'domcontentloaded' });
      await waitForSplitScreenClientsReady(secondPage);

      expect(
        await secondPage.getByText('Database initialization failed:').count()
      ).toBe(0);

      await waitForTaskInBothPanes({
        page: secondPage,
        timeoutMs: 240_000,
        title: existingTitle,
      });

      secondPageErrors.clear();

      const mirroredTitle = `tab-two-${Date.now()}`;
      const pageTwoInput = secondPage.getByPlaceholder('Add a task...').first();
      await pageTwoInput.fill(mirroredTitle);
      await pageTwoInput.press('Enter');

      await waitForTaskInBothPanes({
        page: secondPage,
        timeoutMs: 240_000,
        title: mirroredTitle,
      });
      await waitForTaskInBothPanes({
        page,
        timeoutMs: 240_000,
        title: mirroredTitle,
      });

      secondPageErrors.assertNone('demo multi-tab smoke test');
    } finally {
      secondPageErrors.detach();
      await secondPage.close();
    }
  },
});
