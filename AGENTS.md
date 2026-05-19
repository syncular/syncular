# Agent Notes

- Do not preserve compatibility branches for old Syncular client/protocol behavior unless the user explicitly asks for compatibility. This repo is actively moving to the Rust-first architecture, and old JS/client protocol behavior should be removed cleanly instead of carried as default/fallback code.
- Do not add inline fallback behavior for protocol transitions. Prefer one current path with clear failures over negotiated legacy branches.
- Track any retained fallback, alias, old protocol path, or legacy behavior in `rust/docs/COMPATIBILITY_REGISTER.md`. The default decision is removal/disruption unless the user explicitly asks for compatibility.
- Rust-first planning docs live under `rust/docs/`. Keep `rust/docs/ROADMAP.md` as the current status source, check work against `rust/docs/CLIENT_PRODUCT_CONTRACT.md`, run the relevant gates from `rust/docs/QUALITY_GATES.md`, update the active file under `rust/docs/work-packages/` for each work batch, and record performance-sensitive before/after evidence in `rust/docs/BENCHMARK_LOG.md`.
- For Rust-first work, follow the autonomous loop in `rust/docs/ROADMAP.md`: pick the active WP, run or cite its baseline, make one scoped change, run gates/benchmarks, keep or revert based on evidence, update docs, then commit.
