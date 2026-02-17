---
name: demo-workflow
description: Workflow for extending the Syncular demo app as a canonical, runnable example of framework usage without inventing non-existent APIs.
metadata:
  short-description: Update demo safely and keep it representative
---

# Demo Workflow

Use this skill when asked to extend or fix the **demo app**.

## Guardrails

- The demo should use **public exports** only (treat it like a user project).
- Don’t add “convenience” APIs in demo code that don’t exist in the framework.
- Don’t edit unrelated diffs already present in `git diff`.

## Step 1 — Decide what the demo is proving

Write a one-line statement of the behavior being showcased (e.g. realtime wake-ups, conflicts, blobs, encryption).

## Step 2 — Implement using real APIs

Start from:
- `demo/src/**`
- Public exports in `packages/*/src/index.ts`

If you need a framework change, do it in the framework first and update docs accordingly.

## Step 3 — Smoke test

- Run: `bun --cwd demo dev`
- Manually verify the scenario end-to-end in a browser.

## Step 4 — Optional regression coverage

If the demo is the main proof of a capability, consider adding an integration test in:
- `tests/integration/`
