/**
 * Test preload: register a happy-dom global environment so the React helper
 * test can mount hooks under bun's test runner (same posture as
 * `@syncular-v2/react`'s setup). The non-React kit tests do not need it, but
 * a single preload for the whole package is simplest.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();
