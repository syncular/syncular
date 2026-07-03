/**
 * Test preload: register a happy-dom global environment so
 * `@testing-library/react` can render into a real DOM under bun's test
 * runner. This is the ONLY reason happy-dom is a devDep (justified: hook
 * semantics — mount/effect/re-render — need a renderer, and RTL is the
 * standard, low-ceremony harness for that). Loaded via `bun test --preload`.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();
