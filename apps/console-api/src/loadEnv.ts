/**
 * Auto-load `.env` into process.env as a SIDE EFFECT on import so the BFF can
 * fail closed when live env is absent. Zero-dep; never overwrites already-set
 * vars (an explicit shell export still wins). Imported FIRST in server.ts so it
 * runs before chain.ts reads any env.
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
    if (process.env[key] !== undefined) continue; // don't clobber an explicit export
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

loadEnv();
