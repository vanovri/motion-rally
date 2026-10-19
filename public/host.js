/* Court display: consumes server snapshots and renders a simple 3D court. */
(function () {
  "use strict";

  const state = {
    connected: false, room: null, snapshot: null, slots: [], commentary: [], tts: false,
  };
  window.__RALLY_STATE__ = state;

  const els = {
    connection: document.getElementById("connection"),
    presence: document.getElementById("presence"),
    room: document.getElementById("room-code"),
    score1: document.getElementById("score-1"),
    score2: document.getElementById("score-2"),
    phase: document.getElementById("phase"),
    rally: document.getElementById("rally"),
    commentary: document.getElementById("commentary"),
    tts: document.getElementById("tts"),
  };

  function setBadge(element, text, kind) {
    element.textContent = text;
    element.className = "badge" + (kind ? " " + kind : "");
  }

  // ---------------------------------------------------------------- socket
  let socket = null;
  let reconnectTimer = null;

  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/ws`);
    socket.addEventListener("open", () => {
      state.connected = true;
      setBadge(els.connection, "bridge online", "ok");
      socket.send(JSON.stringify({ v: 1, type: "hello", role: "host", name: "court" }));
    });
    socket.addEventListener("close", () => {
      state.connected = false;
      setBadge(els.connection, "reconnecting", "warn");
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 1500);
    });
    socket.addEventListener("error", () => setBadge(els.connection, "bridge error", "bad"));
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      handle(message);
    });
  }

  function handle(message) {
    if (message.type === "room") {
      state.room = message.code;
      els.room.textContent = message.code;
    } else if (message.type === "state") {
      applyState(message);
    } else if (message.type === "presence") {
      applySlots(message.slots);
    } else if (message.type === "commentary") {
      addCommentary(message.text);
    } else if (message.type === "commentary_audio") {
      setBadge(els.tts, "voice commentary", "ok");
    } else if (message.type === "closed") {
      setBadge(els.connection, "room closed", "bad");
    }
  }

  function applyState(snapshot) {
    state.snapshot = snapshot;
    state.slots = snapshot.slots ?? state.slots;
    els.score1.textContent = String(snapshot.score[1]);
    els.score2.textContent = String(snapshot.score[2]);
    els.phase.textContent = snapshot.phase === "point" ? "point" : snapshot.phase === "serve" ? "serve" : "rally";
    els.rally.textContent = `Rally ${snapshot.rally}`;
    applySlots(state.slots);
    pushFrame(snapshot);
  }

  function applySlots(slots) {
    if (!slots) return;
    state.slots = slots;
    const online = slots.filter((slot) => slot.connected).length;
    setBadge(els.presence, `${online} / 2 phones`, online === 2 ? "ok" : online === 1 ? "warn" : "");
    for (const slot of slots) {
      const row = document.getElementById(`player-${slot.slot}`);
      const name = document.getElementById(`name-${slot.slot}`);
      const status = document.getElementById(`state-${slot.slot}`);
      name.textContent = slot.connected ? slot.name : "waiting";
      status.textContent = slot.connected ? (slot.stale ? "stale input" : slot.calibrated ? "calibrated" : "connected") : "offline";
      row.className = "player-row" + (slot.connected ? " online" : "") + (slot.stale ? " stale" : "");
    }
  }

  function addCommentary(text) {
    if (!text) return;
    state.commentary.unshift({ text, at: Date.now() });
    state.commentary = state.commentary.slice(0, 8);
    els.commentary.innerHTML = "";
    for (const entry of state.commentary) {
      const item = document.createElement("li");
      const time = new Date(entry.at).toLocaleTimeString([], { hour12: false });
      item.innerHTML = `<b>${time}</b> · `;
      item.appendChild(document.createTextNode(entry.text));
      els.commentary.appendChild(item);
    }
  }

  // ---------------------------------------------------------------- three
  const canvas = document.getElementById("court");
  const THREE = window.THREE;
  let renderer, scene, camera, ball, paddle1, paddle2, ballTrail;
  let frames = [];
  let orbit = { yaw: 0, pitch: 0.58, distance: 34, dragging: false };

  function buildCourt() {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.setClearColor(0x060a12, 1);
    renderer.outputEncoding = THREE.sRGBEncoding;

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x060a12, 30, 70);

    camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 240);
    camera.position.set(0, 11, 17);

    scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x0a141c, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.75);
    key.position.set(8, 16, 10);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x38bdf8, 0.45);
    rim.position.set(-10, 8, -12);
    scene.add(rim);

    const court = new THREE.Mesh(
      new THREE.PlaneGeometry(8.23, 23.77),
      new THREE.MeshStandardMaterial({ color: 0x173a2e, roughness: 1.0 })
    );
    court.rotation.x = -Math.PI / 2;
    scene.add(court);

    const surround = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 30),
      new THREE.MeshStandardMaterial({ color: 0x0e1c16, roughness: 1.0 })
    );
    surround.rotation.x = -Math.PI / 2;
    surround.position.y = -0.01;
    scene.add(surround);

    const lineMaterial = new THREE.LineBasicMaterial({ color: 0xd7e5ef, transparent: true, opacity: 0.85 });
    const lines = [];
    const w = 8.23 / 2, l = 23.77 / 2;
    lines.push(-w, 0.005, -l, w, 0.005, -l, w, 0.005, l, -w, 0.005, l, -w, 0.005, -l);
    lines.push(-w, 0.005, 0, w, 0.005, 0); // net line
    for (const z of [-6.4, 6.4]) lines.push(-w, 0.005, z, w, 0.005, z);
    lines.push(0, 0.005, -6.4, 0, 0.005, 6.4);
    for (const z of [-6.4, 6.4]) lines.push(0, 0.005, z, 0, 0.005, z < 0 ? -l : l);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
    scene.add(new THREE.LineSegments(geometry, lineMaterial));

    const net = new THREE.Mesh(
      new THREE.PlaneGeometry(10.97, 0.914),
      new THREE.MeshStandardMaterial({ color: 0x93a9b8, transparent: true, opacity: 0.32, side: THREE.DoubleSide })
    );
    net.position.set(0, 0.457, 0);
    scene.add(net);

    ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.085, 20, 14),
      new THREE.MeshStandardMaterial({ color: 0xd8f06a, emissive: 0x3f4d10, roughness: 0.4 })
    );
    scene.add(ball);

    const paddleMaterial = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.5, emissive: 0x0b3346 });
    paddle1 = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.92, 0.06), paddleMaterial);
    paddle2 = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.92, 0.06), paddleMaterial.clone());
    paddle2.material.color.set(0xf59e0b);
    paddle1.position.set(0, 0.9, 11.2);
    paddle2.position.set(0, 0.9, -11.2);
    scene.add(paddle1, paddle2);

    const trailPoints = new Float32Array(90);
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute("position", new THREE.BufferAttribute(trailPoints, 3));
    ballTrail = new THREE.Line(trailGeometry, new THREE.LineBasicMaterial({ color: 0xa3e635, transparent: true, opacity: 0.55 }));
    scene.add(ballTrail);

    canvas.addEventListener("pointerdown", (event) => {
      orbit.dragging = true;
      orbit.sx = event.clientX;
      orbit.sy = event.clientY;
      orbit.yaw0 = orbit.yaw;
      orbit.pitch0 = orbit.pitch;
      canvas.classList.add("dragging");
      canvas.setPointerCapture && canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!orbit.dragging) return;
      orbit.yaw = orbit.yaw0 - (event.clientX - orbit.sx) / window.innerWidth * 2.4;
      orbit.pitch = Math.max(0.15, Math.min(1.2, orbit.pitch0 + (event.clientY - orbit.sy) / window.innerHeight * 1.6));
    });
    window.addEventListener("pointerup", () => { orbit.dragging = false; canvas.classList.remove("dragging"); });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      orbit.distance = Math.max(12, Math.min(46, orbit.distance * (1 + Math.sign(event.deltaY) * 0.1)));
    }, { passive: false });
    window.addEventListener("resize", () => {
      renderer.setSize(window.innerWidth, window.innerHeight, false);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    });
    animate();
  }

  function pushFrame(snapshot) {
    frames.push({ at: performance.now(), state: snapshot });
    if (frames.length > 3) frames.shift();
  }

  function currentBall() {
    if (!frames.length) return { x: 0, y: 1, z: 0 };
    const newest = frames[frames.length - 1].state.ball;
    if (frames.length === 1) return newest;
    const previous = frames[frames.length - 2];
    const latest = frames[frames.length - 1];
    const span = Math.max(1, latest.at - previous.at);
    const t = Math.min(1.25, (performance.now() - latest.at) / span);
    const from = previous.state.ball;
    return {
      x: from.x + (newest.x - from.x) * t,
      y: from.y + (newest.y - from.y) * t,
      z: from.z + (newest.z - from.z) * t,
    };
  }

  function animate() {
    requestAnimationFrame(animate);
    if (orbit) {
      camera.position.set(
        orbit.distance * Math.cos(orbit.pitch) * Math.sin(orbit.yaw),
        orbit.distance * Math.sin(orbit.pitch),
        orbit.distance * Math.cos(orbit.pitch) * Math.cos(orbit.yaw)
      );
      camera.lookAt(0, 0.6, 0);
    }
    if (ball) {
      const position = currentBall();
      ball.position.set(position.x, Math.max(0.06, position.y), position.z);
      const latest = frames[frames.length - 1];
      if (latest) {
        const { paddles } = latest.state;
        paddle1.position.x = paddles[1].x * 3.6;
        paddle2.position.x = paddles[2].x * 3.6;
        paddle1.material.emissiveIntensity = paddles[1].stale ? 0.1 : 0.35;
      }
      const positions = ballTrail.geometry.attributes.position;
      for (let i = positions.count - 1; i > 0; i -= 1) {
        positions.setXYZ(i, positions.getX(i - 1), positions.getY(i - 1), positions.getZ(i - 1));
      }
      positions.setXYZ(0, ball.position.x, ball.position.y, ball.position.z);
      positions.needsUpdate = true;
    }
    renderer.render(scene, camera);
    window.__RALLY_STATE__.frames = frames.length;
  }

  if (!THREE) {
    setBadge(els.connection, "webgl unavailable", "bad");
  } else {
    buildCourt();
  }
  connect();
})();
