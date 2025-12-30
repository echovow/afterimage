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

  // -------- Defaults for new systems (won’t require you to edit CONFIG)
  const COLLECT = CFG.collect || {
    momentRadius: 7,
    basePoints: 100,
    // combo multiplier: gentle & capped
    comboStep: 0.35,     // +35% per streak step
    comboCap: 10,        // cap streak contribution
    // early-bonus rewards speed inside the same spawn window
    earlyBonusMax: 0.55, // up to +55% if collected immediately after spawn
    // spawn heuristics
    minDistFromPlayer: 120,
    minDistFromWalls: 30,
    tries: 18,
    // how strongly we prefer danger (near afterimages)
    dangerBias: 0.78,
  };

  // Show spawn interval label (existing UI)
  if (els.tLabel) els.tLabel.textContent = CFG.gameplay.spawnEverySec.toFixed(1);

  // -------- Canvas sizing (crisp but capped DPR)
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

  // -------- State
  const state = {
    view: { w: 0, h: 0, dpr: 1 },
    t: 0,
    last: 0,
    paused: false,
    dead: false,

    spawnEvery: CFG.gameplay.spawnEverySec,
    nextSpawnAt: CFG.gameplay.spawnEverySec,

    // score system (new)
    score: 0,
    combo: 0,           // streak count
    lastCollectAt: 0,   // for UI if desired

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

    // Afterimages: each replays a recorded path loop
    afterimages: [], // {samples:[{t,x,y}], duration, bornAt, idx, x, y}

    // Moment collectible (new)
    moment: {
      active: false,
      x: 0, y: 0,
      bornAt: 0,
      expiresAt: 0,    // EXACTLY next afterimage spawn time (B)
      collected: false,
    },

    // input
    keys: new Set(),
    pointer: { down: false, x: 0, y: 0 },
  };

  // -------- Overlay controls
  function showOverlay(show, deathText) {
    if (!els.overlay) return;
    els.overlay.style.display = show ? "flex" : "none";
    if (deathText && els.how) {
      // reuse the "how" panel as subtitle if you want; safe if absent
      els.how.style.display = "";
      els.how.textContent = deathText;
    }
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

  if (els.btnStart) {
    els.btnStart.addEventListener("click", () => {
      reset();
      showOverlay(false);
    });
  }

  // -------- Helpers
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function hypot(x, y) { return Math.hypot(x, y); }

  function wallBounds() {
    const pad = CFG.gameplay.wallPadding;
    return {
      minX: pad,
      minY: pad,
      maxX: state.view.w - pad,
      maxY: state.view.h - pad,
    };
  }

  function randBetween(a, b) {
    return a + Math.random() * (b - a);
  }

  // -------- Recorder
  function recordSample() {
    const t = state.t;
    const s = state.recorder.samples;
    s.push({ t, x: state.player.x, y: state.player.y });

    const cutoff = t - state.recorder.maxSec;
    while (s.length && s[0].t < cutoff) s.shift();
  }

  // -------- Afterimages (core v1)
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

    state.afterimages.push({
      samples,
      duration,
      bornAt: state.t,
      idx: 0,
      x: samples[0].x,
      y: samples[0].y,
    });
  }

  function updateAfterimages() {
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

  // -------- Moment collectible (NEW)
  // B rule: moment expires when the next afterimage spawns.
  function expireMomentIfNeeded() {
    if (!state.moment.active) return false;
    if (state.t < state.moment.expiresAt) return false;

    // Missed it => combo breaks
    state.moment.active = false;
    state.moment.collected = false;
    if (state.combo > 0) state.combo = 0;
    return true;
  }

  function dangerWeightedSpawn() {
    const b = wallBounds();

    // If there are no afterimages yet, spawn somewhere reasonably away from player.
    const hasDanger = state.afterimages.length > 0;
    const tries = COLLECT.tries;

    for (let i = 0; i < tries; i++) {
      let x, y;

      const useDanger = hasDanger && Math.random() < COLLECT.dangerBias;

      if (useDanger) {
        // Pick a danger anchor: current afterimage positions (creates “temptation”)
        const g = state.afterimages[Math.floor(Math.random() * state.afterimages.length)];

        const ang = Math.random() * Math.PI * 2;
        const dist = randBetween(state.player.r * 2.0, COLLECT.minDistFromPlayer * 1.35);

        x = g.x + Math.cos(ang) * dist;
        y = g.y + Math.sin(ang) * dist;
      } else {
        // fallback random
        x = randBetween(b.minX, b.maxX);
        y = randBetween(b.minY, b.maxY);
      }

      // clamp away from walls a bit
      x = clamp(x, b.minX + COLLECT.minDistFromWalls, b.maxX - COLLECT.minDistFromWalls);
      y = clamp(y, b.minY + COLLECT.minDistFromWalls, b.maxY - COLLECT.minDistFromWalls);

      // keep it away from player so it’s not “free”
      const dp = hypot(x - state.player.x, y - state.player.y);
      if (dp < COLLECT.minDistFromPlayer) continue;

      // also avoid spawning *on top* of an afterimage (too unfair / instant death)
      let tooClose = false;
      const mr = COLLECT.momentRadius + state.player.r + 10;
      const mr2 = mr * mr;
      for (const g2 of state.afterimages) {
        const dx = g2.x - x;
        const dy = g2.y - y;
        if (dx * dx + dy * dy < mr2) { tooClose = true; break; }
      }
      if (tooClose) continue;

      return { x, y };
    }

    // If all fails, just pick safe-ish random
    return {
      x: randBetween(b.minX + 40, b.maxX - 40),
      y: randBetween(b.minY + 40, b.maxY - 40),
    };
  }

  function spawnMoment() {
    // Create a new moment for the next window
    const pos = dangerWeightedSpawn();

    state.moment.active = true;
    state.moment.collected = false;
    state.moment.x = pos.x;
    state.moment.y = pos.y;
    state.moment.bornAt = state.t;
    state.moment.expiresAt = state.nextSpawnAt; // B: expires exactly at next spawn
  }

  function tryCollectMoment() {
    if (!state.moment.active) return;

    const dx = state.player.x - state.moment.x;
    const dy = state.player.y - state.moment.y;
    const rr = state.player.r + COLLECT.momentRadius;
    if (dx * dx + dy * dy > rr * rr) return;

    // collected
    state.moment.active = false;
    state.moment.collected = true;
    state.lastCollectAt = state.t;

    // combo increments (streak of successful windows)
    state.combo += 1;

    // combo multiplier (gentle, capped)
    const streak = Math.min(state.combo, COLLECT.comboCap);
    const comboMult = 1 + (streak - 1) * COLLECT.comboStep;

    // early bonus: rewards quick collection inside the same window
    const window = Math.max(0.0001, state.moment.expiresAt - state.moment.bornAt);
    const fracLeft = clamp((state.moment.expiresAt - state.t) / window, 0, 1);
    const earlyMult = 1 + fracLeft * COLLECT.earlyBonusMax;

    const pts = Math.round(COLLECT.basePoints * comboMult * earlyMult);
    state.score += pts;
  }

  // -------- Input → movement
  function axisFromKeys() {
    const k = state.keys;
    const ax = {
      x: (k.has("ArrowRight") || k.has("KeyD") ? 1 : 0) - (k.has("ArrowLeft") || k.has("KeyA") ? 1 : 0),
      y: (k.has("ArrowDown") || k.has("KeyS") ? 1 : 0) - (k.has("ArrowUp") || k.has("KeyW") ? 1 : 0),
    };

    // pointer drag: acts like intent joystick
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
    state.moment.collected = false;

    state.player.x = state.view.w * 0.5;
    state.player.y = state.view.h * 0.5;
    state.player.vx = 0;
    state.player.vy = 0;

    if (els.hint && CFG.ui.showHintDuringPlay) els.hint.style.display = "";
  }

  function die() {
    state.dead = true;
    showOverlay(true, `You touched your past.\nScore: ${state.score}  •  Combo: ${state.combo}`);
    if (els.hint) els.hint.style.display = "none";
  }

  function update(dt) {
    if (state.paused || state.dead) return;

    state.t += dt;

    // Window expiry BEFORE spawn (so missing breaks combo cleanly)
    expireMomentIfNeeded();

    // Spawn afterimage + new moment at cadence
    if (state.t >= state.nextSpawnAt) {
      // If moment is still active here, it just expired => combo already broken above
      spawnAfterimage();

      // next window
      state.nextSpawnAt = state.t + state.spawnEvery;

      // optional ramp: tighten cadence over time (keeps runs finite)
      if (CFG.gameplay.rampEnabled) {
        state.spawnEvery = Math.max(
          CFG.gameplay.spawnEveryMinSec,
          state.spawnEvery - CFG.gameplay.rampDeltaSec
        );
      }
      if (els.tLabel) els.tLabel.textContent = state.spawnEvery.toFixed(1);

      // spawn a fresh moment for THIS new window
      spawnMoment();
    }

    updateAfterimages();
    updatePlayer(dt);

    // record movement for upcoming afterimage
    recordSample();

    // moment collection check
    tryCollectMoment();

    // collision
    if (collidePlayerWithAfterimages()) die();
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

  function drawMoment() {
    if (!state.moment.active) return;

    const r = COLLECT.momentRadius;
    const pulse = 0.5 + 0.5 * Math.sin(state.t * 6.0);
    const a = 0.55 + 0.25 * pulse;

    // subtle “glyph” diamond (quiet, readable)
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

    // tiny core
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

    // subtle halo
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
    drawMoment();
    drawPlayer();

    // HUD text (keep it compact)
    const timeStr = state.t.toFixed(2);
    const comboStr = state.combo > 0 ? `x${state.combo}` : "—";
    if (els.time) els.time.textContent = `${timeStr}  •  ${state.score}  •  ${comboStr}`;

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

  // -------- Events
  window.addEventListener("resize", () => resizeCanvas());

  window.addEventListener("keydown", (e) => {
    const k = e.code;

    if (k === "KeyR") {
      reset();
      showOverlay(false);
      return;
    }

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
  showOverlay(true);
  setHow(true);
  requestAnimationFrame(tick);
})();
