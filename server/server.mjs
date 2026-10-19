// HTTP + WebSocket bridge: rooms, pairing, validated inputs, fixed-step match loop.
import { createServer as createHttpServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Match, TICK_HZ } from "./game.mjs";
import {
  LIMITS, ProtocolError, decode, normalizeMotion, roomCode, validateCalibrate,
  validateHello, validateInput, validateTouch,
} from "./protocol.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLIC_DIR = join(ROOT, "public");
const MAX_ROOMS = 32;
const MAX_CONNECTIONS = 64;
const SNAPSHOT_EVERY = Math.round(TICK_HZ / 20);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

class Room {
  constructor(code, host, commentary, onClose, onSend) {
    this.code = code;
    this.host = host;
    this.controllers = { 1: null, 2: null };
    this.match = new Match();
    this.commentary = commentary;
    this.onClose = onClose;
    this.onSend = onSend;
    this.createdAt = Date.now();
    this.lastPointAt = 0;
  }

  send(connection, message) {
    const socket = connection?.socket ?? connection;
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify(message));
      this.onSend?.();
    }
  }

  broadcast(message) {
    this.send(this.host, message);
    for (const slot of [1, 2]) this.send(this.controllers[slot], message);
  }

  attach(slot, connection) {
    if (this.controllers[slot]) throw new ProtocolError("slot_taken", `slot ${slot} is occupied`);
    this.controllers[slot] = connection;
    connection.room = this;
    connection.slot = slot;
    this.match.setConnected(slot, true);
  }

  detach(connection) {
    const slot = connection.slot;
    if (slot && this.controllers[slot] === connection) {
      this.controllers[slot] = null;
      this.match.setConnected(slot, false);
      this.broadcast({ type: "presence", slots: this.slots() });
    }
  }

  slots() {
    return [1, 2].map((slot) => {
      const connection = this.controllers[slot];
      return {
        slot,
        name: connection ? connection.name : null,
        connected: Boolean(connection),
        stale: connection ? Date.now() - connection.lastInputAt > LIMITS.staleInputSeconds * 1000 : false,
        calibrated: Boolean(connection && connection.calibration),
      };
    });
  }

  handleEvent(event) {
    if (event.type === "point" || event.type === "long_rally" || event.type === "net" || event.type === "out") {
      const text = commentaryText(event, this.match);
      const entry = { type: "commentary", event: event.type, text, at: Date.now() };
      this.broadcast(entry);
      if (this.commentary?.enabled) {
        this.commentary.speak(text).then((result) => {
          if (result?.audio) this.broadcast({ type: "commentary_audio", mime: result.mime, data: result.audio, at: Date.now() });
        }).catch(() => {});
      }
    }
  }

  close() {
    this.broadcast({ type: "closed", reason: "host_disconnected" });
    for (const slot of [1, 2]) {
      const connection = this.controllers[slot];
      if (connection?.socket) connection.socket.close(1001, "room closed");
    }
    this.onClose?.(this);
  }
}

function commentaryText(event, match) {
  if (event.type === "point") {
    const winner = event.slot;
    const loser = winner === 1 ? 2 : 1;
    const reasons = {
      unreturned: "tidak bisa mengembalikan bola",
      out: "bolanya keluar",
      net: "bolanya menyangkut net",
    };
    return `Poin untuk pemain ${winner}. Pemain ${loser} ${reasons[event.reason] ?? "kehilangan poin"}. Skor ${match.score[1]}–${match.score[2]}.`;
  }
  if (event.type === "long_rally") {
    return `Rally panjang, ${event.rally} pukulan berturut-turut!`;
  }
  if (event.type === "net") return "Bola menyangkut net.";
  if (event.type === "out") return "Bola keluar lapangan.";
  return "";
}

function jsonResponse(response, status, body) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  response.end(data);
}

