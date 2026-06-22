/**
 * Render docs/console-ui-report/report.html → report.pdf via headless chromium.
 * Run: node scripts/build-console-report-pdf.mjs
 */
import { chromium } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = join(ROOT, "docs/console-ui-report/report.html");
const PDF = join(ROOT, "docs/console-ui-report/Benzo-Console-UI-Report.pdf");

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(HTML).href, { waitUntil: "networkidle" });
// ensure every <img> has decoded before printing
await page.evaluate(async () => {
  await Promise.all(Array.from(document.images).map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => {}))));
});
await page.pdf({ path: PDF, format: "A4", printBackground: true, preferCSSPageSize: true, margin: { top: "0", bottom: "0", left: "0", right: "0" } });
await browser.close();
console.log("PDF written:", PDF);
