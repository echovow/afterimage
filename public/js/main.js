(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d", { alpha: true });

  // Optional overlay DOM (safe if missing)
  const els = {
    overlay: document.getElementById("overlay"),
    hint: document.getElementById("hint"),
    btnStart: document.getElementById("btnStart"),
    btnPump: document.getElementById("btnPump"),
  };

  const CFG = {
    // Player feel
    playerRadius: 10,
    baseAccel: 0.62,
    maxSpeed: 7.2,
    friction: 0.975,

    // Pointer pull
    pointerPull: 0.95,

    // FLOW FIELD (curl = no "gravity bias")
    flowScale: 0.0026,     // spatial frequency
    flowSpeed: 0.18,       // how fast the field evolves
    flowStrength: 0.38,    // how strongly it pushes player
    flowRampPer10s: 0.03,  // difficulty over time

    // FLOW VISUAL (advected particles)
    flowParticleCount: 260,
    flowParticleSpeed: 26,    // pixels/sec scaling for particle advection
    flowParticleJitter: 0.18, // small noise to keep it alive
    flowParticleAlpha: 0.16,

    // Obstacles (hazards)
    obstacleBaseCount: 3,
    obstacleRampEvery: 12,  // seconds
    obstacleRadius: 12,
    obstacleSpeed: 1.8,
    obstacleSpeedRampPer10s: 0.12,

    // Pulse
    pulseDuration: 0.85,
    pulseCooldown: 6.0,
    pulseBoost: 2.2,
    pulseInvuln: 0.25,

    // Afterimage trail (REAL trail)
    trailMax: 34,
    trailFade: 0.90,
    trailAlphaBase: 0.14,
    trailAlphaSpeed: 0.26, // additional alpha when moving fast

    // Background
    starCount: 110,
    vignette: true,

    // Links / copy
    pumpUrl: "https://pump.fun/",
    title: "AFTERIMAGE",
    lore: [
      "You are not the dot.",
      "You are the wake it leaves behind.",
      "Ride the flow. Outlast the pressure."
    ],
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---------- Canvas sizing
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

  // ---------- Fast value noise
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

  // ---------- CURL FIELD (divergence-free)
  function curlVector(px, py, t) {
    const s = CFG.flowScale;
    // Scale into noise space
    const nx = px * s + t * CFG.flowSpeed;
    const ny = py * s + t * CFG.flowSpeed;

    // Numerical derivatives
    const e = 0.7; // derivative step in noise-space units
    const n1 = valueNoise(nx, ny + e);
    const n2 = valueNoise(nx, ny - e);
    const a = (n1 - n2) / (2 * e); // dN/dy

    const n3 = valueNoise(nx + e, ny);
    const n4 = valueNoise(nx - e, ny);
    const b = (n3 - n4) / (2 * e); // dN/dx

    // Curl in 2D: (dN/dy, -dN/dx) rotated gives swirls
    let vx = a;
    let vy = -b;

    // Normalize
    const L = Math.hypot(vx, vy) || 1;
    vx /= L; vy /= L;

    return { x: vx, y: vy };
  }

  // ---------- Visual assets
  const stars = Array.from({ length: CFG.starCount }, () => ({
    x: Math.random(), y: Math.random(),
    r: 0.6 + Math.random() * 1.4,
    tw: Math.random() * 10,
  }));

  const flowParticles = [];
  function seedFlowParticles() {
    flowParticles.length = 0;
    for (let i = 0; i < CFG.flowParticleCount; i++) {
      flowParticles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        a: 0.3 + Math.random() * 0.7,
        s: 0.6 + Math.random() * 1.6,
      });
    }
  }
  seedFlowParticles();

  // ---------- State
  const state = {
    running: false,
    over: false,
    paused: false,
    t: 0,
    last: performance.now(),

    keys: new Set(),
    pointerDown: false,
    pointerX: 0,
    pointerY: 0,

    pulseActive: false,
    pulseT: 0,
    pulseCooldownT: 0,

    p: { x: W * 0.5, y: H * 0.5, vx: 0, vy: 0 },
    trail: [],

    obs: [],
  };

  function showOverlay(on) {
    if (!els.overlay) return;
    els.overlay.style.display = on ? "flex" : "none";
  }

  function setOverlayText(textHTML) {
    if (!els.hint) return;
    els.hint.innerHTML = textHTML;
  }

  function overlayHome() {
    showOverlay(true);
    setOverlayText(
      `<div style="opacity:.9;letter-spacing:.12em">${CFG.title}</div>
       <div style="opacity:.72;margin-top:10px;line-height:1.5">${CFG.lore.join("<br>")}</div>
       <div style="opacity:.55;margin-top:14px">WASD / Arrows • Mouse/Touch pull • SPACE Pulse • R Restart</div>`
    );
  }

  if (els.btnStart) {
    els.btnStart.onclick = () => { resetRun(); showOverlay(false); };
  }
  if (els.btnPump) {
    els.btnPump.onclick = () => window.open(CFG.pumpUrl, "_blank");
  }

  function resetRun() {
    state.running = true;
    state.over = false;
    state.paused = false;
    state.t = 0;

    state.p = { x: W * 0.5, y: H * 0.5, vx: 0, vy: 0 };
    state.trail = [];

    state.obs = [];
    spawnObstacles(CFG.obstacleBaseCount);

    state.pulseActive = false;
    state.pulseT = 0;
    state.pulseCooldownT = 0;

    seedFlowParticles();
  }

  // ---------- Obstacles
  function spawnObstacles(n) {
    for (let i = 0; i < n; i++) {
      const edge = Math.floor(Math.random() * 4);
      const pad = 60;
      let x = 0, y = 0;
      if (edge === 0) { x = -pad; y = Math.random() * H; }
      if (edge === 1) { x = W + pad; y = Math.random() * H; }
      if (edge === 2) { x = Math.random() * W; y = -pad; }
      if (edge === 3) { x = Math.random() * W; y = H + pad; }

      // Give them swirl motion + initial nudge
      const v = curlVector(x, y, Math.random() * 10);
      state.obs.push({
        x, y,
        vx: v.x * CFG.obstacleSpeed,
        vy: v.y * CFG.obstacleSpeed,
        r: CFG.obstacleRadius + Math.random() * 7,
        spin: (Math.random() - 0.5) * 2,
        phase: Math.random() * 10,
      });
    }
  }

  // ---------- Input
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") e.preventDefault();
    if (e.code === "KeyR") { resetRun(); showOverlay(false); return; }
    if (!state.running && (e.code === "Enter" || e.code === "Space")) {
      resetRun(); showOverlay(false); return;
    }
    state.keys.add(e.code);
    if (e.code === "Space") tryPulse();
  });

  window.addEventListener("keyup", (e) => state.keys.delete(e.code));

  canvas.addEventListener("pointerdown", (e) => {
    state.pointerDown = true;
    const rect = canvas.getBoundingClientRect();
    state.pointerX = e.clientX - rect.left;
    state.pointerY = e.clientY - rect.top;
    if (!state.running) { resetRun(); showOverlay(false); }
  });
  window.addEventListener("pointermove", (e) => {
    if (!state.pointerDown) return;
    const rect = canvas.getBoundingClientRect();
    state.pointerX = e.clientX - rect.left;
    state.pointerY = e.clientY - rect.top;
  });
  window.addEventListener("pointerup", () => { state.pointerDown = false; });

  function tryPulse() {
    if (!state.running || state.over) return;
    if (state.pulseCooldownT > 0) return;
    state.pulseActive = true;
    state.pulseT = CFG.pulseDuration;
    state.pulseCooldownT = CFG.pulseCooldown;
  }

  // ---------- Update
  function update(dt) {
    if (!state.running || state.over || state.paused) return;

    state.t += dt;

    // Difficulty ramps
    const tens = state.t / 10;
    const flowPow = CFG.flowStrength + tens * CFG.flowRampPer10s;
    const obsSpeed = CFG.obstacleSpeed + tens * CFG.obstacleSpeedRampPer10s;

    const targetObs = CFG.obstacleBaseCount + Math.floor(state.t / CFG.obstacleRampEvery);
    if (state.obs.length < targetObs) spawnObstacles(1);

    // Player input vector
    let ax = 0, ay = 0;
    const k = state.keys;
    if (k.has("ArrowLeft") || k.has("KeyA")) ax -= 1;
    if (k.has("ArrowRight") || k.has("KeyD")) ax += 1;
    if (k.has("ArrowUp") || k.has("KeyW")) ay -= 1;
    if (k.has("ArrowDown") || k.has("KeyS")) ay += 1;

    const aLen = Math.hypot(ax, ay);
    if (aLen > 0) { ax /= aLen; ay /= aLen; }

    // Pointer pull: gentle but consistent
    if (state.pointerDown) {
      const dx = state.pointerX - state.p.x;
      const dy = state.pointerY - state.p.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const pull = clamp(d / 220, 0, 1);
      ax += (dx / d) * pull * CFG.pointerPull;
      ay += (dy / d) * pull * CFG.pointerPull;
    }

    // Curl field push (no gravity bias)
    const fv = curlVector(state.p.x, state.p.y, state.t);
    ax += fv.x * flowPow;
    ay += fv.y * flowPow;

    // Pulse
    let accelMul = 1;
    if (state.pulseActive) {
      accelMul = CFG.pulseBoost;
      state.pulseT -= dt;
      if (state.pulseT <= 0) state.pulseActive = false;
    }
    if (state.pulseCooldownT > 0) state.pulseCooldownT = Math.max(0, state.pulseCooldownT - dt);

    // Physics
    state.p.vx += ax * CFG.baseAccel * accelMul;
    state.p.vy += ay * CFG.baseAccel * accelMul;

    const sp = Math.hypot(state.p.vx, state.p.vy);
    const ms = CFG.maxSpeed * (state.pulseActive ? 1.18 : 1);
    if (sp > ms) {
      state.p.vx = (state.p.vx / sp) * ms;
      state.p.vy = (state.p.vy / sp) * ms;
    }

    state.p.vx *= CFG.friction;
    state.p.vy *= CFG.friction;

    state.p.x += state.p.vx;
    state.p.y += state.p.vy;

    // Bounds (soft)
    const r = CFG.playerRadius;
    if (state.p.x < r) { state.p.x = r; state.p.vx *= -0.7; }
    if (state.p.x > W - r) { state.p.x = W - r; state.p.vx *= -0.7; }
    if (state.p.y < r) { state.p.y = r; state.p.vy *= -0.7; }
    if (state.p.y > H - r) { state.p.y = H - r; state.p.vy *= -0.7; }

    // TRUE trail: depends on speed
    const speed01 = clamp(sp / (CFG.maxSpeed * 0.85), 0, 1);
    const aTrail = CFG.trailAlphaBase + speed01 * CFG.trailAlphaSpeed;

    state.trail.unshift({ x: state.p.x, y: state.p.y, a: aTrail });
    if (state.trail.length > CFG.trailMax) state.trail.pop();
    for (const t of state.trail) t.a *= CFG.trailFade;

    // Obstacles move in curl field too
    for (const o of state.obs) {
      const of = curlVector(o.x, o.y, state.t + o.phase);
      o.vx = lerp(o.vx, of.x * obsSpeed, 0.03);
      o.vy = lerp(o.vy, of.y * obsSpeed, 0.03);
      o.x += o.vx;
      o.y += o.vy;

      // Wrap edges
      const pad = 70;
      if (o.x < -pad) o.x = W + pad;
      if (o.x > W + pad) o.x = -pad;
      if (o.y < -pad) o.y = H + pad;
      if (o.y > H + pad) o.y = -pad;

      // Collision (pulse invuln)
      const invuln = state.pulseActive && (state.pulseT > (CFG.pulseDuration - CFG.pulseInvuln));
      if (!invuln) {
        const d = Math.hypot(o.x - state.p.x, o.y - state.p.y);
        if (d < (o.r + CFG.playerRadius)) {
          gameOver();
          return;
        }
      }
    }

    // Flow particles advect (this is the "visible force")
    advectFlowParticles(dt);
  }

  function advectFlowParticles(dt) {
    const k = CFG.flowParticleSpeed;
    for (const p of flowParticles) {
      const v = curlVector(p.x, p.y, state.t);
      // small jitter so it breathes
      p.x += (v.x * k + (Math.random() - 0.5) * CFG.flowParticleJitter) * dt;
      p.y += (v.y * k + (Math.random() - 0.5) * CFG.flowParticleJitter) * dt;

      // respawn if out
      if (p.x < -10 || p.x > W + 10 || p.y < -10 || p.y > H + 10) {
        p.x = Math.random() * W;
        p.y = Math.random() * H;
        p.a = 0.3 + Math.random() * 0.7;
        p.s = 0.6 + Math.random() * 1.6;
      }
    }
  }

  function gameOver() {
    state.over = true;
    state.running = false;
    showOverlay(true);
    setOverlayText(
      `<div style="opacity:.9;letter-spacing:.12em">RUN ENDED</div>
       <div style="opacity:.7;margin-top:10px">Time: <b>${state.t.toFixed(2)}s</b></div>
       <div style="opacity:.55;margin-top:14px">Press R to restart</div>`
    );
  }

  // ---------- Render
  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Stars
    ctx.save();
    for (const s of stars) {
      const tw = 0.55 + 0.45 * Math.sin(state.t * 0.6 + s.tw);
      ctx.globalAlpha = 0.12 * tw;
      ctx.beginPath();
      ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
    }
    ctx.restore();

    // Flow particles (VISIBLE force field)
    ctx.save();
    ctx.globalAlpha = CFG.flowParticleAlpha;
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    for (const p of flowParticles) {
      ctx.globalAlpha = CFG.flowParticleAlpha * p.a;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Obstacles: render as rings so they don't read like "afterimages"
    for (const o of state.obs) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath();
      ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
      ctx.stroke();

      ctx.globalAlpha = 0.10;
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.beginPath();
      ctx.arc(o.x, o.y, o.r * 0.65, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // REAL afterimage trail
    ctx.save();
    for (let i = state.trail.length - 1; i >= 0; i--) {
      const t = state.trail[i];
      const rr = CFG.playerRadius * (0.9 + i * 0.012);
      ctx.globalAlpha = t.a * (0.95 - i / (CFG.trailMax * 1.2));
      ctx.beginPath();
      ctx.arc(t.x, t.y, rr, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fill();
    }
    ctx.restore();

    // Player core
    ctx.save();
    ctx.globalAlpha = state.pulseActive ? 0.98 : 0.85;
    ctx.beginPath();
    ctx.arc(state.p.x, state.p.y, CFG.playerRadius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.98)";
    ctx.fill();

    // Pulse ring
    if (state.pulseActive) {
      const t = state.pulseT / CFG.pulseDuration;
      ctx.globalAlpha = 0.35 * (1 - t);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(state.p.x, state.p.y, CFG.playerRadius + 28 * (1 - t), 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.stroke();
    }
    ctx.restore();

    // HUD minimal
    drawHud();

    // Vignette
    if (CFG.vignette) drawVignette();
  }

  function drawHud() {
    const pad = 14;
    ctx.save();
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.fillText("TIME", pad, pad + 2);

    ctx.font = "22px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillText(state.t.toFixed(2), pad, pad + 28);

    // pulse meter
    const w = 140, h = 8;
    const x = pad, y = pad + 42;
    const f = CFG.pulseCooldown === 0 ? 1 : 1 - (state.pulseCooldownT / CFG.pulseCooldown);
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 0.62;
    ctx.fillRect(x, y, w * clamp(f, 0, 1), h);
    ctx.globalAlpha = 0.65;
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ctx.fillText("PULSE", x + w + 10, y + 8);

    ctx.restore();
  }

  function drawVignette() {
    const g = ctx.createRadialGradient(
      W * 0.5, H * 0.5, Math.min(W, H) * 0.18,
      W * 0.5, H * 0.5, Math.max(W, H) * 0.75
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // ---------- Loop
  function frame(now) {
    const dt = clamp((now - state.last) / 1000, 0, 0.033);
    state.last = now;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  // Boot
  overlayHome();
  requestAnimationFrame((t) => { state.last = t; requestAnimationFrame(frame); });
})();
