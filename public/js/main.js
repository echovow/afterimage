(() => {
  // ========= Afterimage Arcade v3 (Flow Field + Obstacles + Pulse)
  // Drop-in main.js. No dependencies.

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d", { alpha: true });

  // Optional DOM (safe if missing)
  const els = {
    overlay: document.getElementById("overlay"),
    btnStart: document.getElementById("btnStart"),
    btnHow: document.getElementById("btnHow"),
    how: document.getElementById("how"),
    time: document.getElementById("time"),
    hint: document.getElementById("hint"),
    tLabel: document.getElementById("tLabel"),
    pump: document.getElementById("btnPump"), // optional button
  };

  // ---- config (tweak here)
  const CFG = {
    // Feel
    playerRadius: 10,
    baseAccel: 0.55,
    maxSpeed: 6.5,
    friction: 0.975,

    // Flow field
    flowStrength: 0.22,      // baseline drift
    flowStrengthRamp: 0.008, // added per 10s
    flowScale: 0.0032,       // spatial frequency
    flowSpeed: 0.22,         // time evolution
    flowVisualDensity: 42,   // lower = more field lines

    // Obstacles
    obstacleBaseCount: 3,
    obstacleRampEvery: 10,    // seconds to add another obstacle
    obstacleRadius: 10,
    obstacleSpeed: 1.65,
    obstacleSpeedRamp: 0.06,  // per 10s

    // Pulse (SPACE)
    pulseDuration: 0.85, // seconds
    pulseCooldown: 6.0,  // seconds
    pulseBoost: 2.0,     // acceleration multiplier
    pulseInvuln: 0.25,   // seconds at start of pulse

    // Aesthetic
    vignette: true,
    starCount: 120,
    trailLength: 26,
    trailFade: 0.86,

    // Links / lore
    pumpUrl: "https://pump.fun/", // change to your coin link later
    title: "AFTERIMAGE",
    lore: [
      "You are not the dot.",
      "You are the wake it leaves behind.",
      "Survive the drift. Outlast the pressure.",
    ],
  };

  // ========= utilities
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const len = (x, y) => Math.hypot(x, y);

  // deterministic-ish hash noise (fast)
  function hash2(x, y) {
    let n = x * 374761393 + y * 668265263;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) >>> 0) / 4294967295;
  }
  function smoothstep(t) { return t * t * (3 - 2 * t); }
  function valueNoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smoothstep(xf), v = smoothstep(yf);

    const a = hash2(xi, yi);
    const b = hash2(xi + 1, yi);
    const c = hash2(xi, yi + 1);
    const d = hash2(xi + 1, yi + 1);

    const ab = lerp(a, b, u);
    const cd = lerp(c, d, u);
    return lerp(ab, cd, v);
  }
  function flowVector(px, py, t) {
    // angle from noise → vector
    const s = CFG.flowScale;
    const n = valueNoise(px * s + t * CFG.flowSpeed, py * s + t * CFG.flowSpeed);
    const a = n * Math.PI * 2;
    return { x: Math.cos(a), y: Math.sin(a) };
  }

  // ========= sizing
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = Math.floor(window.innerWidth);
    H = Math.floor(window.innerHeight);
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();

  // ========= world
  const stars = Array.from({ length: CFG.starCount }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: 0.6 + Math.random() * 1.6,
    tw: Math.random() * 10,
  }));

  const state = {
    running: false,
    over: false,
    paused: false,
    t0: 0,
    t: 0,
    dt: 0,
    last: 0,

    // input
    keys: new Set(),
    pointerDown: false,
    pointerX: 0,
    pointerY: 0,

    // pulse
    pulseActive: false,
    pulseT: 0,
    pulseCooldownT: 0,

    // player
    p: { x: W * 0.5, y: H * 0.5, vx: 0, vy: 0 },
    trail: [],

    // obstacles
    obs: [],
  };

  function resetRun() {
    state.running = true;
    state.over = false;
    state.paused = false;

    state.t0 = performance.now();
    state.last = performance.now();
    state.t = 0;

    state.p = { x: W * 0.5, y: H * 0.5, vx: 0, vy: 0 };
    state.trail = [];
    state.obs = [];
    spawnObstacles(CFG.obstacleBaseCount);

    state.pulseActive = false;
    state.pulseT = 0;
    state.pulseCooldownT = 0;
  }

  function spawnObstacles(n) {
    for (let i = 0; i < n; i++) {
      const edge = Math.floor(Math.random() * 4);
      const pad = 40;
      let x = 0, y = 0;
      if (edge === 0) { x = -pad; y = Math.random() * H; }
      if (edge === 1) { x = W + pad; y = Math.random() * H; }
      if (edge === 2) { x = Math.random() * W; y = -pad; }
      if (edge === 3) { x = Math.random() * W; y = H + pad; }

      // aim vaguely toward center
      const dx = (W * 0.5 - x) + (Math.random() - 0.5) * 200;
      const dy = (H * 0.5 - y) + (Math.random() - 0.5) * 200;
      const d = Math.max(1, Math.hypot(dx, dy));
      const sp = CFG.obstacleSpeed;
      state.obs.push({
        x, y,
        vx: (dx / d) * sp,
        vy: (dy / d) * sp,
        r: CFG.obstacleRadius + Math.random() * 6,
        phase: Math.random() * 10,
      });
    }
  }

  // ========= overlay helpers
  function showOverlay(on) {
    if (!els.overlay) return;
    els.overlay.style.display = on ? "flex" : "none";
  }

  function setOverlayText() {
    if (!els.overlay) return;
    // If your HTML already has lore text, ignore. Otherwise, we can set hint.
    if (els.hint) {
      els.hint.innerHTML =
        `<div style="opacity:.9">${CFG.title}</div>` +
        `<div style="opacity:.7;margin-top:8px;line-height:1.4">${CFG.lore.join("<br>")}</div>` +
        `<div style="opacity:.55;margin-top:12px">WASD / Arrows • Mouse/Touch pull • SPACE Pulse • R Restart</div>`;
    }
    if (els.pump) {
      els.pump.onclick = () => window.open(CFG.pumpUrl, "_blank");
    }
  }
  setOverlayText();

  // ========= input
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") e.preventDefault();

    if (e.code === "KeyR") {
      resetRun();
      showOverlay(false);
      return;
    }
    if (e.code === "KeyP") {
      state.paused = !state.paused;
      return;
    }
    if (!state.running && !state.over && (e.code === "Enter" || e.code === "Space")) {
      resetRun();
      showOverlay(false);
      return;
    }

    state.keys.add(e.code);

    if (e.code === "Space") tryPulse();
  });

  window.addEventListener("keyup", (e) => {
    state.keys.delete(e.code);
  });

  canvas.addEventListener("pointerdown", (e) => {
    state.pointerDown = true;
    const rect = canvas.getBoundingClientRect();
    state.pointerX = e.clientX - rect.left;
    state.pointerY = e.clientY - rect.top;

    if (els.overlay && els.overlay.style.display !== "none") {
      resetRun();
      showOverlay(false);
    }
  });

  window.addEventListener("pointermove", (e) => {
    if (!state.pointerDown) return;
    const rect = canvas.getBoundingClientRect();
    state.pointerX = e.clientX - rect.left;
    state.pointerY = e.clientY - rect.top;
  });

  window.addEventListener("pointerup", () => {
    state.pointerDown = false;
  });

  function tryPulse() {
    if (!state.running || state.over) return;
    if (state.pulseCooldownT > 0) return;
    state.pulseActive = true;
    state.pulseT = CFG.pulseDuration;
    state.pulseCooldownT = CFG.pulseCooldown;
  }

  // ========= gameplay update
  function update(dt) {
    if (!state.running || state.over || state.paused) return;

    state.t += dt;

    // difficulty ramp
    const tens = state.t / 10;
    const flowPow = CFG.flowStrength + tens * CFG.flowStrengthRamp;
    const obsSpeed = CFG.obstacleSpeed + tens * CFG.obstacleSpeedRamp;

    // add obstacles over time
    const targetCount = CFG.obstacleBaseCount + Math.floor(state.t / CFG.obstacleRampEvery);
    if (state.obs.length < targetCount) spawnObstacles(1);

    // player input accel
    let ax = 0, ay = 0;
    const k = state.keys;

    if (k.has("ArrowLeft") || k.has("KeyA")) ax -= 1;
    if (k.has("ArrowRight") || k.has("KeyD")) ax += 1;
    if (k.has("ArrowUp") || k.has("KeyW")) ay -= 1;
    if (k.has("ArrowDown") || k.has("KeyS")) ay += 1;

    // normalize keyboard vector
    const aLen = Math.hypot(ax, ay);
    if (aLen > 0) { ax /= aLen; ay /= aLen; }

    // pointer pull (gentle)
    if (state.pointerDown) {
      const dx = state.pointerX - state.p.x;
      const dy = state.pointerY - state.p.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      // gentle pull that doesn't override skill; clamps close range
      const pull = clamp(d / 180, 0, 1);
      ax += (dx / d) * pull * 0.85;
      ay += (dy / d) * pull * 0.85;
    }

    // flow field force
    const fv = flowVector(state.p.x, state.p.y, state.t);
    ax += fv.x * flowPow;
    ay += fv.y * flowPow;

    // pulse modifies acceleration + adds brief invulnerability
    let accelMul = 1;
    if (state.pulseActive) {
      accelMul = CFG.pulseBoost;
      state.pulseT -= dt;
      if (state.pulseT <= 0) state.pulseActive = false;
    }
    if (state.pulseCooldownT > 0) state.pulseCooldownT = Math.max(0, state.pulseCooldownT - dt);

    // apply physics
    state.p.vx += ax * CFG.baseAccel * accelMul;
    state.p.vy += ay * CFG.baseAccel * accelMul;

    // clamp speed
    const sp = Math.hypot(state.p.vx, state.p.vy);
    const ms = CFG.maxSpeed * (state.pulseActive ? 1.15 : 1);
    if (sp > ms) {
      state.p.vx = (state.p.vx / sp) * ms;
      state.p.vy = (state.p.vy / sp) * ms;
    }

    state.p.vx *= CFG.friction;
    state.p.vy *= CFG.friction;

    state.p.x += state.p.vx;
    state.p.y += state.p.vy;

    // bounds with soft bounce
    const r = CFG.playerRadius;
    if (state.p.x < r) { state.p.x = r; state.p.vx *= -0.65; }
    if (state.p.x > W - r) { state.p.x = W - r; state.p.vx *= -0.65; }
    if (state.p.y < r) { state.p.y = r; state.p.vy *= -0.65; }
    if (state.p.y > H - r) { state.p.y = H - r; state.p.vy *= -0.65; }

    // trail
    state.trail.unshift({ x: state.p.x, y: state.p.y, a: 1 });
    if (state.trail.length > CFG.trailLength) state.trail.pop();
    for (const t of state.trail) t.a *= CFG.trailFade;

    // obstacles update + collision
    for (const o of state.obs) {
      // flow field influences obstacles too (keeps it “alive”)
      const of = flowVector(o.x, o.y, state.t + o.phase);
      o.vx = lerp(o.vx, of.x * obsSpeed, 0.015);
      o.vy = lerp(o.vy, of.y * obsSpeed, 0.015);

      o.x += o.vx;
      o.y += o.vy;

      // wrap around edges (keeps pressure consistent)
      const pad = 60;
      if (o.x < -pad) o.x = W + pad;
      if (o.x > W + pad) o.x = -pad;
      if (o.y < -pad) o.y = H + pad;
      if (o.y > H + pad) o.y = -pad;

      // collision unless invuln window
      const invuln = state.pulseActive && (state.pulseT > (CFG.pulseDuration - CFG.pulseInvuln));
      const d = Math.hypot(o.x - state.p.x, o.y - state.p.y);
      if (!invuln && d < (o.r + CFG.playerRadius)) {
        gameOver();
        return;
      }
    }

    // UI time
    if (els.time) els.time.textContent = state.t.toFixed(2);
  }

  function gameOver() {
    state.over = true;
    state.running = false;
    showOverlay(true);
    if (els.hint) {
      els.hint.innerHTML =
        `<div style="opacity:.9">RUN ENDED</div>` +
        `<div style="opacity:.7;margin-top:8px">Time: <b>${state.t.toFixed(2)}s</b></div>` +
        `<div style="opacity:.55;margin-top:12px">Press R to restart</div>` +
        `<div style="opacity:.55;margin-top:10px;line-height:1.4">${CFG.lore.join("<br>")}</div>`;
    }
  }

  // ========= render
  function draw() {
    // clear
    ctx.clearRect(0, 0, W, H);

    // background stars
    ctx.save();
    ctx.globalAlpha = 0.9;
    for (const s of stars) {
      const tw = 0.55 + 0.45 * Math.sin(state.t * 0.6 + s.tw);
      const x = s.x * W;
      const y = s.y * H;
      ctx.globalAlpha = 0.18 * tw;
      ctx.beginPath();
      ctx.arc(x, y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
    }
    ctx.restore();

    // flow field visualization (directional threads)
    drawFlowField();

    // obstacles
    for (const o of state.obs) {
      ctx.save();
      ctx.globalAlpha = 0.65;
      ctx.beginPath();
      ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.fill();

      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.stroke();
      ctx.restore();
    }

    // trail / afterimages
    ctx.save();
    for (let i = state.trail.length - 1; i >= 0; i--) {
      const t = state.trail[i];
      const rr = CFG.playerRadius * (0.9 + i * 0.012);
      ctx.globalAlpha = 0.14 * t.a;
      ctx.beginPath();
      ctx.arc(t.x, t.y, rr, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fill();
    }
    ctx.restore();

    // player core
    ctx.save();
    const glow = state.pulseActive ? 0.95 : 0.75;
    ctx.globalAlpha = glow;
    ctx.beginPath();
    ctx.arc(state.p.x, state.p.y, CFG.playerRadius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fill();

    // pulse ring
    if (state.pulseActive) {
      const t = state.pulseT / CFG.pulseDuration;
      ctx.globalAlpha = 0.35 * (1 - t);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(state.p.x, state.p.y, CFG.playerRadius + 26 * (1 - t), 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.stroke();
    }

    ctx.restore();

    // UI (minimal)
    drawHud();

    // vignette
    if (CFG.vignette) drawVignette();
  }

  function drawFlowField() {
    const step = CFG.flowVisualDensity; // lower=denser
    ctx.save();
    ctx.globalAlpha = 0.18;

    for (let y = 0; y < H; y += step) {
      for (let x = 0; x < W; x += step) {
        const v = flowVector(x, y, state.t);
        const L = 16; // line length
        const x2 = x + v.x * L;
        const y2 = y + v.y * L;

        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x2, y2);
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255,255,255,0.14)";
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  function drawHud() {
    const pad = 14;

    // time
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(`TIME`, pad, pad + 2);
    ctx.globalAlpha = 0.92;
    ctx.font = "22px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ctx.fillText(`${state.t.toFixed(2)}`, pad, pad + 28);

    // pulse meter
    const w = 140, h = 8;
    const x = pad, y = pad + 42;
    const cd = CFG.pulseCooldown;
    const f = cd === 0 ? 1 : 1 - (state.pulseCooldownT / cd);
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 0.62;
    ctx.fillRect(x, y, w * clamp(f, 0, 1), h);
    ctx.globalAlpha = 0.7;
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ctx.fillText(`PULSE`, x + w + 10, y + 8);

    ctx.restore();
  }

  function drawVignette() {
    const g = ctx.createRadialGradient(W * 0.5, H * 0.5, Math.min(W, H) * 0.2, W * 0.5, H * 0.5, Math.max(W, H) * 0.7);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // ========= loop
  function frame(now) {
    const dt = clamp((now - state.last) / 1000, 0, 0.033);
    state.last = now;
    state.dt = dt;

    update(dt);
    draw();

    requestAnimationFrame(frame);
  }

  // ========= wiring buttons if present
  if (els.btnStart) {
    els.btnStart.onclick = () => {
      resetRun();
      showOverlay(false);
    };
  }
  if (els.btnHow) {
    els.btnHow.onclick = () => {
      if (!els.how) return;
      const on = els.how.style.display !== "block";
      els.how.style.display = on ? "block" : "none";
    };
  }

  // start with overlay visible
  showOverlay(true);
  requestAnimationFrame((t) => {
    state.last = t;
    requestAnimationFrame(frame);
  });
})();
