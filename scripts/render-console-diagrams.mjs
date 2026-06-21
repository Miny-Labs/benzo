/**
 * Render the business deck diagrams (mermaid in docs/demo-flow/console-diagrams/
 * diagrams.html) to diagram-0.png … diagram-10.png using the working chromium.
 *
 *   node scripts/render-console-diagrams.mjs
 */
import { chromium } from "@playwright/test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "docs/demo-flow/console-diagrams");
const HTML = "file://" + join(DIR, "diagrams.html");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1240, height: 900 }, deviceScaleFactor: 2 });
await page.goto(HTML, { waitUntil: "networkidle" });
// wait for mermaid to finish rendering all diagrams
await page.waitForFunction(() => window.__rendered === true, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1200);

const ids = await page.$$eval(".diagram", (els) => els.map((e) => e.id));
let i = 0;
for (const id of ids) {
  const el = await page.$("#" + id);
  if (!el) { console.log("  (missing)", id); continue; }
  await el.screenshot({ path: join(DIR, `diagram-${i}.png`) });
  console.log("  rendered", `diagram-${i}.png`, "<-", id);
  i++;
}
await browser.close();
console.log(`done — ${i} diagrams in docs/demo-flow/console-diagrams/`);
