/* AFTERIMAGE — main.js (Entropy v1 added)
   - Adds Entropy/Desync mode as deterministic desync on afterimage replay to prevent clump-cheese
   - Supports optional multi-mode start buttons:
       #btnStartSignal, #btnStartPressure, #btnStartEntropy
     or buttons with [data-mode="signal|pressure|entropy"]
*/

const CFG = (window.CONFIG || {});
// ---- defaults (keeps old config working)
CFG.gameplay = CFG.gameplay || {};
CFG.visual = CFG.visual || {};
CFG.controls = CFG.controls || {};
// New: Entropy / Desync mode defaults
CFG.gameplay.entropy = Object.assign(
  {
    enabled: false,
    // how much each ghost's replay speed can vary (0.06 = ±6%)
    speedVar: 0.06,
    // seconds of phase offset range
    phaseVarSec: 0.45,
    // positional shear (px) applied perpendicular to ghost velocity
    shearPx: 10,
    // ramp to full entropy over N seconds
    rampSec: 35,
  },
  (CFG.gameplay.entropy || {})
);

// Optional: mode presets if you want config-driven tuning
CFG.modes = Object.assign(
  {
    signal: { entropy: false },
    pressure: { entropy: false },
    entropy: { entropy: true },
  },
  (CFG.modes || {})
);

// Deterministic hash (no RNG). Used to desync ghosts in Entropy mode.
function hashU32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function hashSamples(samples) {
  // quantize to keep hash stable across minor float noise
  let s = "";
  const n = Math.min(samples.length, 900); // cap work
  const step = Math.max(1, Math.floor(n / 300));
  for (let i = 0; i < n; i += step) {
    const p = samples[i];
    s += ((p.x * 10) | 0) + "," + ((p.y * 10) | 0) + "," + ((p.t * 100) | 0) + ";";
  }
  return hashU32(s);
}

const els = {
  canvas: document.getElementById("c"),
  overlay: document.getElementById("overlay"),
  btnStart: document.getElementById("btnStart"),
  // optional multi-mode buttons
  btnStartSignal: document.getElementById("btnStartSignal"),
  btnStartPressure: document.getElementById("btnStartPressure"),
  btnStartEntropy: document.getElementById("btnStartEntropy"),
  btnHow: document.getElementById("btnHow"),
  btnBack: document.getElementById("btnBack"),
  panelHow: document.getElementById("panelHow"),
  panelMain: document.getElementById("panelMain"),
};

const ctx = els.canvas.getContext("2d", { alpha: false });

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function now() {
  return performance.now() / 1000;
}

function resize() {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const rect = els.canvas.getBoundingClientRect();
  els.canvas.width = Math.floor(rect.width * dpr);
  els.canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);

function showOverlay(on) {
  els.overlay.style.display = on ? "flex" : "none";
  els.overlay.setAttribute("aria-hidden", on ? "false" : "true");
}
function showHow(on) {
  els.panelHow.style.display = on ? "block" : "none";
  els.panelMain.style.display = on ? "none" : "block";
}

els.btnHow?.addEventListener("click", () => showHow(true));
els.btnBack?.addEventListener("click", () => showHow(false));

const state = {
  t0: 0,
  t: 0,
  dt: 0,
  last: 0,

  // player
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,

  // input
  ix: 0,
  iy: 0,
  keys: { up: false, down: false, left: false, right: false },

  // replay recorder
  record: [],
  recordWindow: 5.0,

  // afterimages
  afterimages: [],
  spawnEvery: (CFG.gameplay.spawnEverySec ?? 5.0),
  spawnAt: 0,

  // game
  dead: false,

  // mode: 'signal' | 'pressure' | 'entropy'
  mode: (CFG.startMode || "signal"),
  entropy: { enabled: false },

  view: { w: 0, h: 0 },

  // scoring / HUD
  score: 0,
  combo: 1,
  lastCollectAt: 0,
  pressure: 1.0, // used by your existing HUD if present
  paused: false,
};

