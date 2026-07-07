// ============================================================================
// env.ts
// v0.2.1: 轻量 .env 加载器，避免引入额外依赖
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

let loaded = false;

export function loadEnvFile(filePath = ".env"): void {
  if (loaded) return;
  loaded = true;

  const absolutePath = resolve(process.cwd(), filePath);
  if (!existsSync(absolutePath)) return;

  const content = readFileSync(absolutePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
