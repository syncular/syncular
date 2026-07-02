---
'@syncular/client': patch
---

Rebuild the published browser WASM artifacts with a modern Binaryen. Versions
0.1.0–0.1.3 shipped `dist/wasm*/syncular_bg.wasm` files optimized by Ubuntu's
apt binaryen 108, which emitted modules that fail `WebAssembly.Module`
compilation in every engine (V8 and JSC alike), so the browser runtime was
unusable from the published package. CI now installs a pinned Binaryen 130,
`build-syncular-wasm.ts` refuses wasm-opt older than 118 and parse-validates
every artifact it emits, and the post-publish install smoke parse-checks the
shipped artifacts on all platforms (no Linux skip).
