// Node tests: protocol validation, deterministic physics, rooms and TTS gating.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { Match, COURT } from "../server/game.mjs";
import {
  LIMITS, ProtocolError, decode, normalizeMotion, roomCode, sanitizeName,
  validateCalibrate, validateHello, validateInput, validateTouch,
} from "../server/protocol.mjs";
import { createCommentary } from "../server/commentary.mjs";
import { startServer } from "../server/server.mjs";

// ------------------------------------------------------------------ protocol
test("decode rejects bad frames and versions", () => {
  assert.throws(() => decode("{not json"), (error) => error instanceof ProtocolError && error.code === "bad_json");
  assert.throws(() => decode(JSON.stringify({ v: 2, type: "hello" })), /unsupported protocol version/);
  assert.throws(() => decode(JSON.stringify({ v: 1 })), /type must be a string/);
  assert.throws(() => decode(JSON.stringify([1, 2, 3])), /must be an object/);
  const big = "x".repeat(LIMITS.maxMessageBytes + 1);
  assert.throws(() => decode(JSON.stringify({ v: 1, type: "input", pad: big })), /exceeds/);
});

test("hello validation enforces role, room and slot", () => {
  assert.deepEqual(validateHello({ v: 1, type: "hello", role: "host", name: "court" }), { role: "host", name: "court" });
  assert.throws(() => validateHello({ v: 1, type: "hello", role: "player" }), /role must be/);
  assert.throws(() => validateHello({ v: 1, type: "hello", role: "controller", room: "12", slot: 1 }), /four digits/);
  assert.throws(() => validateHello({ v: 1, type: "hello", role: "controller", room: "1234", slot: 3 }), /slot must be/);
  assert.throws(() => validateHello({ v: 1, type: "hello", role: "controller", room: "1234", slot: 1, name: "!!!" }), /empty/);
});

test("names are sanitised and bounded", () => {
  assert.equal(sanitizeName("  Ardhya <b> "), "Ardhya b");
  assert.equal(sanitizeName(undefined), "player");
  assert.equal(sanitizeName("x".repeat(80)).length, LIMITS.maxNameLength);
});

test("input validation rejects non-finite and out-of-range values", () => {
  const good = { v: 1, type: "input", seq: 1, timestamp: 100, beta: 10, gamma: -20, alpha: 5 };
  assert.deepEqual(validateInput(good), { seq: 1, timestamp: 100, beta: 10, gamma: -20, alpha: 5 });
  assert.throws(() => validateInput({ ...good, beta: NaN }), /finite/);
  assert.throws(() => validateInput({ ...good, gamma: 500 }), /within/);
  assert.throws(() => validateInput({ ...good, seq: -1 }), /within/);
  assert.throws(() => validateInput({ ...good, timestamp: "now" }), /finite/);
});

test("calibrate and touch validation", () => {
  assert.deepEqual(validateCalibrate({ v: 1, type: "calibrate", beta: 4, gamma: -3 }), { beta: 4, gamma: -3 });
  assert.throws(() => validateCalibrate({ v: 1, type: "calibrate", beta: null, gamma: 0 }), /finite/);
  assert.deepEqual(validateTouch({ v: 1, type: "touch", x: 0.5, swing: 1 }), { x: 0.5, swing: 1 });
  assert.throws(() => validateTouch({ v: 1, type: "touch", x: 2 }), /within/);
});

test("room codes are four digits", () => {
  for (let i = 0; i < 20; i += 1) assert.match(roomCode(), /^\d{4}$/);
});

test("motion normalisation applies calibration and clamps", () => {
  const normalized = normalizeMotion({ beta: 30, gamma: 50, alpha: 0 }, { beta: 10, gamma: 5 }, { beta: 30 });
  assert.equal(normalized.x, 1);
  assert.ok(normalized.swing >= 0 && normalized.swing <= 1);
  const uncalibrated = normalizeMotion({ beta: 0, gamma: 0, alpha: 0 }, null, null);
  assert.equal(uncalibrated.x, 0);
  assert.equal(uncalibrated.swing, 0);
});

// ------------------------------------------------------------------ physics
function freshMatch() {
  return new Match({ seed: 424242 });
}

