// AFTERIMAGE v0 config — all tuning knobs live here.
window.CONFIG = {
  canvas: {
    baseWidth: 960,
    baseHeight: 540,
    pixelRatioCap: 2.0, // avoid absurd DPR on mobile
  },

  gameplay: {
    // Core law
    recordWindowSec: 5.0,     // how long each afterimage records/replays
    spawnEverySec: 5.0,       // initial spawn cadence (can ramp later)
    maxAfterimages: 24,       // hard cap for safety (won't be hit in early play)

    // Movement
    playerRadius: 9,
    playerSpeed: 240,         // units/sec (scaled to canvas)
    accel: 9999,              // keep movement snappy (effectively instant)
    friction: 0.0,            // 0 = arcade tight

    // Arena padding (collision walls)
    wallPadding: 26,

    // Difficulty ramp (minimal, clean)
    ramp: {
      enabled: true,
      everySec: 22,           // every N seconds, increase pressure
      spawnEveryDelta: -0.25, // reduce spawn interval slightly
      minSpawnEverySec: 2.5,  // don't go below this in v0
    },

    // Visual clarity
    afterimage: {
      newestAlpha: 0.38,
      oldestAlpha: 0.08,
      strokeAlpha: 0.28,
      glow: true,
      trail: false,           // keep off in v0 (enable later if needed)
    },
  },

  ui: {
    showHintDuringPlay: true,
  },
};
