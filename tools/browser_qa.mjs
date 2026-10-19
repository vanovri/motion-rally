// Browser QA: real host page plus two phone controllers in touch mode.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server/server.mjs";
import { createCommentary } from "../server/commentary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "docs");
mkdirSync(outDir, { recursive: true });

const server = await startServer({ port: 0, commentary: createCommentary({ apiKey: undefined }) });
const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const consoleErrors = [];

async function openPage(path, viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(`${path}: ${message.text()}`); });
  page.on("pageerror", (error) => consoleErrors.push(`${path}: pageerror ${error.message}`));
  await page.goto(`${server.url}${path}`, { waitUntil: "load" });
  return page;
}

const host = await openPage("/", { width: 1440, height: 900 });
await host.waitForFunction(() => /^\d{4}$/.test(document.getElementById("room-code").textContent), null, { timeout: 8000 });
const room = (await host.locator("#room-code").textContent()).trim();
const token = (await host.locator("#pairing-token").textContent()).trim();

const controllers = [];
for (const slot of [1, 2]) {
  const page = await openPage("/controller", { width: 390, height: 844 });
  await page.fill("#room-input", room);
  await page.fill("#token-input", token);
  await page.selectOption("#slot-select", String(slot));
  await page.click("#join");
  await page.waitForFunction(() => document.getElementById("connection").textContent.includes("joined"), null, { timeout: 8000 });
  controllers.push(page);
}

await host.waitForFunction(() => window.__RALLY_STATE__.slots.filter((slot) => slot.connected).length === 2, null, { timeout: 8000 });

// Touch mode on both controllers.
for (const page of controllers) {
  await page.click("#touch-toggle");
  await page.waitForTimeout(150);
}
const pad = controllers[0].locator("#touch-pad");
const box = await pad.boundingBox();
await controllers[0].mouse.move(box.x + box.width * 0.85, box.y + box.height / 2);
await controllers[0].mouse.down();
await controllers[0].mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 4 });
await controllers[0].mouse.up();
await controllers[1].mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
await controllers[1].mouse.down();
await controllers[1].mouse.up();

await host.waitForFunction(() => window.__RALLY_STATE__.snapshot !== null, null, { timeout: 5000 });
await host.waitForTimeout(2600);

const hostState = await host.evaluate(() => ({
  room: window.__RALLY_STATE__.room,
  connected: window.__RALLY_STATE__.connected,
  slots: window.__RALLY_STATE__.slots,
  snapshot: window.__RALLY_STATE__.snapshot,
  commentary: window.__RALLY_STATE__.commentary.length,
}));
const controllerState = await controllers[0].evaluate(() => ({ ...window.__CONTROLLER_STATE__ }));

await host.screenshot({ path: resolve(outDir, "preview-host.png") });
await controllers[0].screenshot({ path: resolve(outDir, "preview-controller.png") });

const health = await (await fetch(`${server.url}/healthz`)).json();
const result = {
  room,
  host: {
    connected: hostState.connected,
    slots: hostState.slots.map((slot) => ({ slot: slot.slot, connected: slot.connected, name: slot.name })),
    score: hostState.snapshot?.score,
    phase: hostState.snapshot?.phase,
    ball: hostState.snapshot?.ball,
    paddles: hostState.snapshot?.paddles,
    commentaryEntries: hostState.commentary,
  },
  controller: {
    joined: controllerState.joined,
    mode: controllerState.mode,
    slot: controllerState.slot,
    calibrated: controllerState.calibrated,
  },
  server: {
    rooms: health.rooms.length,
    stats: health.stats,
    commentary: health.commentary,
  },
  consoleErrors,
  screenshots: ["preview-host.png", "preview-controller.png"],
};

writeFileSync(resolve(outDir, "browser-qa.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));

await browser.close();
await server.close();
