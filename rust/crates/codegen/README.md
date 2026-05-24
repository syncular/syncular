# syncular-codegen

Schema introspection and Rust code generator for Syncular app clients.

The generator reads Syncular migrations and app codegen configuration, then
emits generated Rust modules for Diesel table/query types, typed mutations,
subscriptions, and app schema metadata.

Install the binary with Cargo:

```bash
cargo install syncular-codegen
```

Most apps should run codegen through the package scripts documented in the
Syncular docs so generated output stays tied to the app's migrations and schema
contract.

