// Deterministic, server-authoritative rally physics.
// Fixed 1/120 s simulation tick; no wall-clock or randomness inside a step except
// the seeded serve generator, so replays with identical inputs are identical.

export const TICK_HZ = 120;
export const DT = 1 / TICK_HZ;
export const COURT = {
  halfWidth: 4.115,
  baseline: 11.885,
  netHeight: 0.914,
  netHalfWidth: 5.485,
  paddlePlane: 11.2,
  paddleReach: 0.55,
  paddleMinY: 0.2,
  paddleMaxY: 1.9,
  ballRadius: 0.0335,
  gravity: 9.81,
  restitution: 0.78,
  drag: 0.055,
  maxSpeed: 30,
};

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function length(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export class Match {
  constructor({ seed = 20261019 } = {}) {
    this.random = mulberry32(seed);
    this.tick = 0;
    this.time = 0;
    this.accumulator = 0;
    this.phase = "serve";
    this.phaseTimer = 1.0;
    this.server = 1;
    this.rally = 0;
    this.lastHitter = null;
    this.events = [];
    this.players = {
      1: { x: 0, swing: 0, inputAt: -Infinity, lastSeq: -1, connected: true },
      2: { x: 0, swing: 0, inputAt: -Infinity, lastSeq: -1, connected: true },
    };
    this.score = { 1: 0, 2: 0 };
    this.ball = { x: 0, y: 1.1, z: 0, vx: 0, vy: 0, vz: 0 };
    this.serve();
  }

  serve() {
    const direction = this.server === 1 ? -1 : 1;
    const lateral = (this.random() - 0.5) * 2.4;
    this.ball = {
      x: lateral * 0.35,
      y: 1.15,
      z: direction * -9.6,
      vx: lateral,
      vy: 4.1,
      vz: direction * -9.4,
    };
    this.phase = "serve";
    this.phaseTimer = 0.55;
    this.rally = 0;
    this.lastHitter = this.server;
    this.stats = { aces: 0, longRallies: 0, net: 0, out: 0 };
  }

  setInput(slot, { x, swing, timestamp, seq }) {
    const player = this.players[slot];
    if (!player) return false;
    if (!Number.isFinite(x) || !Number.isFinite(swing)) return false;
    if (!Number.isFinite(timestamp)) return false;
    if (typeof seq === "number" && seq <= player.lastSeq) return false;
    player.x = Math.max(-1, Math.min(1, x));
    player.swing = Math.max(0, Math.min(1, swing));
    player.inputAt = this.time;
    if (typeof seq === "number") player.lastSeq = seq;
    return true;
  }

  setConnected(slot, connected) {
    if (this.players[slot]) this.players[slot].connected = connected;
  }

  step(deltaSeconds) {
    this.events = [];
    this.accumulator += Math.min(0.25, Math.max(0, deltaSeconds));
    while (this.accumulator >= DT) {
      this.accumulator -= DT;
      this.simulate(DT);
    }
    return this.events;
  }

  simulate(dt) {
    this.tick += 1;
    this.time += dt;
    // Input older than 750 ms is stale and treated as neutral.
    for (const slot of [1, 2]) {
      const player = this.players[slot];
      if (this.time - player.inputAt > 0.75) {
        player.x = 0;
        player.swing = 0;
      } else {
        player.swing *= 0.92;
      }
    }
    if (this.phase === "point") {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) this.serve();
      return;
    }
    if (this.phase === "serve") {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) this.phase = "rally";
    }
    this.integrate(dt);
  }

  integrate(dt) {
    const ball = this.ball;
    ball.vy -= COURT.gravity * dt;
    const speed = length(ball);
    const damp = 1 - COURT.drag * dt;
    ball.vx *= damp;
    ball.vy *= damp;
    ball.vz *= damp;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.z += ball.vz * dt;

    if (ball.y < COURT.ballRadius && ball.vy < 0) {
      ball.y = COURT.ballRadius;
      ball.vy = -ball.vy * COURT.restitution;
      ball.vx *= 0.94;
      ball.vz *= 0.94;
      this.events.push({ type: "bounce", x: ball.x, z: ball.z });
    }

    // Net plane crossing.
    if (Math.sign(ball.z) !== Math.sign(ball.z - ball.vz * dt) || Math.abs(ball.z) < 0.05) {
      if (Math.abs(ball.x) < COURT.netHalfWidth && ball.y < COURT.netHeight) {
        this.events.push({ type: "net" });
        this.stats.net += 1;
        this.awardPoint(this.lastHitter === 1 ? 2 : 1, "net");
        return;
      }
    }

    // Paddle planes.
    for (const slot of [1, 2]) {
      const plane = slot === 1 ? COURT.paddlePlane : -COURT.paddlePlane;
      const outward = slot === 1 ? 1 : -1;
      const crossed = outward * (ball.z - plane) >= 0 && outward * (ball.z - plane - ball.vz * dt) < 0;
      if (!crossed || outward * ball.vz <= 0) continue;
      const player = this.players[slot];
      const paddleX = player.x * 3.6;
      if (!player.connected) continue;
      const inReach = Math.abs(ball.x - paddleX) <= COURT.paddleReach &&
        ball.y >= COURT.paddleMinY && ball.y <= COURT.paddleMaxY;
      if (inReach && player.swing > 0.25) {
        this.hit(slot, paddleX, player.swing);
      } else {
        this.events.push({ type: "miss", slot });
        this.awardPoint(slot === 1 ? 2 : 1, "unreturned");
      }
      return;
    }

    // Out of bounds.
    if (Math.abs(ball.x) > COURT.halfWidth + 0.35 || Math.abs(ball.z) > COURT.baseline) {
      this.events.push({ type: "out", x: ball.x, z: ball.z });
      this.stats.out += 1;
      this.awardPoint(this.lastHitter === 1 ? 2 : 1, "out");
    }
  }

  hit(slot, paddleX, swing) {
    const ball = this.ball;
    const direction = slot === 1 ? -1 : 1;
    ball.vz = direction * Math.min(COURT.maxSpeed, Math.abs(ball.vz) * (0.85 + 0.35 * swing) + 1.5);
    ball.vy = 3.4 + 2.4 * swing + Math.max(0, 1.2 - ball.y) * 1.4;
    ball.vx = (0 - ball.x) * 0.35 + (paddleX / 3.6) * 1.6 * swing;
    ball.y = Math.max(ball.y, 0.55);
    this.lastHitter = slot;
    this.rally += 1;
    this.events.push({ type: "hit", slot, rally: this.rally, speed: length(ball) });
    if (this.rally === 8) {
      this.stats.longRallies += 1;
      this.events.push({ type: "long_rally", rally: this.rally });
    }
  }

  awardPoint(slot, reason) {
    this.score[slot] += 1;
    if (reason === "unreturned" && this.rally === 0) this.stats.aces += 1;
    this.events.push({ type: "point", slot, reason, score: { ...this.score } });
    this.phase = "point";
    this.phaseTimer = 1.4;
    this.server = slot === 1 ? 2 : 1;
    this.rally = 0;
  }

  snapshot() {
    return {
      tick: this.tick,
      time: Number(this.time.toFixed(4)),
      phase: this.phase,
      server: this.server,
      rally: this.rally,
      score: { ...this.score },
      ball: {
        x: round(this.ball.x), y: round(this.ball.y), z: round(this.ball.z),
        vx: round(this.ball.vx), vy: round(this.ball.vy), vz: round(this.ball.vz),
      },
      paddles: {
        1: { x: round(this.players[1].x), swing: round(this.players[1].swing), connected: this.players[1].connected },
        2: { x: round(this.players[2].x), swing: round(this.players[2].swing), connected: this.players[2].connected },
      },
      stats: { ...this.stats },
    };
  }
}

function round(value) {
  return Number(value.toFixed(4));
}
