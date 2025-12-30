(() => {
  const CFG = window.CONFIG;

  // -------- DOM
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d", { alpha: true });

  const els = {
    overlay: document.getElementById("overlay"),
    btnStart: document.getElementById("btnStart"), // optional legacy
    btnHow: document.getElementById("btnHow"),
    how: document.getElementById("how"),
    time: document.getElementById("time"),
    hint: document.getElementById("hint"),
    tLabel: document.getElementById("tLabel"),
  };

  // -------- Deterministic hash (NO RNG) for entropy seeds
  function hashU32(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function hashSamples(samples) {
    // quantize & subsample so hash is stable + cheap
    const n = Math.min(samples.length, 900);
    const step = Math.max(1, Math.floor(n / 300));
    let s = "";
    for (let i = 0; i < n; i += step) {
      const p = samples[i];
      s += ((p.x * 10) | 0) + "," + ((p.y * 10) | 0) + "," + ((p.t * 100) | 0) + ";";
    }
    return hashU32(s);
  }

  // -------- Modes
  // SIGNAL = base. PRESSURE = phase compression. ENTROPY = phase compression + deterministic desync.
  // CROWN = PRESSURE + ENTROPY + DEBT (collecting spawns delayed hazards at moment location).
  const MODES = {
    signal: {
      name: "SIGNAL",
      phaseCompression: false,
      entropy: false,
      crown: false,
    },
    pressure: {
      name: "PRESSURE",
      phaseCompression: true,
      entropy: false,
      crown: false,
      rampPerSec: 0.0045, // ~ +0.27x per minute
      maxMult: 1.55,
      graceSec: 8,
    },
    entropy: {
      name: "ENTROPY",
      phaseCompression: true,
      entropy: true,
      crown: false,

      rampPerSec: 0.0052,
      maxMult: 1.70,
      graceSec: 6,

      entropyCfg: {
        speedVar: 0.06,     // ±6% per-ghost speed variance
        phaseVarSec: 0.45,  // ±0.45s per-ghost phase offset
        shearPx: 10,        // perpendicular shear (px) from recorded direction
        rampSec: 35,        // time to reach full entropy strength
      },
    },
    crown: {
      name: "CROWN",
      phaseCompression: true,
      entropy: true,
      crown: true,

      // hotter than Entropy: this is the "real players" lane
      rampPerSec: 0.0062,
      maxMult: 1.88,
      graceSec: 4,

      entropyCfg: {
        speedVar: 0.075,
        phaseVarSec: 0.55,
        shearPx: 12,
        rampSec: 28,
      },

      // DEBT system
      crownCfg: {
        debtDelaySec: 1.45,  // delay from collect -> shard spawns
        debtCap: 5,          // max pending debts at once
        shardLifeSec: 22,    // shard persists this long then expires
        shardR: null,        // null => use player radius
      },
    },
  };

  // Score/collect system (v1.5)
  const COLLECT = CFG.collect || {
    momentRadius: 7,
    basePoints: 100,
    comboStep: 0.35,
    comboCap: 10,
    earlyBonusMax: 0.55,
    minDistFromPlayer: 120,
    minDistFromWalls: 30,
    tries: 18,
    dangerBias: 0.78,
  };

  // -------- State
  const state = {
    view: { w: 0, h: 0, dpr: 1 },
    t: 0,
    last: 0,
    paused: false,
    dead: false,

    // mode
    modeKey: "signal",
    mode: MODES.signal,

    spawnEvery: CFG.gameplay.spawnEverySec,
    nextSpawnAt: CFG.gameplay.spawnEverySec,

    score: 0,
    combo: 0,

    player: {
      x: 0, y: 0,
      vx: 0, vy: 0,
      r: CFG.gameplay.playerRadius,
    },

    recorder: {
      maxSec: CFG.gameplay.recordWindowSec,
      samples: [],
    },

    // afterimages: {samples, duration, bornAt, idx, x, y, seed, id}
    afterimages: [],

    // Crown shards (static hazards created by DEBT)
    // shard: {x,y,r, bornAt, expiresAt}
    shards: [],
    debtQueue: [], // {x,y, dueAt}

    moment: {
      active: false,
      x: 0, y: 0,
      bornAt: 0,
      expiresAt: 0,
    },

    keys: new Set(),
    pointer: { down: false, x: 0, y: 0 },
  };

  // -------- Canvas sizing
  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    state.view.w = rect.width;
    state.view.h = rect.height;
    state.view.dpr = dpr;
  }

  // -------- Overlay: create mode buttons if needed
  function ensureModeButtons() {
    if (!els.overlay) return;

    // If already present, do nothing
    if (
      document.getElementById("btnSignal") &&
      document.getElementById("btnPressure") &&
      document.getElementById("btnEntropy") &&
      document.getElementById("btnCrown")
    ) return;

    const box = document.createElement("div");
    box.style.display = "flex";
    box.style.flexDirection = "column";
    box.style.gap = "10px";
    box.style.alignItems = "center";
    box.style.marginTop = "14px";

    const mkBtn = (id, text) => {
      const b = document.createElement("button");
      b.id = id;
      b.textContent = text;
      b.style.cursor = "pointer";
      b.style.padding = "10px 14px";
      b.style.borderRadius = "12px";
      b.style.border = "1px solid rgba(233,237,243,.25)";
      b.style.background = "rgba(0,0,0,.35)";
      b.style.color = "rgba(233,237,243,.92)";
      b.style.font = "600 14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
      b.style.letterSpacing = ".08em";
      b.onmouseenter = () => (b.style.background = "rgba(233,237,243,.10)");
      b.onmouseleave = () => (b.style.background = "rgba(0,0,0,.35)");
      return b;
    };

    const btnSignal = mkBtn("btnSignal", "START — SIGNAL (BASE)");
    const btnPressure = mkBtn("btnPressure", "START — PRESSURE (PHASE)");
    const btnEntropy = mkBtn("btnEntropy", "START — ENTROPY (DESYNC)");
    const btnCrown = mkBtn("btnCrown", "START — CROWN (OVERCLOCK)");

    box.appendChild(btnSignal);
    box.appendChild(btnPressure);
    box.appendChild(btnEntropy);
    box.appendChild(btnCrown);
    els.overlay.appendChild(box);

    btnSignal.addEventListener("click", () => startWithMode("signal"));
    btnPressure.addEventListener("click", () => startWithMode("pressure"));
    btnEntropy.addEventListener("click", () => startWithMode("entropy"));
    btnCrown.addEventListener("click", () => startWithMode("crown"));
  }

  function showOverlay(show) {
    if (!els.overlay) return;
    els.overlay.style.display = show ? "flex" : "none";
  }

  function setHow(show) {
    if (!els.how) return;
    els.how.style.display = show ? "" : "none";
  }

  if (els.btnHow) {
    els.btnHow.addEventListener("click", () => {
      const isOpen = els.how && els.how.style.display !== "none";
      setHow(!isOpen);
    });
  }

  // Legacy single start button (optional)
  if (els.btnStart) {
    els.btnStart.addEventListener("click", () => startWithMode("signal"));
  }

  // -------- Helpers
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function hypot(x, y) { return Math.hypot(x, y); }
  function randBetween(a, b) { return a + Math.random() * (b - a); }

  function wallBounds() {
    const pad = CFG.gameplay.wallPadding;
    return {
      minX: pad,
      minY: pad,
      maxX: state.view.w - pad,
      maxY: state.view.h - pad,
    };
  }

  // -------- Recorder
  function recordSample() {
    const t = state.t;
    const s = state.recorder.samples;
    s.push({ t, x: state.player.x, y: state.player.y });

    const cutoff = t - state.recorder.maxSec;
    while (s.length && s[0].t < cutoff) s.shift();
  }

  // -------- Spawn afterimage
  function spawnAfterimage() {
    const s = state.recorder.samples;
    if (s.length < 2) return;

    const startT = s[0].t;
    const duration = s[s.length - 1].t - startT;
    if (duration <= 0.05) return;

    const samples = s.map(p => ({
      t: p.t - startT,
      x: p.x,
      y: p.y,
    }));

    // seed: deterministic per-path + index
    const seed = (hashSamples(samples) ^ ((state.afterimages.length + 1) * 2654435761)) >>> 0;

    state.afterimages.push({
      samples,
      duration,
      bornAt: state.t,
      idx: 0,
      x: samples[0].x,
      y: samples[0].y,
      seed,
      id: state.afterimages.length,
    });
  }

  // -------- Phase compression: compute replay speed multiplier
  function replaySpeedMult() {
    if (!state.mode.phaseCompression) return 1.0;
    const m = state.mode;

    const tEff = Math.max(0, state.t - (m.graceSec || 0));
    const mult = 1.0 + tEff * (m.rampPerSec || 0);
    return clamp(mult, 1.0, m.maxMult || 1.5);
  }

  // -------- Entropy helpers (deterministic)
  function entropyRamp(gAgeSec) {
    const e = state.mode.entropyCfg;
    if (!e) return 0;
    return clamp(gAgeSec / Math.max(1e-6, e.rampSec), 0, 1);
  }

  function updateAfterimages() {
    const speedBase = replaySpeedMult();

    for (const g of state.afterimages) {
      const age = Math.max(0, state.t - g.bornAt);

      // local time runs faster under phase compression
      let local = ((state.t - g.bornAt) * speedBase);

      // ENTROPY: per-ghost deterministic micro-desync (timing + shear)
      let doEntropy = !!state.mode.entropy;
      let speedMult = 1.0;
      let phaseOff = 0.0;
      let shearPx = 0.0;

      if (doEntropy && state.mode.entropyCfg) {
        const e = state.mode.entropyCfg;
        const r = entropyRamp(age);

        // deterministic [-1..1] using sin
        const sA = Math.sin((g.seed * 0.00007) + (g.id * 1.618));
        const sB = Math.sin((g.seed * 0.00011) + (g.id * 0.73));

        speedMult = 1.0 + (sA * e.speedVar * r);
        phaseOff = (sB * e.phaseVarSec * r);

        // shear wobble ramps in too
        const wob = Math.sin((age * 1.9) + (g.id * 0.91) + (g.seed * 0.00005));
        shearPx = (e.shearPx * r * wob);
      }

      local = (local * speedMult + phaseOff);

      // wrap within ghost duration
      const localWrapped = ((local % g.duration) + g.duration) % g.duration;

      while (g.idx < g.samples.length - 2 && g.samples[g.idx + 1].t < localWrapped) {
        g.idx++;
      }

      const a = g.samples[g.idx];
      const b = g.samples[Math.min(g.idx + 1, g.samples.length - 1)];
      const span = Math.max(0.0001, b.t - a.t);
      const u = clamp((localWrapped - a.t) / span, 0, 1);

      let gx = a.x + (b.x - a.x) * u;
      let gy = a.y + (b.y - a.y) * u;

      // Apply shear perpendicular to velocity (tiny, elegant)
      if (doEntropy && shearPx !== 0) {
        const vx = (b.x - a.x);
        const vy = (b.y - a.y);
        const vm = Math.hypot(vx, vy) || 1;
        const px = -vy / vm;
        const py =  vx / vm;
        gx += px * shearPx;
        gy += py * shearPx;
      }

      g.x = gx;
      g.y = gy;
    }
  }

  // -------- Crown shards
  function spawnShardAt(x, y) {
    const cc = state.mode.crownCfg;
    if (!cc) return;

    const r = (cc.shardR == null) ? state.player.r : cc.shardR;
    const bornAt = state.t;
    const expiresAt = state.t + (cc.shardLifeSec || 22);

    state.shards.push({ x, y, r, bornAt, expiresAt });

    // Hard cap shards to avoid runaway (remove oldest)
    const maxShards = 60;
    if (state.shards.length > maxShards) {
      state.shards.splice(0, state.shards.length - maxShards);
    }
  }

  function updateCrownDebt() {
    if (!state.mode.crown) return;

    // Convert due debts into shards
    while (state.debtQueue.length && state.debtQueue[0].dueAt <= state.t) {
      const d = state.debtQueue.shift();
      spawnShardAt(d.x, d.y);
    }

    // Expire old shards
    if (state.shards.length) {
      state.shards = state.shards.filter(s => s.expiresAt > state.t);
    }
  }

  function collidePlayerWithShards() {
    if (!state.shards.length) return false;

    const px = state.player.x, py = state.player.y, pr = state.player.r;
    for (const s of state.shards) {
      const rr = pr + s.r;
      const dx = s.x - px;
      const dy = s.y - py;
      if (dx * dx + dy * dy <= rr * rr) return true;
    }
    return false;
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

  // -------- Moment (B expiry)
  function expireMomentIfNeeded() {
    if (!state.moment.active) return false;
    if (state.t < state.moment.expiresAt) return false;

    state.moment.active = false;
    if (state.combo > 0) state.combo = 0;
    return true;
  }

  function dangerWeightedSpawn() {
    const b = wallBounds();
    const hasDanger = state.afterimages.length > 0;

    for (let i = 0; i < COLLECT.tries; i++) {
      let x, y;

      const useDanger = hasDanger && Math.random() < COLLECT.dangerBias;

      if (useDanger) {
        const g = state.afterimages[Math.floor(Math.random() * state.afterimages.length)];
        const ang = Math.random() * Math.PI * 2;
        const dist = randBetween(state.player.r * 2.0, COLLECT.minDistFromPlayer * 1.35);
        x = g.x + Math.cos(ang) * dist;
        y = g.y + Math.sin(ang) * dist;
      } else {
        x = randBetween(b.minX, b.maxX);
        y = randBetween(b.minY, b.maxY);
      }

      x = clamp(x, b.minX + COLLECT.minDistFromWalls, b.maxX - COLLECT.minDistFromWalls);
      y = clamp(y, b.minY + COLLECT.minDistFromWalls, b.maxY - COLLECT.minDistFromWalls);

      const dp = hypot(x - state.player.x, y - state.player.y);
      if (dp < COLLECT.minDistFromPlayer) continue;

      // avoid instant unfair overlap with ghosts
      let tooClose = false;
      const mr = COLLECT.momentRadius + state.player.r + 10;
      const mr2 = mr * mr;
      for (const g2 of state.afterimages) {
        const dx = g2.x - x;
        const dy = g2.y - y;
        if (dx * dx + dy * dy < mr2) { tooClose = true; break; }
      }
      if (tooClose) continue;

      // also avoid spawning directly on shards (Crown fairness)
      for (const s2 of state.shards) {
        const dx = s2.x - x;
        const dy = s2.y - y;
        const rr = (s2.r + COLLECT.momentRadius + 10);
        if (dx * dx + dy * dy < rr * rr) { tooClose = true; break; }
      }
      if (tooClose) continue;

      return { x, y };
    }

    return {
      x: randBetween(b.minX + 40, b.maxX - 40),
      y: randBetween(b.minY + 40, b.maxY - 40),
    };
  }

  function spawnMoment() {
    const pos = dangerWeightedSpawn();
    state.moment.active = true;
    state.moment.x = pos.x;
    state.moment.y = pos.y;
    state.moment.bornAt = state.t;
    state.moment.expiresAt = state.nextSpawnAt;
  }

  function enqueueDebtAtMoment(x, y) {
    const cc = state.mode.crownCfg;
    if (!cc) return;

    // cap pending debts
    if (state.debtQueue.length >= (cc.debtCap || 5)) return;

    state.debtQueue.push({
      x, y,
      dueAt: state.t + (cc.debtDelaySec || 1.45),
    });

    // keep dueAt order
    state.debtQueue.sort((a, b) => a.dueAt - b.dueAt);
  }

  function tryCollectMoment() {
    if (!state.moment.active) return;

    const dx = state.player.x - state.moment.x;
    const dy = state.player.y - state.moment.y;
    const rr = state.player.r + COLLECT.momentRadius;
    if (dx * dx + dy * dy > rr * rr) return;

    // capture moment location BEFORE deactivating
    const mx = state.moment.x;
    const my = state.moment.y;

    state.moment.active = false;
    state.combo += 1;

    const streak = Math.min(state.combo, COLLECT.comboCap);
    const comboMult = 1 + (streak - 1) * COLLECT.comboStep;

    const window = Math.max(0.0001, state.moment.expiresAt - state.moment.bornAt);
    const fracLeft = clamp((state.moment.expiresAt - state.t) / window, 0, 1);
    const earlyMult = 1 + fracLeft * COLLECT.earlyBonusMax;

    const pts = Math.round(COLLECT.basePoints * comboMult * earlyMult);
    state.score += pts;

    // CROWN: Debt -> delayed shard at moment location (predictable, fair)
    if (state.mode.crown) {
      enqueueDebtAtMoment(mx, my);
    }
  }

  // -------- Input → movement
  function axisFromKeys() {
    const k = state.keys;
    const ax = {
      x: (k.has("ArrowRight") || k.has("KeyD") ? 1 : 0) - (k.has("ArrowLeft") || k.has("KeyA") ? 1 : 0),
      y: (k.has("ArrowDown") || k.has("KeyS") ? 1 : 0) - (k.has("ArrowUp") || k.has("KeyW") ? 1 : 0),
    };

    if (state.pointer.down) {
      const dx = state.pointer.x - state.player.x;
      const dy = state.pointer.y - state.player.y;
      const d = hypot(dx, dy);
      if (d > 12) {
        ax.x += dx / d;
        ax.y += dy / d;
      }
    }

    const m = hypot(ax.x, ax.y);
    if (m > 0.001) { ax.x /= m; ax.y /= m; }
    return ax;
  }

  function updatePlayer(dt) {
    const ax = axisFromKeys();
    const spd = CFG.gameplay.playerSpeed;

    state.player.vx = ax.x * spd;
    state.player.vy = ax.y * spd;

    state.player.x += state.player.vx * dt;
    state.player.y += state.player.vy * dt;

    const b = wallBounds();
    state.player.x = clamp(state.player.x, b.minX, b.maxX);
    state.player.y = clamp(state.player.y, b.minY, b.maxY);
  }

  // -------- Game loop
  function reset() {
    resizeCanvas();

    state.t = 0;
    state.last = performance.now();
    state.paused = false;
    state.dead = false;

    state.afterimages = [];
    state.recorder.samples = [];

    state.spawnEvery = CFG.gameplay.spawnEverySec;
    state.nextSpawnAt = state.spawnEvery;

    state.score = 0;
    state.combo = 0;

    state.moment.active = false;

    // Crown
    state.shards = [];
    state.debtQueue = [];

    state.player.x = state.view.w * 0.5;
    state.player.y = state.view.h * 0.5;
    state.player.vx = 0;
    state.player.vy = 0;

    if (els.tLabel) els.tLabel.textContent = state.spawnEvery.toFixed(1);
    if (els.hint && CFG.ui.showHintDuringPlay) els.hint.style.display = "";
  }

  function startWithMode(key) {
    state.modeKey = key;
    state.mode = MODES[key] || MODES.signal;
    reset();
    showOverlay(false);
  }

  function die() {
    state.dead = true;
    showOverlay(true);
    if (els.hint) els.hint.style.display = "none";
  }

  function update(dt) {
    if (state.paused || state.dead) return;

    state.t += dt;

    // expire moment window first
    expireMomentIfNeeded();

    // Spawn cadence
    if (state.t >= state.nextSpawnAt) {
      spawnAfterimage();

      state.nextSpawnAt = state.t + state.spawnEvery;

      if (CFG.gameplay.rampEnabled) {
        state.spawnEvery = Math.max(
          CFG.gameplay.spawnEveryMinSec,
          state.spawnEvery - CFG.gameplay.rampDeltaSec
        );
      }
      if (els.tLabel) els.tLabel.textContent = state.spawnEvery.toFixed(1);

      spawnMoment();
    }

    updateAfterimages();
    updateCrownDebt();     // CROWN: debts -> shards, shard expiry
    updatePlayer(dt);
    recordSample();
    tryCollectMoment();

    if (collidePlayerWithAfterimages()) die();
    if (collidePlayerWithShards()) die(); // CROWN hazards
  }

  // -------- Render
  function clear() {
    ctx.clearRect(0, 0, state.view.w, state.view.h);
  }

  function drawArena() {
    const b = wallBounds();
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = "rgba(233,237,243,.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(b.minX - 14, b.minY - 14, (b.maxX - b.minX) + 28, (b.maxY - b.minY) + 28, 18);
    ctx.stroke();
    ctx.restore();
  }

  function drawAfterimages() {
    for (const g of state.afterimages) {
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = "rgba(233,237,243,1)";
      ctx.beginPath();
      ctx.arc(g.x, g.y, state.player.r, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.08;
      ctx.strokeStyle = "rgba(233,237,243,1)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(g.x, g.y, state.player.r + 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawShards() {
    if (!state.shards.length) return;

    for (const s of state.shards) {
      const life = Math.max(0.0001, s.expiresAt - s.bornAt);
      const age = clamp((state.t - s.bornAt) / life, 0, 1);
      const a = 0.28 + 0.22 * Math.sin((state.t - s.bornAt) * 7.0);
      const fade = 1 - age;

      ctx.save();
      ctx.globalAlpha = a * fade;
      ctx.strokeStyle = "rgba(233,237,243,1)";
      ctx.lineWidth = 1.5;

      // diamond shard
      const r = s.r + 6;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - r);
      ctx.lineTo(s.x + r, s.y);
      ctx.lineTo(s.x, s.y + r);
      ctx.lineTo(s.x - r, s.y);
      ctx.closePath();
      ctx.stroke();

      ctx.globalAlpha = (a * 0.55) * fade;
      ctx.fillStyle = "rgba(233,237,243,1)";
      ctx.beginPath();
      ctx.arc(s.x, s.y, 1.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }
  }

  function drawMoment() {
    if (!state.moment.active) return;

    const r = COLLECT.momentRadius;
    const pulse = 0.5 + 0.5 * Math.sin(state.t * 6.0);
    const a = 0.55 + 0.25 * pulse;

    ctx.save();
    ctx.translate(state.moment.x, state.moment.y);

    ctx.globalAlpha = a;
    ctx.strokeStyle = "rgba(233,237,243,1)";
    ctx.lineWidth = 1.5;

    ctx.beginPath();
    ctx.moveTo(0, -r - 2);
    ctx.lineTo(r + 2, 0);
    ctx.lineTo(0, r + 2);
    ctx.lineTo(-r - 2, 0);
    ctx.closePath();
    ctx.stroke();

    ctx.globalAlpha = a * 0.8;
    ctx.fillStyle = "rgba(233,237,243,1)";
    ctx.beginPath();
    ctx.arc(0, 0, 1.8 + pulse * 0.8, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawPlayer() {
    const p = state.player;

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(233,237,243,1)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 0.08;
    ctx.strokeStyle = "rgba(233,237,243,1)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function render() {
    clear();
    drawArena();
    drawAfterimages();
    drawShards(); // crown hazards
    drawMoment();
    drawPlayer();

    // HUD
    const timeStr = state.t.toFixed(2);
    const comboStr = state.combo > 0 ? `x${state.combo}` : "—";
    const modeStr = state.mode.name;

    const speedStr = state.mode.phaseCompression ? `${replaySpeedMult().toFixed(2)}x` : "1.00x";
    const debtStr = state.mode.crown ? ` • DEBT ${state.debtQueue.length}` : "";
    if (els.time) els.time.textContent = `${modeStr} (${speedStr}) • ${timeStr} • ${state.score} • ${comboStr}${debtStr}`;

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

  // -------- Events
  window.addEventListener("resize", () => resizeCanvas());

  window.addEventListener("keydown", (e) => {
    const k = e.code;

    if (k === "KeyR") {
      startWithMode(state.modeKey); // restart same mode
      return;
    }

    if (k === "Digit1") startWithMode("signal");
    if (k === "Digit2") startWithMode("pressure");
    if (k === "Digit3") startWithMode("entropy");
    if (k === "Digit4") startWithMode("crown");

    if (k === "Space") {
      state.paused = !state.paused;
      e.preventDefault();
      return;
    }

    state.keys.add(k);
  });

  window.addEventListener("keyup", (e) => {
    state.keys.delete(e.code);
  });

  canvas.addEventListener("pointerdown", (e) => {
    state.pointer.down = true;
    const rect = canvas.getBoundingClientRect();
    state.pointer.x = e.clientX - rect.left;
    state.pointer.y = e.clientY - rect.top;
  });

  window.addEventListener("pointermove", (e) => {
    if (!state.pointer.down) return;
    const rect = canvas.getBoundingClientRect();
    state.pointer.x = e.clientX - rect.left;
    state.pointer.y = e.clientY - rect.top;
  });

  window.addEventListener("pointerup", () => {
    state.pointer.down = false;
  });

  // -------- RAF
  function tick(now) {
    if (!state.last) state.last = now;
    const dt = clamp((now - state.last) / 1000, 0, 0.033);
    state.last = now;

    update(dt);
    render();

    requestAnimationFrame(tick);
  }

  // -------- Boot
  resizeCanvas();
  ensureModeButtons();
  showOverlay(true);
  setHow(true);

  requestAnimationFrame(tick);
})();
