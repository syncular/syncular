import { afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

export function registerHappyDomForTestFile(): void {
  const registeredByThisFile = !GlobalRegistrator.isRegistered;
  if (registeredByThisFile) {
    GlobalRegistrator.register();
  }

  afterAll(() => {
    if (registeredByThisFile && GlobalRegistrator.isRegistered) {
      GlobalRegistrator.unregister();
    }
  });
}