test("fixed-step simulation is deterministic", () => {
  function run() {
    const match = freshMatch();
    for (let i = 0; i < 600; i += 1) {
      match.setInput(1, { x: 0.2, swing: i % 60 < 3 ? 1 : 0, timestamp: 0, seq: i });
      match.setInput(2, { x: -0.1, swing: i % 50 < 2 ? 0.8 : 0, timestamp: 0, seq: i });
      match.step(1 / 120);
    }
    return JSON.stringify(match.snapshot());
  }
  assert.equal(run(), run());
});

test("ball falls and bounces with restitution below one", () => {
  const match = freshMatch();
  match.phase = "rally";
  match.ball = { x: 0, y: 1.2, z: 3, vx: 0, vy: 0, vz: 0 };
  let bounced = null;
  for (let i = 0; i < 200 && !bounced; i += 1) {
    const events = match.step(1 / 120);
    bounced = events.find((event) => event.type === "bounce") ?? null;
  }
  assert.ok(bounced);
  assert.ok(match.ball.vy > 0);
  assert.ok(Math.abs(match.ball.vy) < 9.81 * 0.6);
});

test("a ball beyond the baseline awards the point", () => {
  const match = freshMatch();
  match.phase = "rally";
  match.lastHitter = 1;
  match.ball = { x: 0, y: 1, z: 11.8, vx: 0, vy: 0, vz: 8 };
  const events = match.step(0.05);
  const point = events.find((event) => event.type === "point");
  assert.ok(point, JSON.stringify(events));
  assert.equal(point.slot, 2);
  assert.equal(match.score[2], 1);
});

test("a swinging paddle in reach returns the ball", () => {
  const match = freshMatch();
  match.phase = "rally";
  match.lastHitter = 2;
  match.players[1].inputAt = 999;
  match.players[1].swing = 1;
  match.players[1].x = 0;
  match.ball = { x: 0, y: 1.0, z: 11.16, vx: 0, vy: 0, vz: 6 };
  let hit = null;
  for (let i = 0; i < 10 && !hit; i += 1) hit = match.step(1 / 120).find((event) => event.type === "hit") ?? null;
  assert.ok(hit, "expected a hit event");
  assert.ok(match.ball.vz < 0);
  assert.equal(hit.slot, 1);
});

test("a missing paddle awards the opponent", () => {
  const match = freshMatch();
  match.phase = "rally";
  match.lastHitter = 2;
  match.players[1].swing = 0;
  match.players[1].x = 1;
  match.ball = { x: -3.5, y: 1.0, z: 11.16, vx: 0, vy: 0, vz: 6 };
  let point = null;
  for (let i = 0; i < 10 && !point; i += 1) point = match.step(1 / 120).find((event) => event.type === "point") ?? null;
  assert.ok(point);
  assert.equal(point.slot, 2);
  assert.equal(point.reason, "unreturned");
});

test("stale input decays to neutral", () => {
  const match = freshMatch();
  match.setInput(1, { x: 1, swing: 1, timestamp: 0, seq: 1 });
  for (let i = 0; i < 6; i += 1) match.step(0.25);
  assert.equal(match.players[1].x, 0);
  assert.equal(match.players[1].swing, 0);
});

test("serve alternates after each point", () => {
  const match = freshMatch();
  assert.equal(match.server, 1);
  match.awardPoint(1, "out");
  assert.equal(match.server, 2);
  match.awardPoint(2, "out");
  assert.equal(match.server, 1);
});

test("snapshot exposes the documented state shape", () => {
  const snapshot = freshMatch().snapshot();
  for (const key of ["tick", "time", "phase", "server", "rally", "score", "ball", "paddles", "stats"]) {
    assert.ok(key in snapshot, key);
  }
  assert.equal(snapshot.score[1], 0);
  assert.equal(COURT.netHeight, 0.914);
});

// ------------------------------------------------------------------ commentary
test("commentary is disabled without a key and performs no fetch", async () => {
  let calls = 0;
  const commentary = createCommentary({ apiKey: undefined, fetchImpl: async () => { calls += 1; } });
  assert.equal(commentary.enabled, false);
  assert.match(commentary.reason, /GEMINI_API_KEY/);
  const result = await commentary.speak("test");
  assert.equal(result.audio, null);
  assert.equal(calls, 0);
});

