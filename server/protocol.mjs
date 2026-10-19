import { randomInt } from 'node:crypto';
// Message schema and range checks for the rally bridge.
// Every rejected message carries a machine-readable reason; nothing is coerced.

export const LIMITS = {
  maxMessageBytes: 2048,
  maxNameLength: 24,
  maxInputHz: 90,
  maxAngle: 360,
  staleInputSeconds: 1.5,
};

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value, label, min = -Infinity, max = Infinity) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolError("bad_number", `${label} must be a finite number`);
  }
  if (value < min || value > max) {
    throw new ProtocolError("out_of_range", `${label} must be within [${min}, ${max}]`);
  }
  return value;
}

export function sanitizeName(value) {
  if (value === undefined || value === null) return "player";
  if (typeof value !== "string") throw new ProtocolError("bad_name", "name must be a string");
  const cleaned = value.replace(/[^\w \-.]/g, "").trim().slice(0, LIMITS.maxNameLength);
  if (!cleaned) throw new ProtocolError("bad_name", "name is empty after sanitising");
  return cleaned;
}

export function roomCode() {
  return String(randomInt(1000, 10000));
}

export function decode(raw) {
  if (typeof raw !== "string" && !Buffer.isBuffer(raw)) {
    throw new ProtocolError("bad_frame", "frame must be text");
  }
  const bytes = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(raw, "utf8");
  if (bytes > LIMITS.maxMessageBytes) {
    throw new ProtocolError("too_large", `frame exceeds ${LIMITS.maxMessageBytes} bytes`);
  }
  let message;
  try {
    message = JSON.parse(raw.toString ? raw.toString("utf8") : raw);
  } catch {
    throw new ProtocolError("bad_json", "frame is not valid JSON");
  }
  if (!isPlainObject(message)) throw new ProtocolError("bad_frame", "message must be an object");
  if (message.v !== 1) throw new ProtocolError("bad_version", "unsupported protocol version");
  if (typeof message.type !== "string") throw new ProtocolError("bad_type", "type must be a string");
  return message;
}

export function validateHello(message) {
  if (message.type !== "hello") throw new ProtocolError("bad_type", "expected hello");
  const role = message.role;
  if (role !== "host" && role !== "controller") {
    throw new ProtocolError("bad_role", "role must be host or controller");
  }
  const hello = { role, name: sanitizeName(message.name) };
  if (role === "controller") {
    if (typeof message.room !== "string" || !/^\d{4}$/.test(message.room)) {
      throw new ProtocolError("bad_room", "room must be four digits");
    }
    if (message.slot !== 1 && message.slot !== 2) {
      throw new ProtocolError("bad_slot", "slot must be 1 or 2");
    }
    hello.room = message.room;
    hello.slot = message.slot;
    if (typeof message.token !== 'string' || !/^[0-9a-f]{32}$/.test(message.token)) {
      throw new ProtocolError('bad_token', 'pairing token required');
    }
    hello.token = message.token;
  }
  return hello;
}

export function validateInput(message) {
  if (message.type !== "input") throw new ProtocolError("bad_type", "expected input");
  const input = {
    seq: Math.trunc(finiteNumber(message.seq, "seq", 0, Number.MAX_SAFE_INTEGER)),
    timestamp: finiteNumber(message.timestamp, "timestamp", 0, 1e12),
    beta: finiteNumber(message.beta, "beta", -LIMITS.maxAngle, LIMITS.maxAngle),
    gamma: finiteNumber(message.gamma, "gamma", -LIMITS.maxAngle, LIMITS.maxAngle),
    alpha: finiteNumber(message.alpha ?? 0, "alpha", -LIMITS.maxAngle, LIMITS.maxAngle),
  };
  if (!Number.isSafeInteger(message.seq)) throw new ProtocolError('bad_seq', 'sequence must be an integer');
  return input;
}

export function validateCalibrate(message) {
  if (message.type !== "calibrate") throw new ProtocolError("bad_type", "expected calibrate");
  return {
    beta: finiteNumber(message.beta, "beta", -LIMITS.maxAngle, LIMITS.maxAngle),
    gamma: finiteNumber(message.gamma, "gamma", -LIMITS.maxAngle, LIMITS.maxAngle),
  };
}

export function validateTouch(message) {
  if (message.type !== "touch") throw new ProtocolError("bad_type", "expected touch");
  return {
    x: finiteNumber(message.x, "x", -1, 1),
    swing: finiteNumber(message.swing ?? 0, "swing", 0, 1),
  };
}

export function normalizeMotion(input, calibration, previous) {
  const betaOffset = calibration?.beta ?? 0;
  const gammaOffset = calibration?.gamma ?? 0;
  const gammaDelta = input.gamma - gammaOffset;
  const betaDelta = input.beta - betaOffset;
  const x = Math.max(-1, Math.min(1, gammaDelta / 45));
  let swing = 0;
  if (previous && Number.isFinite(previous.beta)) {
    const elapsed = Number.isFinite(input.timestamp) && Number.isFinite(previous.timestamp) ? (input.timestamp - previous.timestamp) / 1000 : 0.045;
    const dt = Math.max(0.005, Math.min(0.25, elapsed));
    const delta = ((input.beta - previous.beta + 540) % 360) - 180;
    const rate = Math.abs(delta) / dt;
    swing = Math.max(0, Math.min(1, rate / 90));
  }
  return { x, swing, betaDelta: Math.max(-180, Math.min(180, betaDelta)) };
}