function resetState() {
  const rect = els.canvas.getBoundingClientRect();
  Object.assign(state, {
    t0: now(),
    t: 0,
    dt: 0,
    last: now(),

    x: rect.width * 0.5,
    y: rect.height * 0.5,
    vx: 0,
    vy: 0,

    ix: 0,
    iy: 0,
    keys: { up: false, down: false, left: false, right: false },

    record: [],
    recordWindow: (CFG.gameplay.recordWindowSec ?? 5.0),

    afterimages: [],
    spawnEvery: (CFG.gameplay.spawnEverySec ?? 5.0),
    spawnAt: 0,

    dead: false,
    paused: false,

    view: { w: rect.width, h: rect.height },

    score: 0,
    combo: 1,
    lastCollectAt: 0,
    pressure: 1.0,
  });
}

let currentMode = state.mode || "signal";

function applyMode(mode) {
  currentMode = mode || "signal";
  state.mode = currentMode;
  const preset = CFG.modes && CFG.modes[currentMode] ? CFG.modes[currentMode] : null;

  // base gameplay knobs (these already exist in config.js; keep defaults if missing)
  const baseSpawn =
    (CFG.gameplay && typeof CFG.gameplay.spawnEverySec === "number") ? CFG.gameplay.spawnEverySec : 5.0;

  // Mode mapping:
  // - signal: your clean baseline
  // - pressure: your phase-compression mode (keeps your existing pressure tuning via config.js)
  // - entropy: pressure + deterministic desync to prevent clump-cheese
  state.entropy.enabled = !!(preset && preset.entropy);

  // Optional per-mode spawn tweaks (safe defaults)
  if (currentMode === "signal") state.spawnEvery = baseSpawn;
  if (currentMode === "pressure") state.spawnEvery = baseSpawn; // keep your pressure tuning external
  if (currentMode === "entropy") state.spawnEvery = Math.max(2.2, baseSpawn * 0.9);
}

// input
window.addEventListener("keydown", (e) => {
  if (e.code === "ArrowUp" || e.code === "KeyW") state.keys.up = true;
  if (e.code === "ArrowDown" || e.code === "KeyS") state.keys.down = true;
  if (e.code === "ArrowLeft" || e.code === "KeyA") state.keys.left = true;
  if (e.code === "ArrowRight" || e.code === "KeyD") state.keys.right = true;

  if (e.code === "KeyR") {
    showOverlay(false);
    start(currentMode);
  }
  if (e.code === "Space") {
    state.paused = !state.paused;
  }
});

window.addEventListener("keyup", (e) => {
  if (e.code === "ArrowUp" || e.code === "KeyW") state.keys.up = false;
  if (e.code === "ArrowDown" || e.code === "KeyS") state.keys.down = false;
  if (e.code === "ArrowLeft" || e.code === "KeyA") state.keys.left = false;
  if (e.code === "ArrowRight" || e.code === "KeyD") state.keys.right = false;
});

// pointer controls
els.canvas.addEventListener("pointerdown", (e) => {
  els.canvas.setPointerCapture(e.pointerId);
});
els.canvas.addEventListener("pointermove", (e) => {
  // optional: if your v1 uses pointer steering, keep it here.
  // (not forcing changes—just preserving hook)
});

// --------- core loop
function start(mode) {
  resetState();
  applyMode(mode || currentMode);

  resize();
  state.last = now();
  state.spawnAt = state.spawnEvery;

  requestAnimationFrame(frame);
}

function frame() {
  const t = now();
  state.dt = Math.min(0.05, t - state.last);
  state.last = t;

  if (!state.paused && !state.dead) {
    state.t = t - state.t0;
    step(state.dt);
  }

  draw();
  requestAnimationFrame(frame);
}

// --------- gameplay mechanics
function step(dt) {
  stepInput(dt);
  stepPlayer(dt);
  stepRecorder();
  stepAfterimages();
  checkDeath();
}

