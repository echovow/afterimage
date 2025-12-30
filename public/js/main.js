(() => {
  // AFTERIMAGE v3 — Rotating Spotlight Lanes (Modifier-only, No Drift)
  // Prime Law: If you're not moving (no input intent), nothing moves you.

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d", { alpha: true });

  // Optional UI (safe if missing)
  const els = {
    overlay: document.getElementById("overlay"),
    hint: document.getElementById("hint"),
    btnStart: document.getElementById("btnStart"),
    btnPump: document.getElementById("btnPump"),
  };

  const CFG = {
    // Player
    r: 10,
    baseAccel: 0.75,
    maxSpeed: 7.0,
    friction: 0.92,

    // Input (pointer pull behaves like intent; if you stop touching, player stops)
    pointerPull: 1.0,
    pointerDeadzone: 6,

    // Lanes (spotlight bands)
    laneCount: 3,
    laneWidth: 90,           // px (soft edges drawn wider than this)
    laneGap: 120,            // spacing between lane centerlines (perpendicular)
    laneRotateSpeed: 0.12,   // radians per second (slow)
    laneStrength: 0.55,      // overall influence on movement (modifier-only)
    laneRampPer30s: 0.10,    // difficulty ramp
    laneBoostMax: 1.55,      // max multiplier when aligned
    laneResistMin: 0.55,     // min multiplier when opposing
    laneCrossDrag: 0.90,     // multiplier when crossing (near perpendicular)

    // Visuals
    backgroundFade: 0.18,
    vignette: true,

    // Afterimage (v1-style: tied to movement)
    trailMax: 34,
    trailFade: 0.90,
    trailAlphaBase: 0.10,
    trailAlphaSpeed: 0.38,   // brighter trail at higher speed
    trailMinMove: 0.10,      // only record trail when actually moving

    // Overlay/link
    pumpUrl: "https://pump.fun/",
    title: "AFTERIMAGE",
    lore: [
      "Nothing moves you unless you move.",
      "Ride the lane. Resist the lane.",
      "Afterimage is proof of intent."
    ],
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const hypot = Math.hypot;

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

    p: { x: W * 0.5, y: H * 0.5, vx: 0, vy: 0 },
    trail: [],
  };

  // ---------- Overlay helpers
  function showOverlay(on) {
    if (!els.overlay) return;
    els.overlay.style.display = on ? "flex" : "none";
  }

  function setOverlayHome() {
    if (!els.hint) return;
    els.hint.innerHTML =
      `<div style="opacity:.92;letter-spacing:.14em">${CFG.title}</div>
       <div style="opacity:.70;margin-top:10px;line-height:1.5">${CFG.lore.join("<br>")}</div>
       <div style="opacity:.52;margin-top:14px">WASD / Arrows • Mouse/Touch pull • R Restart</div>
       <div style="opacity:.40;margin-top:8px">Tap/click to start</div>`;
  }

  function setOverlayGameOver() {
    if (!els.hint) return;
    els.hint.innerHTML =
      `<div style="opacity:.92;letter-spacing:.14em">RUN ENDED</div>
       <div style="opacity:.70;margin-top:10px">Time: <b>${state.t.toFixed(2)}s</b></div>
       <div style="opacity:.52;margin-top:14px">Press R to restart</div>`;
  }

  if (els.btnStart) els.btnStart.onclick = () => { resetRun(); showOverlay(false); };
  if (els.btnPump)  els.btnPump.onclick  = () => window.open(CFG.pumpUrl, "_blank");

  // ---------- Start/reset
  function resetRun() {
    state.running = true;
    state.over = false;
    state.paused = false;
    state.t = 0;
    state.p = { x: W * 0.5, y: H * 0.5, vx: 0, vy: 0 };
    state.trail = [];
  }

  function gameOver() {
    state.over = true;
    state.running = false;
    showOverlay(true);
    setOverlayGameOver();
  }

  // ---------- Input
  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyR") {
      resetRun();
      showOverlay(false);
      return;
    }
    if (!state.running && (e.code === "Enter" || e.code === "Space")) {
      resetRun();
      showOverlay(false);
      return;
    }
    state.keys.add(e.code);
  });

  window.addEventListener("keyup", (e) => state.keys.delete(e.code));

  canvas.addEventListener("pointerdown", (e) => {
    state.pointerDown = true;
    const rect = canvas.getBoundingClientRect();
    state.pointerX = e.clientX - rect.left;
    state.pointerY = e.clientY - rect.top;

    if (!state.running) {
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

  // ---------- Lanes math (rotating bands, modifier-only)
  function laneAngle(t) {
    return t * CFG.laneRotateSpeed; // slow rotation
  }

  // distance from point to a lane centerline (perpendicular axis)
  // coordinate system: lane direction = (cos a, sin a)
  // perpendicular axis = (-sin a, cos a)
  function laneDistToCenterline(px, py, a, offset) {
    const cx = W * 0.5;
    const cy = H * 0.5;
    const nx = -Math.sin(a);
    const ny =  Math.cos(a);

    // signed distance along normal from center
    const d = (px - cx) * nx + (py - cy) * ny;

    // lane centerlines at d = offset
    return d - offset; // signed; abs() gives distance
  }

  // lane modifier depends on:
  // - inside band (proximity)
  // - alignment between intent direction and lane direction
  function laneModifier(intentX, intentY, px, py, t) {
    // no intent -> no effect (prime law)
    const im = hypot(intentX, intentY);
    if (im < 1e-6) return 1;

    const a = laneAngle(t);
    const fx = Math.cos(a);
    const fy = Math.sin(a);

    // alignment in [-1..1]
    const ax = intentX / im;
    const ay = intentY / im;
    const align = ax * fx + ay * fy;

    // strongest lane influence among the lanes you're inside
    let strength = 0;

    const half = Math.floor(CFG.laneCount / 2);
    for (let i = -half; i <= half; i++) {
      const offset = i * CFG.laneGap;
      const sd = laneDistToCenterline(px, py, a, offset);
      const ad = Math.abs(sd);

      // soft band: 0 at edge, 1 at center
      const w = CFG.laneWidth * 0.5;
      if (ad > w) continue;

      const x = 1 - ad / w; // 0..1
      // soften: quadratic
      const local = x * x;

      strength = Math.max(strength, local);
    }

    if (strength <= 0) return 1;

    // ramp over time (gentle)
    const sRamp = 1 + (state.t / 30) * CFG.laneRampPer30s;
    const s = clamp(CFG.laneStrength * sRamp * strength, 0, 0.95);

    // map alignment to movement multiplier:
    // aligned -> boost up to laneBoostMax
    // opposed -> resist down to laneResistMin
    // cross -> slight drag laneCrossDrag
    const absAlign = Math.abs(align);

    // cross is near 0 alignment
    if (absAlign < 0.25) {
      // pull multiplier toward laneCrossDrag by s
      return lerp(1, CFG.laneCrossDrag, s);
    }

    if (align > 0) {
      // boost from 1 to laneBoostMax
      return lerp(1, CFG.laneBoostMax, s * absAlign);
    } else {
      // resist from 1 down to laneResistMin
      return lerp(1, CFG.laneResistMin, s * absAlign);
    }
  }

  // ---------- Update loop (NO drift: lanes only modify your own acceleration)
  function update(dt) {
    if (!state.running || state.over || state.paused) return;

    state.t += dt;

    // intent vector from keys + pointer pull (pointer is intent, not force)
    let ix = 0, iy = 0;

    const k = state.keys;
    if (k.has("ArrowLeft") || k.has("KeyA")) ix -= 1;
    if (k.has("ArrowRight") || k.has("KeyD")) ix += 1;
    if (k.has("ArrowUp") || k.has("KeyW")) iy -= 1;
    if (k.has("ArrowDown") || k.has("KeyS")) iy += 1;

    // normalize keyboard intent
    let km = hypot(ix, iy);
    if (km > 0) { ix /= km; iy /= km; }

    // pointer pull intent (adds to intent direction)
    if (state.pointerDown) {
      const dx = state.pointerX - state.p.x;
      const dy = state.pointerY - state.p.y;
      const d = hypot(dx, dy);

      if (d > CFG.pointerDeadzone) {
        const pull = clamp(d / 220, 0, 1);
        ix += (dx / d) * pull * CFG.pointerPull;
        iy += (dy / d) * pull * CFG.pointerPull;
      }
    }

    const im = hypot(ix, iy);

    // PRIME LAW: no intent => stop completely (no drift, no residual slide)
    if (im < 1e-4) {
      state.p.vx = 0;
      state.p.vy = 0;
      return; // also do not add trail
    }

    // normalize combined intent
    ix /= im;
    iy /= im;

    // compute lane movement modifier (only because you are moving)
    const mod = laneModifier(ix, iy, state.p.x, state.p.y, state.t);

    // accelerate in the direction you chose, scaled by lane modifier
    state.p.vx += ix * CFG.baseAccel * mod;
    state.p.vy += iy * CFG.baseAccel * mod;

    // clamp speed
    const sp = hypot(state.p.vx, state.p.vy);
    if (sp > CFG.maxSpeed) {
      state.p.vx = (state.p.vx / sp) * CFG.maxSpeed;
      state.p.vy = (state.p.vy / sp) * CFG.maxSpeed;
    }

    // friction only applies while moving (still respects prime law because we already early-return on no intent)
    state.p.vx *= CFG.friction;
    state.p.vy *= CFG.friction;

    // move
    state.p.x += state.p.vx;
    state.p.y += state.p.vy;

    // bounds (soft bounce, but still fully under your control)
    const r = CFG.r;
    if (state.p.x < r) { state.p.x = r; state.p.vx *= -0.45; }
    if (state.p.x > W - r) { state.p.x = W - r; state.p.vx *= -0.45; }
    if (state.p.y < r) { state.p.y = r; state.p.vy *= -0.45; }
    if (state.p.y > H - r) { state.p.y = H - r; state.p.vy *= -0.45; }

    // Afterimage trail (v1 behavior: tied to motion + speed intensity)
    const sp2 = hypot(state.p.vx, state.p.vy);
    if (sp2 > CFG.trailMinMove) {
      const speed01 = clamp(sp2 / (CFG.maxSpeed * 0.85), 0, 1);
      const a = CFG.trailAlphaBase + speed01 * CFG.trailAlphaSpeed;

      state.trail.unshift({ x: state.p.x, y: state.p.y, a });
      if (state.trail.length > CFG.trailMax) state.trail.pop();
      for (const t of state.trail) t.a *= CFG.trailFade;
    }
  }

  // ---------- Render
  function draw() {
    // clear with slight fade for softness (doesn't create drift; purely visual)
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    ctx.restore();

    // subtle background wash
    ctx.save();
    ctx.globalAlpha = CFG.backgroundFade;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // Lanes (elegant spotlight bands)
    drawLanes();

    // Afterimage trail (v1)
    ctx.save();
    for (let i = state.trail.length - 1; i >= 0; i--) {
      const t = state.trail[i];
      const rr = CFG.r * (0.92 + i * 0.012);
      ctx.globalAlpha = t.a * (0.95 - i / (CFG.trailMax * 1.25));
      ctx.beginPath();
      ctx.arc(t.x, t.y, rr, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.98)";
      ctx.fill();
    }
    ctx.restore();

    // Player
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.beginPath();
    ctx.arc(state.p.x, state.p.y, CFG.r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.98)";
    ctx.fill();
    ctx.restore();

    if (CFG.vignette) drawVignette();

    // Minimal HUD (time)
    drawHud();
  }

  function drawLanes() {
    const a = laneAngle(state.t);
    const fx = Math.cos(a);
    const fy = Math.sin(a);
    const nx = -Math.sin(a);
    const ny =  Math.cos(a);

    // lane visibility should be quiet and “wake up” with movement
    const sp = hypot(state.p.vx, state.p.vy);
    const vis = clamp(sp / (CFG.maxSpeed * 0.7), 0, 1);

    // draw each lane as a wide rect rotated by angle a, with a soft gradient across its width
    const half = Math.floor(CFG.laneCount / 2);
    for (let i = -half; i <= half; i++) {
      const offset = i * CFG.laneGap;

      // lane centerline point (center + normal * offset)
      const cx = W * 0.5 + nx * offset;
      const cy = H * 0.5 + ny * offset;

      // gradient across normal direction (soft spotlight)
      const w = CFG.laneWidth;
      const gx1 = cx - nx * (w * 0.5);
      const gy1 = cy - ny * (w * 0.5);
      const gx2 = cx + nx * (w * 0.5);
      const gy2 = cy + ny * (w * 0.5);

      const grad = ctx.createLinearGradient(gx1, gy1, gx2, gy2);
      // edges nearly invisible
      const edgeA = 0.0;
      // center wakes up with motion
      const midA = 0.08 + 0.22 * vis;

      grad.addColorStop(0, `rgba(255,255,255,${edgeA})`);
      grad.addColorStop(0.5, `rgba(255,255,255,${midA})`);
      grad.addColorStop(1, `rgba(255,255,255,${edgeA})`);

      // big rotated quad covering screen along lane direction
      // We draw a very long rectangle aligned with f, centered at (cx,cy)
      const L = Math.max(W, H) * 1.6;
      const hx = fx * (L * 0.5);
      const hy = fy * (L * 0.5);
      const wx = nx * (w * 0.5);
      const wy = ny * (w * 0.5);

      const p1x = cx - hx - wx, p1y = cy - hy - wy;
      const p2x = cx + hx - wx, p2y = cy + hy - wy;
      const p3x = cx + hx + wx, p3y = cy + hy + wy;
      const p4x = cx - hx + wx, p4y = cy - hy + wy;

      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(p1x, p1y);
      ctx.lineTo(p2x, p2y);
      ctx.lineTo(p3x, p3y);
      ctx.lineTo(p4x, p4y);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  function drawVignette() {
    const g = ctx.createRadialGradient(
      W * 0.5, H * 0.5, Math.min(W, H) * 0.18,
      W * 0.5, H * 0.5, Math.max(W, H) * 0.75
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.62)");
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  function drawHud() {
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.fillText("TIME", 14, 16);
    ctx.globalAlpha = 0.92;
    ctx.font = "22px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ctx.fillText(state.t.toFixed(2), 14, 40);
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

  // ---------- Boot
  showOverlay(true);
  setOverlayHome();

  // Tap/click canvas to start if overlay lacks buttons
  canvas.addEventListener("click", () => {
    if (!state.running) {
      resetRun();
      showOverlay(false);
    }
  });

  requestAnimationFrame((t) => {
    state.last = t;
    requestAnimationFrame(frame);
  });
})();
