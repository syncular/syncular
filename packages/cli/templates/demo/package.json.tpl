{
  "name": "<%= it.PROJECT_NAME %>",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently -k -n server,web \"bun run dev:server\" \"bun run dev:web\"",
    "dev:server": "bun run src/server/index.ts",
    "dev:web": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "db:migrate:status": "syncular migrate status --config syncular.config.json",
    "db:migrate": "syncular migrate up --config syncular.config.json",
    "db:migrate:reset": "syncular migrate up --config syncular.config.json --on-checksum-mismatch reset --yes",
    "db:typegen": "bun run scripts/syncular-typegen.ts",
    "db:prepare": "bun run db:migrate && bun run db:typegen"
  },
  "dependencies": {
    "@syncular/client": "latest",
    "@syncular/dialect-bun-sqlite": "latest",
    "@syncular/dialect-wa-sqlite": "latest",
    "@syncular/migrations": "latest",
    "@syncular/server": "latest",
    "@syncular/server-dialect-sqlite": "latest",
    "@syncular/server-hono": "latest",
    "@syncular/transport-http": "latest",
    "hono": "latest",
    "kysely": "latest",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@syncular/typegen": "latest",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "concurrently": "^9.1.2",
    "typescript": "^5.7.3",
    "vite": "^6.2.0"
  }
}