function stepInput(dt) {
  let ax = 0,
    ay = 0;
  if (state.keys.left) ax -= 1;
  if (state.keys.right) ax += 1;
  if (state.keys.up) ay -= 1;
  if (state.keys.down) ay += 1;

  // normalize
  const m = Math.hypot(ax, ay) || 1;
  ax /= m;
  ay /= m;

  // knobs (use your existing config if present)
  const accel = (CFG.controls.accel ?? 1600);
  const maxV = (CFG.controls.maxV ?? 520);
  const friction = (CFG.controls.friction ?? 0.86);

  state.vx = (state.vx + ax * accel * dt) * friction;
  state.vy = (state.vy + ay * accel * dt) * friction;

  const sp = Math.hypot(state.vx, state.vy);
  if (sp > maxV) {
    const k = maxV / sp;
    state.vx *= k;
    state.vy *= k;
  }
}

function stepPlayer(dt) {
  state.x += state.vx * dt;
  state.y += state.vy * dt;

  const pad = (CFG.gameplay.boundsPad ?? 18);
  state.x = clamp(state.x, pad, state.view.w - pad);
  state.y = clamp(state.y, pad, state.view.h - pad);
}

function stepRecorder() {
  // record the player's path with timestamps relative to now (state.t)
  state.record.push({ x: state.x, y: state.y, t: state.t });

  // drop old samples outside the recordWindow
  const cutoff = state.t - state.recordWindow;
  while (state.record.length && state.record[0].t < cutoff) state.record.shift();
}

function spawnAfterimage() {
  const samples = state.record.slice();
  const seed = hashSamples(samples) ^ (state.afterimages.length * 2654435761);

  if (samples.length < 2) return;

  const bornAt = state.t;
  const duration = state.recordWindow;

  state.afterimages.push({
    bornAt,
    duration,
    samples,
    seed,
    idx: state.afterimages.length,
    x: samples[0].x,
    y: samples[0].y,
  });
}

function stepAfterimages() {
  // spawn
  state.spawnAt -= state.dt;
  if (state.spawnAt <= 0) {
    spawnAfterimage();
    state.spawnAt += state.spawnEvery;
  }

  // step positions
  for (let i = 0; i < state.afterimages.length; i++) {
    const g = state.afterimages[i];

    let local = state.t - g.bornAt;

    // --- Entropy / Desync (deterministic, no RNG)
    // Prevents 'clump-cheese' by making each ghost slightly out-of-phase and sheared
    // based on its recorded path + index.
    if (state.entropy && state.entropy.enabled) {
      const e = CFG.gameplay.entropy;
      const ramp = Math.min(1, local / Math.max(1e-6, e.rampSec));
      const a = ramp;

      // speed var in ±speedVar
      const speed = 1 + (Math.sin((g.seed * 0.00007) + (g.idx * 1.618)) * e.speedVar * a);
      // phase offset in seconds
      const phase = (Math.sin((g.seed * 0.00011) + (g.idx * 0.73)) * e.phaseVarSec * a);

      local = local * speed + phase;
    }

    if (local < 0) local = 0;

    // time along the recorded window [0..duration]
    const tt = (local % g.duration) + (g.samples[0].t);
    // find segment
    let j = 0;
    while (j < g.samples.length - 2 && g.samples[j + 1].t < tt) j++;

    const a = g.samples[j];
    const b = g.samples[j + 1];
    const span = Math.max(1e-6, b.t - a.t);
    const u = clamp((tt - a.t) / span, 0, 1);

    let gx = a.x + (b.x - a.x) * u;
    let gy = a.y + (b.y - a.y) * u;

    if (state.entropy && state.entropy.enabled) {
      const e = CFG.gameplay.entropy;
      // velocity direction (for perpendicular shear)
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const vmag = Math.hypot(vx, vy) || 1;
      const px = -vy / vmag;
      const py = vx / vmag;

      // Shear strength ramps with time since this ghost was born
      const local2 = Math.max(0, (state.t - g.bornAt));
      const ramp = Math.min(1, local2 / Math.max(1e-6, e.rampSec));
      const wob = Math.sin((local2 * 1.9) + (g.idx * 0.91) + (g.seed * 0.00005));
      const shear = e.shearPx * ramp * wob;

      gx += px * shear;
      gy += py * shear;
    }

    g.x = gx;
    g.y = gy;
  }

  // trim old ghosts if your config wants it (optional)
  const maxGhosts = (CFG.gameplay.maxAfterimages ?? 60);
  if (state.afterimages.length > maxGhosts) {
    state.afterimages.splice(0, state.afterimages.length - maxGhosts);
  }
}