test("commentary calls the provider only when a key is configured", async () => {
  let calls = 0;
  let body = null;
  const fetchImpl = async (url, options) => {
    calls += 1;
    body = JSON.parse(options.body);
    assert.match(url, /generativelanguage\.googleapis\.com/);
    assert.equal(options.headers['x-goog-api-key'], 'test-key');
    assert.ok(!url.includes('test-key'));
    return {
      ok: true,
      async json() {
        return { candidates: [{ content: { parts: [{ inlineData: { data: "AAAA", mimeType: "audio/L16" } }] } }] };
      },
    };
  };
  const commentary = createCommentary({ apiKey: "test-key", enabled: true, fetchImpl });
  assert.equal(commentary.enabled, true);
  const result = await commentary.speak("Poin untuk pemain 1.");
  assert.equal(calls, 1);
  assert.equal(result.audio, "AAAA");
  assert.equal(body.generationConfig.responseModalities[0], "AUDIO");
});

// ------------------------------------------------------------------ server
function connect(url) {
  const socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws`);
  const messages = [];
  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  return {
    socket,
    messages,
    opened,
    send: (message) => socket.send(JSON.stringify({ v: 1, ...message })),
    async waitFor(type, timeout = 3000) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const found = messages.find((message) => message.type === type);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`timed out waiting for ${type}; saw ${messages.map((m) => m.type).join(",")}`);
    },
  };
}

test("rooms pair two controllers and reject a duplicate slot", async (t) => {
  const commentary = createCommentary({ apiKey: undefined });
  const server = await startServer({ port: 0, commentary });
  t.after(() => server.close());

  const host = connect(server.url);
  await host.opened;
  host.send({ type: "hello", role: "host", name: "court" });
  const room = await host.waitFor("room");
  assert.match(room.code, /^\d{4}$/);

  const phone1 = connect(server.url);
  await phone1.opened;
  phone1.send({ type: "hello", role: "controller", room: room.code, token: room.token, slot: 1, name: "phone-1" });
  const joined1 = await phone1.waitFor("room");
  assert.equal(joined1.slot, 1);
  await host.waitFor("presence");

  const duplicate = connect(server.url);
  await duplicate.opened;
  duplicate.send({ type: "hello", role: "controller", room: room.code, token: room.token, slot: 1, name: "phone-dup" });
  const error = await duplicate.waitFor("error");
  assert.equal(error.code, "slot_taken");
  duplicate.socket.close();

  phone1.send({ type: "input", seq: 1, timestamp: 10, beta: 5, gamma: 40, alpha: 0 });
  phone1.send({ type: "input", seq: 2, timestamp: 40, beta: 40, gamma: 40, alpha: 0 });
  const state = await host.waitFor("state");
  assert.ok(state.ball && state.paddles);

  const health = await (await fetch(`${server.url}/healthz`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.rooms.length, 1);
  assert.equal(health.commentary.enabled, false);
  assert.ok(health.stats.ticks >= 0);
});

test("controller disconnect updates presence, host close closes room", async (t) => {
  const server = await startServer({ port: 0, commentary: createCommentary({ apiKey: undefined }) });
  t.after(() => server.close());
  const host = connect(server.url);
  await host.opened;
  host.send({ type: "hello", role: "host", name: "court" });
  const room = await host.waitFor("room");

  const phone = connect(server.url);
  await phone.opened;
  phone.send({ type: "hello", role: "controller", room: room.code, token: room.token, slot: 2, name: "phone-2" });
  await phone.waitFor("room");
  const presence = await host.waitFor("presence");
  assert.equal(presence.slots.find((slot) => slot.slot === 2).connected, true);

  phone.socket.close();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const after = host.messages.filter((message) => message.type === "presence").at(-1);
  assert.equal(after.slots.find((slot) => slot.slot === 2).connected, false);

  host.socket.close();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const health = await (await fetch(`${server.url}/healthz`)).json();
  assert.equal(health.rooms.length, 0);
});

test("invalid controller messages are rejected without crashing", async (t) => {
  const server = await startServer({ port: 0, commentary: createCommentary({ apiKey: undefined }) });
  t.after(() => server.close());
  const host = connect(server.url);
  await host.opened;
  host.send({ type: "hello", role: "host", name: "court" });
  const room = await host.waitFor("room");

  const phone = connect(server.url);
  await phone.opened;
  phone.send({ type: "hello", role: "controller", room: room.code, token: room.token, slot: 1, name: "phone-1" });
  await phone.waitFor("room");
  phone.send({ type: "input", seq: 1, timestamp: 1, beta: NaN, gamma: 0, alpha: 0 });
  phone.socket.send(JSON.stringify({ v: 1, type: "input", seq: 1, timestamp: 1, beta: "nan", gamma: 0 }));
  const first = await phone.waitFor("error");
  assert.ok(["bad_number", "bad_json", "internal"].includes(first.code));
  phone.send({ type: "input", seq: 1, timestamp: 2, beta: 1, gamma: 1, alpha: 0 });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const health = await (await fetch(`${server.url}/healthz`)).json();
  assert.ok(health.stats.rejected >= 1);
});

test("static files, health endpoint and traversal guard", async (t) => {
  const server = await startServer({ port: 0, commentary: createCommentary({ apiKey: undefined }) });
  t.after(() => server.close());
  const home = await fetch(`${server.url}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Motion rally/);
  const controller = await fetch(`${server.url}/controller`);
  assert.equal(controller.status, 200);
  const missing = await fetch(`${server.url}/nope`);
  assert.equal(missing.status, 404);
  const traversal = await fetch(`${server.url}/..%2Fserver%2Fgame.mjs`);
  assert.ok([403, 404].includes(traversal.status));
});


