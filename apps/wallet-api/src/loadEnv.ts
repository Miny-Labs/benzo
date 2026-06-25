/**
 * Auto-load `.env` into process.env on import (side effect) — so the wallet BFF
 * can fail closed if the operator forgot to source live env.
 * Zero-dep; never clobbers an already-set var. Imported FIRST in server.ts.
 * (Identical in spirit to apps/console-api/src/loadEnv.ts.)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function loadEnv(path = join(process.env.BENZO_ROOT || process.cwd(), ".env")): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no .env — rely on shell-exported env; live checks fail closed if absent
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

loadEnv();
