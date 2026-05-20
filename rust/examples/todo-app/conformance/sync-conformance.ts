import { readFileSync } from "node:fs";

export const syncConformance = JSON.parse(
  readFileSync(new URL("./sync-scenarios.json", import.meta.url), "utf8"),
) as unknown;
