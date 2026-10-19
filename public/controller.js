/* Phone controller: motion when permitted, touch fallback always. */
(function () {
  "use strict";

  const state = {
    connected: false, joined: false, room: null, slot: null, calibrated: false,
    mode: "idle", lastSendAt: 0, seq: 0, secure: window.isSecureContext, beta: null, gamma: null,
  };
  window.__CONTROLLER_STATE__ = state;

  const els = {
    connection: document.getElementById("connection"),
    context: document.getElementById("context"),
    form: document.getElementById("join-form"),
    room: document.getElementById("room-input"),
    slot: document.getElementById("slot-select"),
    join: document.getElementById("join"),
    play: document.getElementById("play"),
    motion: document.getElementById("motion-btn"),
    calibrate: document.getElementById("calibrate"),
    touchToggle: document.getElementById("touch-toggle"),
    touchPad: document.getElementById("touch-pad"),
    beta: document.getElementById("beta"),
    gamma: document.getElementById("gamma"),
    swing: document.getElementById("swing"),
    status: document.getElementById("status"),
    secureNote: document.getElementById("secure-note"),
  };

  function badge(element, text, kind) {
    element.textContent = text;
    element.className = "badge" + (kind ? " " + kind : "");
  }

  badge(els.context, state.secure ? "secure context" : "insecure context", state.secure ? "ok" : "warn");
  if (!state.secure) {
    els.secureNote.classList.add("warning");
    els.secureNote.textContent += " This page is not a secure context, so motion events may be unavailable.";
  }
  if (!("DeviceOrientationEvent" in window)) {
    els.motion.textContent = "Motion sensors unavailable — use touch";
    els.motion.disabled = true;
  }

  let socket = null;

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    const room = els.room.value.trim();
    if (!/^\d{4}$/.test(room)) {
      els.status.textContent = "Room code must be four digits.";
      return;
    }
    connect(room, Number(els.slot.value));
  });

  function connect(room, slot) {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/ws`);
    socket.addEventListener("open", () => {
      state.connected = true;
      badge(els.connection, "connecting", "warn");
      socket.send(JSON.stringify({ v: 1, type: "hello", role: "controller", room, slot, name: `phone-${slot}` }));
    });
    socket.addEventListener("message", (event) => handle(JSON.parse(event.data)));
    socket.addEventListener("close", () => {
      state.connected = false;
      badge(els.connection, "disconnected", "bad");
      els.status.textContent = "Connection closed. Reload to rejoin.";
    });
    socket.addEventListener("error", () => badge(els.connection, "error", "bad"));
  }

  function handle(message) {
    if (message.type === "room") {
      state.joined = true;
      state.room = message.code;
      state.slot = message.slot;
      badge(els.connection, `joined · player ${message.slot}`, "ok");
      els.join.disabled = true;
      els.room.disabled = true;
      els.slot.disabled = true;
      els.play.style.display = "block";
      els.status.textContent = "Joined. Enable motion or switch to touch.";
    } else if (message.type === "calibrated") {
      state.calibrated = true;
      els.calibrate.disabled = true;
      els.status.textContent = "Neutral pose stored. Tilt to steer, flick to swing.";
    } else if (message.type === "error") {
      els.status.textContent = `Rejected: ${message.message} (${message.code})`;
      badge(els.connection, message.code, "bad");
      if (message.code === "slot_taken" || message.code === "no_room") {
        els.join.disabled = false;
        els.room.disabled = false;
        els.slot.disabled = false;
      }
    } else if (message.type === "closed") {
      els.status.textContent = "The court closed.";
    }
  }

  // ------------------------------------------------------------- motion
  let motionHandler = null;
  let lastBetaForRate = null;

  async function enableMotion() {
    try {
      if (typeof DeviceOrientationEvent.requestPermission === "function") {
        const response = await DeviceOrientationEvent.requestPermission();
        if (response !== "granted") {
          els.status.textContent = "Motion permission denied. Touch controls remain available.";
          return;
        }
      }
      motionHandler = (event) => {
        if (event.beta === null || event.gamma === null) return;
        state.beta = event.beta;
        state.gamma = event.gamma;
        els.beta.textContent = event.beta.toFixed(0);
        els.gamma.textContent = event.gamma.toFixed(0);
        sendMotion();
      };
      window.addEventListener("deviceorientation", motionHandler);
      state.mode = "motion";
      els.calibrate.disabled = false;
      els.motion.disabled = true;
      els.touchPad.classList.remove("on");
      els.status.textContent = state.calibrated
        ? "Motion active. Tilt to steer."
        : "Motion active. Calibrate your neutral pose.";
    } catch (error) {
      els.status.textContent = `Motion could not start: ${error.message}. Use touch controls.`;
    }
  }

  function sendMotion() {
    if (!socket || socket.readyState !== WebSocket.OPEN || !state.joined) return;
    const now = performance.now();
    if (now - state.lastSendAt < 33) return;
    state.lastSendAt = now;
    state.seq += 1;
    socket.send(JSON.stringify({
      v: 1, type: "input", seq: state.seq, timestamp: now,
      beta: state.beta ?? 0, gamma: state.gamma ?? 0, alpha: 0,
    }));
    const rate = lastBetaForRate === null ? 0 : Math.min(1, Math.abs(state.beta - lastBetaForRate) / 12);
    els.swing.textContent = rate.toFixed(2);
    lastBetaForRate = state.beta;
  }

  els.motion.addEventListener("click", enableMotion);
  els.calibrate.addEventListener("click", () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      v: 1, type: "calibrate", beta: state.beta ?? 0, gamma: state.gamma ?? 0,
    }));
  });

  // ------------------------------------------------------------- touch
  let touchX = 0;
  let swingUntil = 0;
  let touching = false;

  els.touchToggle.addEventListener("click", () => {
    const on = els.touchPad.classList.toggle("on");
    state.mode = on ? "touch" : "idle";
    els.touchToggle.textContent = on ? "Hide touch controls" : "Use touch controls instead";
    els.status.textContent = on ? "Touch mode. Drag to steer, quick tap to swing." : "Touch mode off.";
    els.touchPad.style.display = on ? "grid" : "none";
    if (on) {
      if (motionHandler) {
        window.removeEventListener("deviceorientation", motionHandler);
        motionHandler = null;
        state.mode = "touch";
      }
      els.motion.disabled = true;
    }
  });

  els.touchPad.addEventListener("pointerdown", (event) => {
    touching = true;
    swingUntil = performance.now() + 160;
    updateTouch(event);
    els.touchPad.setPointerCapture && els.touchPad.setPointerCapture(event.pointerId);
  });
  els.touchPad.addEventListener("pointermove", (event) => { if (touching) updateTouch(event); });
  window.addEventListener("pointerup", () => { touching = false; });

  function updateTouch(event) {
    const rect = els.touchPad.getBoundingClientRect();
    touchX = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1));
    els.beta.textContent = "—";
    els.gamma.textContent = (touchX * 45).toFixed(0);
  }

  setInterval(() => {
    if (state.mode !== "touch" || !socket || socket.readyState !== WebSocket.OPEN || !state.joined) return;
    state.seq += 1;
    const swing = performance.now() < swingUntil ? 1 : 0;
    socket.send(JSON.stringify({ v: 1, type: "touch", x: touchX, swing, seq: state.seq, timestamp: performance.now() }));
    els.swing.textContent = swing ? "1.00" : "0.00";
  }, 40);
})();
