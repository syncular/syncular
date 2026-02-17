# @syncular/cli

CLI for scaffolding Syncular projects and running migration workflows.

## Install

```bash
npm install -g @syncular/cli
```

Or run without global install:

```bash
npx @syncular/cli --help
bunx @syncular/cli --help
```

## Usage

```bash
# Scaffold integration libraries
syncular create

# Scaffold a runnable demo
syncular create demo --dir ./my-syncular-demo

# Run migration adapter status/up
syncular migrate status
syncular migrate up
```

## Documentation

- CLI docs: https://syncular.dev/docs/cli
- Create commands: https://syncular.dev/docs/cli/create
- Migrate commands: https://syncular.dev/docs/cli/migrate

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. CLI commands and generated templates may change between releases.
