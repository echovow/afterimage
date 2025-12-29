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
  };

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

    if (CFG.ui.showHintDuringPlay) els.hint.style.display = "";
  }

  // -------- Overlay controls
  function showOverlay(show, deathText) {
    els.overlay.style.display = show ? "flex" : "none";
    if (deathText) {
      // update subtitle on death without adding extra DOM
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
  function start() {
    if (!state.running) {
      state.running = true;
      resetState();
      resizeCanvas();
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

  // -------- Helpers
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

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
    // Record current player position into recorder samples.
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

    // Copy samples relative to their start time (0..duration)
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

    // Safety cap
    const cap = CFG.gameplay.maxAfterimages;
    if (state.afterimages.length > cap) {
      state.afterimages.shift();
    }
  }

  function stepAfterimages(dt) {
    for (const g of state.afterimages) {
      // Advance local time within loop
      const local = (state.t - g.bornAt) % g.duration;

      // Move index forward until next sample time exceeds local
      while (g.idx < g.samples.length - 2 && g.samples[g.idx + 1].t < local) {
        g.idx++;
      }

      const a = g.samples[g.idx];
      const b = g.samples[Math.min(g.idx + 1, g.samples.length - 1)];

      // Interpolate between a and b
      const span = Math.max(0.0001, b.t - a.t);
      const u = clamp((local - a.t) / span, 0, 1);
      g.x = a.x + (b.x - a.x) * u;
      g.y = a.y + (b.y - a.y) * u;
    }
  }

  function collidePlayerWithAfterimages() {
    const px = state.player.x, py = state.player.y, pr = state.player.r;
    const rr = pr + pr; // afterimage uses same radius in v0
    const rr2 = rr * rr;

    for (const g of state.afterimages) {
      const dx = g.x - px;
      const dy = g.y - py;
      if (dx*dx + dy*dy <= rr2) return true;
    }
    return false;
  }

  function rampDifficulty() {
    if (!CFG.gameplay.ramp.enabled) return;

    const every = CFG.gameplay.ramp.everySec;
    if (every <= 0) return;

    // On crossing each 'every' boundary, reduce spawn interval slightly.
    const stepIdx = Math.floor(state.t / every);
    const baseIdx = Math.floor((state.t - state.dtLast) / every);

    if (stepIdx > baseIdx) {
      state.spawnEvery = Math.max(
        CFG.gameplay.ramp.minSpawnEverySec,
        state.spawnEvery + CFG.gameplay.ramp.spawnEveryDelta
      );
      // keep nextSpawnAt aligned forward
      state.nextSpawnAt = state.t + state.spawnEvery;
    }
  }

  // Track dt last for ramp boundary checks
  state.dtLast = 0;

  // -------- Update
  function update(dt) {
    state.dtLast = dt;
    if (state.paused || state.dead) return;

    state.t += dt;

    // Movement (arcade-tight)
    const ax = axis();
    const spd = CFG.gameplay.playerSpeed;

    state.player.vx = ax.x * spd;
    state.player.vy = ax.y * spd;

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

      // Age-based alpha: oldest faint, newest stronger
      const age01 = n <= 1 ? 1 : i / (n - 1);
      const alpha = aCfg.oldestAlpha + (aCfg.newestAlpha - aCfg.oldestAlpha) * age01;

      ctx.save();
      ctx.globalAlpha = alpha;

      // Fill
      ctx.fillStyle = "rgba(233,237,243,1)";
      if (aCfg.glow) {
        ctx.shadowBlur = 16;
        ctx.shadowColor = "rgba(233,237,243,.30)";
      }
      ctx.beginPath();
      ctx.arc(g.x, g.y, state.player.r, 0, Math.PI * 2);
      ctx.fill();

      // Stroke
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
    const dt = Math.min(0.033, (ts - state.lastFrame) / 1000); // cap dt to avoid jumps
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
  // initial sizing (canvas rect needs layout first)
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
