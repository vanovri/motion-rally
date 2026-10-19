// Local load probe: two simulated controllers at ~30 Hz for six seconds.
// Numbers describe this machine only; they are not a latency guarantee.
import { WebSocket } from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server/server.mjs";
import { createCommentary } from "../server/commentary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(resolve(root, "reports"), { recursive: true });

const server = await startServer({ port: 0, commentary: createCommentary({ apiKey: undefined }) });
const url = server.url.replace(/^http/, "ws") + "/ws";

function connect() {
  const socket = new WebSocket(url);
  const messages = [];
  socket.on("message", (data) => messages.push({ at: performance.now(), message: JSON.parse(data.toString()) }));
  return { socket, messages, open: new Promise((resolve) => socket.once("open", resolve)) };
}

const host = connect();
await host.open;
host.socket.send(JSON.stringify({ v: 1, type: "hello", role: "host", name: "court" }));
await new Promise((resolve) => setTimeout(resolve, 150));
const room = host.messages.find((entry) => entry.message.type === "room").message.code;

const phones = [];
for (const slot of [1, 2]) {
  const phone = connect();
  await phone.open;
  phone.socket.send(JSON.stringify({ v: 1, type: "hello", role: "controller", room, slot, name: `sim-${slot}` }));
  phones.push(phone);
}
await new Promise((resolve) => setTimeout(resolve, 300));

let seq = 0;
const started = performance.now();
const pump = setInterval(() => {
  const t = (performance.now() - started) / 1000;
  for (const [index, phone] of phones.entries()) {
    seq += 1;
    phone.socket.send(JSON.stringify({
      v: 1, type: "input", seq, timestamp: performance.now(),
      beta: 20 + Math.sin(t * 2 + index) * 30,
      gamma: Math.sin(t * 1.3 + index * 2) * 40,
      alpha: 0,
    }));
  }
}, 33);

await new Promise((resolve) => setTimeout(resolve, 6000));
clearInterval(pump);
await new Promise((resolve) => setTimeout(resolve, 300));

const snapshots = host.messages.filter((entry) => entry.message.type === "state");
const gaps = [];
for (let i = 1; i < snapshots.length; i += 1) gaps.push(snapshots[i].at - snapshots[i - 1].at);
gaps.sort((a, b) => a - b);
const percentile = (values, p) => values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? null;
const health = await (await fetch(`${server.url}/healthz`)).json();

const report = {
  measuredAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  durationSeconds: 6,
  inputRateHz: 30,
  controllers: 2,
  snapshotsReceived: snapshots.length,
  snapshotGapMs: {
    p50: Number((percentile(gaps, 0.5) ?? 0).toFixed(1)),
    p95: Number((percentile(gaps, 0.95) ?? 0).toFixed(1)),
    max: Number((gaps.at(-1) ?? 0).toFixed(1)),
  },
  server: health.stats,
  latestState: snapshots.at(-1)?.message ?? null,
  note: "Single-machine local measurement; includes simulated sensors on loopback. Not a network or device latency guarantee.",
};

writeFileSync(resolve(root, "reports", "load.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));

await new Promise((resolve) => {
  for (const phone of phones) phone.socket.close();
  host.socket.close();
  setTimeout(resolve, 150);
});
await server.close();