async function serveStatic(request, response, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  if (pathname === "/controller") pathname = "/controller.html";
  if (pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  const target = normalize(join(PUBLIC_DIR, pathname));
  if (!target.startsWith(PUBLIC_DIR)) {
    jsonResponse(response, 403, { error: "forbidden" });
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
    const data = await readFile(target);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
      "content-length": data.length,
      "cache-control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : data);
  } catch {
    jsonResponse(response, 404, { error: "not_found" });
  }
}

export async function startServer({ port = 0, host = "127.0.0.1", commentary = null, log = () => {} } = {}) {
  const rooms = new Map();
  const stats = {
    startedAt: Date.now(),
    ticks: 0,
    tickMs: { min: Infinity, max: 0, total: 0 },
    snapshots: 0,
    messagesIn: 0,
    messagesOut: 0,
    rejected: 0,
    rejections: {},
    connections: 0,
  };

  const httpServer = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method !== "GET" && request.method !== "HEAD") {
      jsonResponse(response, 405, { error: "method_not_allowed" });
      return;
    }
    if (url.pathname === "/healthz") {
      jsonResponse(response, 200, {
        ok: true,
        uptimeSeconds: Math.round((Date.now() - stats.startedAt) / 1000),
        rooms: [...rooms.values()].map((room) => ({
          code: room.code,
          controllers: room.slots(),
          score: room.match.score,
          tick: room.match.tick,
        })),
        stats: publicStats(),
        commentary: { enabled: Boolean(commentary?.enabled), reason: commentary?.reason ?? "disabled" },
      });
      return;
    }
    serveStatic(request, response, url).catch(() => jsonResponse(response, 500, { error: "server_error" }));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes });
  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if (wss.clients.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });

  function publicStats() {
    const tickCount = Math.max(1, stats.ticks);
    return {
      ticks: stats.ticks,
      tickMs: {
        min: Number.isFinite(stats.tickMs.min) ? Number(stats.tickMs.min.toFixed(3)) : null,
        max: Number(stats.tickMs.max.toFixed(3)),
        avg: Number((stats.tickMs.total / tickCount).toFixed(3)),
      },
      snapshots: stats.snapshots,
      messagesIn: stats.messagesIn,
      messagesOut: stats.messagesOut,
      rejected: stats.rejected,
      rejections: { ...stats.rejections },
      rooms: rooms.size,
      connections: wss.clients.size,
    };
  }

  function send(connection, message) {
    if (connection?.socket?.readyState === 1) {
      connection.socket.send(JSON.stringify(message));
      stats.messagesOut += 1;
    }
  }

  function reject(connection, error) {
    stats.rejected += 1;
    stats.rejections[error.code] = (stats.rejections[error.code] ?? 0) + 1;
    send(connection, { type: "error", code: error.code, message: error.message });
  }

  function closeRoom(room) {
    rooms.delete(room.code);
    for (const slot of [1, 2]) {
      const connection = room.controllers[slot];
      if (connection) connection.room = null;
    }
  }

  wss.on("connection", (socket) => {
    stats.connections += 1;
    const connection = {
      socket, role: null, name: null, room: null, slot: null,
      calibration: null, previousBeta: null, lastSeq: -1,
      lastInputAt: 0, windowStart: Date.now(), windowCount: 0,
    };
    const helloTimer = setTimeout(() => socket.close(1008, "hello timeout"), 5000);

    socket.on("message", (raw) => {
      stats.messagesIn += 1;
      try {
        const message = decode(raw);
        if (!connection.role) {
          const hello = validateHello(message);
          clearTimeout(helloTimer);
          connection.role = hello.role;
          connection.name = hello.name;
          if (hello.role === "host") {
            if (rooms.size >= MAX_ROOMS) throw new ProtocolError("too_many_rooms", "room limit reached");
            let code = roomCode();
            while (rooms.has(code)) code = roomCode();
            const room = new Room(code, connection, commentary, closeRoom, () => { stats.messagesOut += 1; });
            connection.room = room;
            connection.hostSocket = true;
            rooms.set(code, room);
            send(connection, { type: "room", code, role: "host", slots: room.slots(), snapshot: room.match.snapshot() });
            room.match.stats = room.match.stats ?? {};
          } else {
            const room = rooms.get(hello.room);
            if (!room) throw new ProtocolError("no_room", "room not found");
            room.attach(hello.slot, connection);
            send(connection, { type: "room", code: room.code, role: "controller", slot: hello.slot, slots: room.slots() });
            send(connection, { type: "state", ...room.match.snapshot() });
            room.broadcast({ type: "presence", slots: room.slots() });
          }
          return;
        }
        if (connection.role === "controller") {
          if (!connection.room) throw new ProtocolError("no_room", "controller is not in a room");
          const now = Date.now();
          if (now - connection.windowStart >= 1000) {
            connection.windowStart = now;
            connection.windowCount = 0;
          }
          connection.windowCount += 1;
          if (connection.windowCount > LIMITS.maxInputHz) {
            throw new ProtocolError("rate_limited", "input rate exceeded");
          }
          if (message.type === "calibrate") {
            connection.calibration = validateCalibrate(message);
            send(connection, { type: "calibrated", ...connection.calibration });
            return;
          }
          if (message.type === "input") {
            const input = validateInput(message);
            if (input.seq <= connection.lastSeq) throw new ProtocolError("stale_seq", "sequence must increase");
            connection.lastSeq = input.seq;
            const normalized = normalizeMotion(input, connection.calibration, { beta: connection.previousBeta });
            connection.previousBeta = input.beta;
            connection.lastInputAt = now;
            connection.room.match.setInput(connection.slot, {
              x: normalized.x, swing: normalized.swing, timestamp: now, seq: input.seq,
            });
            return;
          }
          if (message.type === "touch") {
            const touch = validateTouch(message);
            connection.lastInputAt = now;
            connection.room.match.setInput(connection.slot, {
              x: touch.x, swing: touch.swing, timestamp: now, seq: connection.lastSeq + 1,
            });
            connection.lastSeq += 1;
            return;
          }
          throw new ProtocolError("bad_type", `unsupported controller message: ${message.type}`);
        }
        if (connection.role === "host") {
          if (message.type === "ping") {
            send(connection, { type: "pong", at: Date.now() });
            return;
          }
          throw new ProtocolError("bad_type", `unsupported host message: ${message.type}`);
        }
      } catch (error) {
        if (error instanceof ProtocolError) reject(connection, error);
        else reject(connection, new ProtocolError("internal", "message could not be processed"));
      }
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      stats.connections -= 1;
      if (connection.role === "host" && connection.room) {
        connection.room.close();
      } else if (connection.role === "controller" && connection.room) {
        connection.room.detach(connection);
      }
    });
    socket.on("error", () => {});
  });

  let last = process.hrtime.bigint();
  let snapshotCounter = 0;
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const delta = Number(now - last) / 1e9;
    last = now;
    stats.ticks += 1;
    const ms = delta * 1000;
    stats.tickMs.min = Math.min(stats.tickMs.min, ms);
    stats.tickMs.max = Math.max(stats.tickMs.max, ms);
    stats.tickMs.total += ms;
    for (const room of rooms.values()) {
      const events = room.match.step(delta);
      for (const event of events) room.handleEvent(event);
      snapshotCounter += 1;
      if (snapshotCounter % 3 === 0) {
        const snapshot = room.match.snapshot();
        room.broadcast({ type: "state", ...snapshot, slots: room.slots() });
        stats.snapshots += 1;
      }
    }
  }, Math.round(1000 / 60));

  await new Promise((resolveListen) => httpServer.listen(port, host, resolveListen));
  const address = httpServer.address();
  const url = `http://${host}:${address.port}`;

  return {
    url,
    port: address.port,
    httpServer,
    wss,
    rooms,
    stats: publicStats,
    close: async () => {
      clearInterval(timer);
      for (const room of rooms.values()) room.close();
      for (const client of wss.clients) client.terminate();
      await new Promise((resolveClose) => wss.close(resolveClose));
      await new Promise((resolveClose) => {
        httpServer.close(resolveClose);
        httpServer.closeAllConnections?.();
      });
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith("server.mjs")) {
  const { createCommentary } = await import("./commentary.mjs");
  const commentary = createCommentary();
  const server = await startServer({ port: Number(process.env.PORT ?? 8765), host: process.env.HOST ?? "0.0.0.0", commentary });
  console.log(`motion rally bridge on ${server.url}`);
  console.log(`commentary: ${commentary.enabled ? "enabled" : `disabled (${commentary.reason})`}`);
}
