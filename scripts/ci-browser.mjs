#!/usr/bin/env node
/**
 * CI browser check. Waits for the production preview, then hunts the default fault.
 * Does not use the sandbox-only smoke script.
 */
import { chromium } from "playwright";

const url = process.env.FAULTLINE_URL ?? "http://127.0.0.1:8081/";

async function waitFor(address) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(address, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      // preview still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("preview did not answer at " + address);
}

await waitFor(url);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));
await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
const title = await page.title();
if (!title.includes("Faultline")) {
  console.error("unexpected title", title);
  await browser.close();
  process.exit(1);
}
const hunt = page.getByRole("button", { name: "Hunt this fault" });
await hunt.waitFor({ state: "visible" });
const found = page.getByText("Violation held still.", { exact: false });
for (let attempt = 0; attempt < 3; attempt++) {
  await hunt.click();
  try {
    await found.waitFor({ timeout: 8_000 });
    break;
  } catch (err) {
    if (attempt === 2) throw err;
  }
}
await page.getByRole("button", { name: "Live" }).click();
await page.getByRole("button", { name: "Run on the live service" }).click();
await found.waitFor({ timeout: 30_000 });
if (errors.length > 0) {
  console.error(errors.join("\n"));
  await browser.close();
  process.exit(1);
}
console.log("browser ok", url);
await browser.close();