function checkDeath() {
  // collision: touch any ghost point = end
  const pr = (CFG.gameplay.playerR ?? 8);
  const gr = (CFG.gameplay.ghostR ?? 8);
  const rr = pr + gr;

  for (const g of state.afterimages) {
    const dx = g.x - state.x;
    const dy = g.y - state.y;
    if (dx * dx + dy * dy <= rr * rr) {
      state.dead = true;
      showOverlay(true);
      return;
    }
  }
}

// --------- rendering
function draw() {
  const w = state.view.w;
  const h = state.view.h;

  // background
  ctx.fillStyle = (CFG.visual.bg ?? "#0b0b0d");
  ctx.fillRect(0, 0, w, h);

  // subtle vignette / frame
  if (CFG.visual.frame !== false) {
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.strokeRect(10, 10, w - 20, h - 20);
  }

  // afterimages
  const ghostAlpha = (CFG.visual.ghostAlpha ?? 0.35);
  ctx.fillStyle = `rgba(255, 200, 120, ${ghostAlpha})`;
  const gr = (CFG.gameplay.ghostR ?? 8);
  for (const g of state.afterimages) {
    ctx.beginPath();
    ctx.arc(g.x, g.y, gr, 0, Math.PI * 2);
    ctx.fill();
  }

  // player
  const pr = (CFG.gameplay.playerR ?? 8);
  ctx.fillStyle = (CFG.visual.playerColor ?? "#f6f0e8");
  ctx.beginPath();
  ctx.arc(state.x, state.y, pr, 0, Math.PI * 2);
  ctx.fill();

  // HUD
  ctx.fillStyle = "rgba(240,220,200,0.85)";
  ctx.font = "14px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  const label =
    (currentMode === "entropy") ? "ENTROPY" :
    (currentMode === "pressure") ? "PRESSURE" :
    "SIGNAL";

  ctx.fillText(`TIME`, 16, 14);
  ctx.fillText(`${state.t.toFixed(2)}`, 16, 32);
  ctx.fillText(`${label}`, 16, 52);

  if (state.paused) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(240,220,200,0.7)";
    ctx.font = "16px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillText("PAUSED", w / 2, h / 2);
  }
}

// Start buttons:
// - supports legacy single button (#btnStart)
// - supports multi-mode buttons if present:
//   #btnStartSignal, #btnStartPressure, #btnStartEntropy
//   OR any button with [data-mode="signal|pressure|entropy"]
function bindStartButton(el, mode) {
  if (!el) return;
  el.addEventListener("click", () => {
    showOverlay(false);
    start(mode);
  });
}

bindStartButton(els.btnStartSignal, "signal");
bindStartButton(els.btnStartPressure, "pressure");
bindStartButton(els.btnStartEntropy, "entropy");

// data-mode fallback (lets you add buttons in HTML without changing JS)
document.querySelectorAll("[data-mode]").forEach((btn) => {
  bindStartButton(btn, btn.getAttribute("data-mode") || "signal");
});

// legacy single button behavior
bindStartButton(els.btnStart, currentMode);

// boot
resize();
showOverlay(true);
showHow(false);
