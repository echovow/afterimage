(() => {
  const CFG = window.CONFIG;

  // -------- DOM
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d", { alpha: true });

  const els = {
    overlay: document.getElementById("overlay"),
    btnStart: document.getElementById("btnStart"),
    btnHow: document.getElementById("btnHow"),
    how: document.getElementById("how"),
    time: document.getElementById("time"),
    hint: document.getElementById("hint"),
    tLabel: document.getElementById("tLabel"),
  };

  els.tLabel.textContent = CFG.gameplay.spawnEverySec.toFixed(1);

  // -------- Helpers
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function randi(a, b) { return Math.floor(rand(a, b + 1)); }

  // -------- State
  const state = {
    running: false,
    paused: false,
    dead: false,

    view: { w: CFG.canvas.baseWidth, h: CFG.canvas.baseHeight },

    t: 0,
    lastFrame: 0,

    spawnEvery: CFG.gameplay.spawnEverySec,
    nextSpawnAt: CFG.gameplay.spawnEverySec,

    player: {
      x: 0, y: 0,
      vx: 0, vy: 0,
      r: CFG.gameplay.playerRadius,
    },

    // Recorder: ring buffer of samples over recordWindowSec
    recorder: {
      maxSec: CFG.gameplay.recordWindowSec,
      samples: [], // {t, x, y}
    },

    // Afterimages: each has its own recorded samples, loops over them
    afterimages: [], // { bornAt, samples, duration, idx, x, y }

    // Distortions
    distortions: {
      lanes: [],
    },

    // Track dt last for ramp boundary checks
    dtLast: 0,
  };

  // -------- Canvas sizing (crisp but capped DPR)
  function resizeCanvas() {
    // CSS size comes from layout; canvas internal resolution set here.
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, CFG.canvas.pixelRatioCap);

    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
    state.view.w = rect.width;
    state.view.h = rect.height;

    // Re-seed lanes to fit new viewport (only if game is running)
    if (state.running) {
      state.distortions.lanes = initDistortions(state.view.w, state.view.h);
    }
  }

  // -------- Input
  const keys = new Set();
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    keys.add(k);

    if (k === " " || k === "spacebar") {
      e.preventDefault();
      togglePause();
    }
    if (k === "r") restart();
    if (k === "escape") showOverlay(true);
  });

  window.addEventListener("keyup", (e) => {
    keys.delete(e.key.toLowerCase());
  });

  function axis() {
    let x = 0, y = 0;

    const left  = keys.has("a") || keys.has("arrowleft");
    const right = keys.has("d") || keys.has("arrowright");
    const up    = keys.has("w") || keys.has("arrowup");
    const down  = keys.has("s") || keys.has("arrowdown");

    if (left) x -= 1;
    if (right) x += 1;
    if (up) y -= 1;
    if (down) y += 1;

    // normalize diagonal
    if (x !== 0 && y !== 0) {
      const inv = 1 / Math.sqrt(2);
      x *= inv; y *= inv;
    }
    return { x, y };
  }

  // ---------------------------
  // Field Distortion Lanes v1.0
  // ---------------------------
  const DISTORT = {
    enabled: true,

    // how many lanes exist at once
    minLanes: 2,
    maxLanes: 4,

    // lane width in pixels (feel > visuals)
    widthMin: 90,
    widthMax: 180,

    // drift speed (px/sec)
    speedMin: 18,
    speedMax: 45,

    // how strongly it affects movement
    // (0.0 = no effect, 1.0 = brutal)
    dragStrength: 0.55,     // "thick air"
    pullStrength: 120,      // px/sec^2 lateral pull

    // lane alpha + soft edges
    alpha: 0.10,
    feather: 42,            // edge softness in px

    // behavior mix
    modeMix: 0.60,          // 60% drag lanes, 40% pull lanes

    // respawn when fully offscreen
    pad: 140,
  };

  // Feathered band intensity 0..1 at point
  function bandIntensity(px, py, lane) {
    const dx = px - lane.cx;
    const dy = py - lane.cy;

    // signed distance to lane centerline along normal
    const dist = dx * lane.nx + dy * lane.ny;
    const ad = Math.abs(dist);

    const halfW = lane.halfW;
    const feather = DISTORT.feather;

    if (ad >= halfW + feather) return 0;
    if (ad <= halfW) return 1;

    // linear feather falloff
    const t = (ad - halfW) / feather; // 0..1
    return 1 - t;
  }

  class DistortionLane {
    constructor(w, h) {
      this.reset(w, h, true);
    }

    reset(w, h, initial = false) {
      // lane orientation
      const ang = rand(0, Math.PI); // 0..180deg
      const tx = Math.cos(ang), ty = Math.sin(ang);

      // normal to the lane direction
      this.nx = -ty;
      this.ny = tx;

      this.halfW = rand(DISTORT.widthMin, DISTORT.widthMax) * 0.5;

      // drift: mostly along normal so lanes sweep across screen
      const driftDir = (Math.random() < 0.5) ? -1 : 1;
      const spd = rand(DISTORT.speedMin, DISTORT.speedMax) * driftDir;

      this.vx = this.nx * spd;
      this.vy = this.ny * spd;

      // choose a random point near screen, then offset backward along velocity
      const pad = DISTORT.pad;
      const spawnX = rand(-pad, w + pad);
      const spawnY = rand(-pad, h + pad);

      const magV = Math.hypot(this.vx, this.vy) || 1;
      const back = (w + h + pad * 2) * (initial ? 0.35 : 0.65);

      this.cx = spawnX - (this.vx / magV) * back;
      this.cy = spawnY - (this.vy / magV) * back;

      // lane type
      this.mode = (Math.random() < DISTORT.modeMix) ? "drag" : "pull";
      this.pullSign = (Math.random() < 0.5) ? -1 : 1;
    }

    update(dt, w, h) {
      this.cx += this.vx * dt;
      this.cy += this.vy * dt;

      const pad = DISTORT.pad;
      const off =
        this.cx < -pad * 2 ||
        this.cx > w + pad * 2 ||
        this.cy < -pad * 2 ||
        this.cy > h + pad * 2;

      if (off) this.reset(w, h, false);
    }

    draw(ctx) {
      // Render lane as a wide band: long rect rotated along tangent.
      // tangent is perpendicular to normal: t = (ny, -nx)
      const tx = this.ny;
      const ty = -this.nx;

      const L = 5000;
      const W = this.halfW * 2 + DISTORT.feather * 2;

      ctx.save();
      ctx.translate(this.cx, this.cy);

      const ang = Math.atan2(ty, tx);
      ctx.rotate(ang);

      // soft gradient across width
      const g = ctx.createLinearGradient(0, -W / 2, 0, W / 2);
      const a = DISTORT.alpha;

      // Slightly different density for pull lanes (subtle readability)
      const aMid = this.mode === "pull" ? a * 1.25 : a * 1.05;

      g.addColorStop(0.00, `rgba(255,255,255,0)`);
      g.addColorStop(0.25, `rgba(255,255,255,${a})`);
      g.addColorStop(0.50, `rgba(255,255,255,${aMid})`);
      g.addColorStop(0.75, `rgba(255,255,255,${a})`);
      g.addColorStop(1.00, `rgba(255,255,255,0)`);

      ctx.fillStyle = g;
      ctx.fillRect(-L / 2, -W / 2, L, W);

      ctx.restore();
    }
  }

  function initDistortions(w, h) {
    const lanes = [];
    const n = randi(DISTORT.minLanes, DISTORT.maxLanes);
    for (let i = 0; i < n; i++) lanes.push(new DistortionLane(w, h));
    return lanes;
  }

  function applyDistortionsToPlayer(player, lanes, dt) {
    if (!DISTORT.enabled || !lanes || lanes.length === 0) return;

    let dragAccum = 0;
    let pullX = 0, pullY = 0;

    for (const lane of lanes) {
      const k = bandIntensity(player.x, player.y, lane);
      if (k <= 0) continue;

      if (lane.mode === "drag") {
        dragAccum = Math.max(dragAccum, k);
      } else {
        const s = lane.pullSign;
        pullX += lane.nx * (DISTORT.pullStrength * k) * s;
        pullY += lane.ny * (DISTORT.pullStrength * k) * s;
      }
    }

    // Drag scales velocity down smoothly; clamp prevents full freeze.
    if (dragAccum > 0) {
      const d = 1 - (DISTORT.dragStrength * dragAccum);
      const clampMin = 0.30;
      const factor = Math.max(clampMin, d);
      player.vx *= factor;
      player.vy *= factor;
    }

    // Pull adds acceleration-like influence.
    if (pullX || pullY) {
      player.vx += pullX * dt;
      player.vy += pullY * dt;
    }
  }

  function stepDistortions(dt) {
    const lanes = state.distortions.lanes;
    const w = state.view.w, h = state.view.h;
    for (const lane of lanes) lane.update(dt, w, h);
  }

  function drawDistortions() {
    const lanes = state.distortions.lanes;
    for (const lane of lanes) lane.draw(ctx);
  }

  // -------- Game helpers
  function wallBounds() {
    const pad = CFG.gameplay.wallPadding;
    return {
      minX: pad,
      minY: pad,
      maxX: state.view.w - pad,
      maxY: state.view.h - pad,
    };
  }

  function recordSample() {
    const t = state.t;
    const s = state.recorder.samples;
    s.push({ t, x: state.player.x, y: state.player.y });

    // Trim older than recordWindowSec
    const cutoff = t - state.recorder.maxSec;
    while (s.length && s[0].t < cutoff) s.shift();
  }

  function spawnAfterimage() {
    const s = state.recorder.samples;
    if (s.length < 2) return;

    const startT = s[0].t;
    const duration = s[s.length - 1].t - startT;
    if (duration <= 0.05) return;

    const samples = s.map(p => ({ t: p.t - startT, x: p.x, y: p.y }));

    state.afterimages.push({
      bornAt: state.t,
      samples,
      duration,
      idx: 0,
      x: samples[0].x,
      y: samples[0].y,
    });

    const cap = CFG.gameplay.maxAfterimages;
    if (state.afterimages.length > cap) {
      state.afterimages.shift();
    }
  }

  function stepAfterimages(dt) {
    for (const g of state.afterimages) {
      const local = (state.t - g.bornAt) % g.duration;

      while (g.idx < g.samples.length - 2 && g.samples[g.idx + 1].t < local) {
        g.idx++;
      }

      const a = g.samples[g.idx];
      const b = g.samples[Math.min(g.idx + 1, g.samples.length - 1)];

      const span = Math.max(0.0001, b.t - a.t);
      const u = clamp((local - a.t) / span, 0, 1);
      g.x = a.x + (b.x - a.x) * u;
      g.y = a.y + (b.y - a.y) * u;
    }
  }

  function collidePlayerWithAfterimages() {
    const px = state.player.x, py = state.player.y, pr = state.player.r;
    const rr = pr + pr;
    const rr2 = rr * rr;

    for (const g of state.afterimages) {
      const dx = g.x - px;
      const dy = g.y - py;
      if (dx * dx + dy * dy <= rr2) return true;
    }
    return false;
  }

  function rampDifficulty() {
    if (!CFG.gameplay.ramp.enabled) return;

    const every = CFG.gameplay.ramp.everySec;
    if (every <= 0) return;

    const stepIdx = Math.floor(state.t / every);
    const baseIdx = Math.floor((state.t - state.dtLast) / every);

    if (stepIdx > baseIdx) {
      state.spawnEvery = Math.max(
        CFG.gameplay.ramp.minSpawnEverySec,
        state.spawnEvery + CFG.gameplay.ramp.spawnEveryDelta
      );
      state.nextSpawnAt = state.t + state.spawnEvery;
    }
  }

  // -------- Overlay controls
  function showOverlay(show, deathText) {
    els.overlay.style.display = show ? "flex" : "none";
    if (deathText) {
      els.overlay.querySelector(".subtitle").textContent = deathText;
      els.btnStart.textContent = "RETRY";
    } else {
      els.overlay.querySelector(".subtitle").textContent = "Your last seconds return. Survive yourself.";
      els.btnStart.textContent = "PLAY";
    }
  }

  els.btnStart.addEventListener("click", () => {
    showOverlay(false);
    start();
  });

  els.btnHow.addEventListener("click", () => {
    els.how.classList.toggle("hidden");
  });

  // -------- Game flow
  function resetState() {
    state.t = 0;
    state.lastFrame = 0;
    state.dead = false;
    state.paused = false;

    state.spawnEvery = CFG.gameplay.spawnEverySec;
    state.nextSpawnAt = state.spawnEvery;

    state.recorder.samples = [];
    state.afterimages = [];

    // center player
    state.player.x = state.view.w * 0.5;
    state.player.y = state.view.h * 0.5;
    state.player.vx = 0;
    state.player.vy = 0;

    // Seed field distortions
    state.distortions.lanes = initDistortions(state.view.w, state.view.h);

    if (CFG.ui.showHintDuringPlay) {
      els.hint.style.display = "";
      els.hint.textContent = "WASD/ARROWS move · R restart · SPACE pause";
    }
  }

  function start() {
    if (!state.running) {
      state.running = true;
      resetState();
      resizeCanvas();
      // Re-seed again after resize to ensure correct viewport size
      state.distortions.lanes = initDistortions(state.view.w, state.view.h);
      requestAnimationFrame(loop);
    } else {
      restart();
    }
  }

  function restart() {
    if (!state.running) return;
    resetState();
    showOverlay(false);
  }

  function togglePause() {
    if (!state.running || state.dead) return;
    state.paused = !state.paused;
    if (state.paused) {
      if (CFG.ui.showHintDuringPlay) els.hint.textContent = "PAUSED · press SPACE to resume · R restart";
    } else {
      if (CFG.ui.showHintDuringPlay) els.hint.textContent =
        "WASD/ARROWS move · R restart · SPACE pause";
    }
  }

  // -------- Update
  function update(dt) {
    state.dtLast = dt;
    if (state.paused || state.dead) return;

    state.t += dt;

    // Update distortion lanes
    stepDistortions(dt);

    // Movement (arcade-tight)
    const ax = axis();
    const spd = CFG.gameplay.playerSpeed;

    state.player.vx = ax.x * spd;
    state.player.vy = ax.y * spd;

    // Apply distortions AFTER input sets velocity but BEFORE movement
    applyDistortionsToPlayer(state.player, state.distortions.lanes, dt);

    state.player.x += state.player.vx * dt;
    state.player.y += state.player.vy * dt;

    // Walls
    const b = wallBounds();
    state.player.x = clamp(state.player.x, b.minX, b.maxX);
    state.player.y = clamp(state.player.y, b.minY, b.maxY);

    // Record current sample (for upcoming afterimage)
    recordSample();

    // Spawn afterimage when time hits
    if (state.t >= state.nextSpawnAt) {
      spawnAfterimage();
      state.nextSpawnAt = state.t + state.spawnEvery;
    }

    // Step afterimages
    stepAfterimages(dt);

    // Difficulty ramp
    rampDifficulty();

    // Collision
    if (collidePlayerWithAfterimages()) {
      state.dead = true;
      if (CFG.ui.showHintDuringPlay) els.hint.style.display = "none";
      showOverlay(true, `You touched your past. Time: ${state.t.toFixed(2)}s`);
    }
  }

  // -------- Render
  function clear() {
    ctx.clearRect(0, 0, state.view.w, state.view.h);
  }

  function drawArena() {
    const b = wallBounds();
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = "rgba(233,237,243,.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(b.minX - 14, b.minY - 14, (b.maxX - b.minX) + 28, (b.maxY - b.minY) + 28, 18);
    ctx.stroke();
    ctx.restore();
  }

  function drawAfterimages() {
    const n = state.afterimages.length;
    if (!n) return;

    const aCfg = CFG.gameplay.afterimage;
    for (let i = 0; i < n; i++) {
      const g = state.afterimages[i];

      const age01 = n <= 1 ? 1 : i / (n - 1);
      const alpha = aCfg.oldestAlpha + (aCfg.newestAlpha - aCfg.oldestAlpha) * age01;

      ctx.save();
      ctx.globalAlpha = alpha;

      ctx.fillStyle = "rgba(233,237,243,1)";
      if (aCfg.glow) {
        ctx.shadowBlur = 16;
        ctx.shadowColor = "rgba(233,237,243,.30)";
      }
      ctx.beginPath();
      ctx.arc(g.x, g.y, state.player.r, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = Math.min(1, alpha + aCfg.strokeAlpha);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(233,237,243,.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(g.x, g.y, state.player.r + 3, 0, Math.PI * 2);
      ctx.stroke();

      ctx.restore();
    }
  }

  function drawPlayer() {
    const p = state.player;

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(233,237,243,1)";
    ctx.shadowBlur = 18;
    ctx.shadowColor = "rgba(233,237,243,.35)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(233,237,243,.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r + 4, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  function draw() {
    clear();
    drawArena();

    // Distortions live as "field layer"
    drawDistortions();

    drawAfterimages();
    drawPlayer();

    els.time.textContent = state.t.toFixed(2);

    // paused veil
    if (state.paused && !state.dead) {
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,.35)";
      ctx.fillRect(0, 0, state.view.w, state.view.h);
      ctx.fillStyle = "rgba(233,237,243,.85)";
      ctx.font = "600 18px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.textAlign = "center";
      ctx.fillText("PAUSED", state.view.w / 2, state.view.h / 2);
      ctx.restore();
    }
  }

  // -------- Loop
  function loop(ts) {
    if (!state.running) return;

    if (!state.lastFrame) state.lastFrame = ts;
    const dt = Math.min(0.033, (ts - state.lastFrame) / 1000);
    state.lastFrame = ts;

    update(dt);
    draw();

    requestAnimationFrame(loop);
  }

  // -------- RoundRect polyfill for older browsers
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
      const rr = Math.min(r, w / 2, h / 2);
      this.beginPath();
      this.moveTo(x + rr, y);
      this.arcTo(x + w, y, x + w, y + h, rr);
      this.arcTo(x + w, y + h, x, y + h, rr);
      this.arcTo(x, y + h, x, y, rr);
      this.arcTo(x, y, x + w, y, rr);
      this.closePath();
      return this;
    };
  }

  // -------- Boot
  window.addEventListener("resize", resizeCanvas);
  setTimeout(() => resizeCanvas(), 0);

  // Start overlay visible by default
  showOverlay(true);

  // Allow clicking canvas to start too (arcade feel)
  canvas.addEventListener("pointerdown", () => {
    if (els.overlay.style.display !== "none") {
      showOverlay(false);
      start();
    }
  });
})();
