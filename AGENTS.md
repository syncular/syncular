# Agent Notes

- Do not preserve compatibility branches for old Syncular client/protocol behavior unless the user explicitly asks for compatibility. This repo is actively moving to the Rust-first architecture, and old JS/client protocol behavior should be removed cleanly instead of carried as default/fallback code.
- Do not add inline fallback behavior for protocol transitions. Prefer one current path with clear failures over negotiated legacy branches.