test("ambient credentials never enable TTS and explicit opt-in is required", async () => {
  let calls = 0;
  const commentary = createCommentary({apiKey: "synthetic-key", fetchImpl: async () => { calls++; }});
  assert.equal(commentary.enabled, false);
  await commentary.speak("synthetic test");
  assert.equal(calls, 0);
});

test("pairing token and integer sequences are required", () => {
  assert.throws(() => validateHello({type:"hello", role:"controller", room:"1234", slot:1}), /token/);
  assert.throws(() => validateInput({type:"input",seq:1.5,timestamp:1,beta:0,gamma:0}), /integer/);
});

test("wrong token cannot join a room or leak its token via health", async (t) => {
  const server = await startServer({port:0}); t.after(() => server.close());
  const host = connect(server.url); await host.opened;
  host.send({type:"hello",role:"host"});
  const room = await host.waitFor("room");
  assert.match(room.token, /^[0-9a-f]{32}$/);
  const phone = connect(server.url); await phone.opened;
  phone.send({type:"hello",role:"controller",room:room.code,token:"0".repeat(32),slot:1});
  assert.equal((await phone.waitFor("error")).code,"bad_token");
  assert.ok(!(await (await fetch(`${server.url}/healthz`)).text()).includes(room.token));
});

test("cross-origin websocket is rejected", async(t) => {
  const server = await startServer({port:0}); t.after(() => server.close());
  await new Promise(resolve => {
    const socket = new WebSocket(server.url.replace('http','ws')+'/ws', {origin:'https://unrelated.example'});
    socket.once('open', () => assert.fail('cross-origin websocket unexpectedly opened'));
    socket.once('error', resolve);
  });
});

test("motion timestamps must increase without corrupting accepted state", async(t) => {
  const server = await startServer({port:0}); t.after(() => server.close());
  const host = connect(server.url); await host.opened; host.send({type:'hello',role:'host'});
  const room = await host.waitFor('room');
  const phone = connect(server.url); await phone.opened;
  phone.send({type:'hello',role:'controller',room:room.code,token:room.token,slot:1});
  await phone.waitFor('room');
  phone.send({type:'input',seq:1,timestamp:100,beta:0,gamma:0});
  phone.send({type:'input',seq:2,timestamp:99,beta:0,gamma:0});
  assert.equal((await phone.waitFor('error')).code,'stale_timestamp');
});
