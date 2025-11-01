/* -------------------------
   Utilities & Defaults
------------------------- */
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const midiToHz   = m => 440.0 * Math.pow(2, (m - 69) / 12);
const midiToNote = m => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);

const MIDI_ABS_LOW  = 20;
const MIDI_ABS_HIGH = 100;

const DEFAULTS = {
  midiLow: 48,
  midiHigh: 72,
  card: [3, 3],
  span: [0, 12],
  mixRatio: 0.5,
  duration: 2.5,
  aim: 0.8,
  win: 10,
  arpEvery: 3,      // arpeggiate every Nth replay (0 = never)
  arpNoteDur: 0.6,  // seconds per arpeggio note
  hExp: 1.8         // << harmonic falloff exponent: partial amp = 1 / h^hExp
};

/* -------------------------
   Storage
------------------------- */
const STORAGE = {
  CURRENT_USER: "pitchsettrainer_current_user",
  USER_PREFIX: "pitchsettrainer_user_",
  LAST_NON_GUEST_SETTINGS: "pitchsettrainer_last_non_guest_settings"
};

const Storage = {
  listUsers() {
    const users = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STORAGE.USER_PREFIX)) {
        users.push(k.slice(STORAGE.USER_PREFIX.length));
      }
    }
    return users.sort();
  },

  save(user, data) {
    if (user === "Guest") return;
    localStorage.setItem(STORAGE.USER_PREFIX + user, JSON.stringify(data));
    localStorage.setItem(STORAGE.CURRENT_USER, user);
    if (data.settings) {
      localStorage.setItem(STORAGE.LAST_NON_GUEST_SETTINGS, JSON.stringify(data.settings));
    }
  },

  load(user) {
    if (user === "Guest") {
      const raw = localStorage.getItem(STORAGE.LAST_NON_GUEST_SETTINGS);
      const settings = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
      return { settings, log: [] };
    }
    const raw = localStorage.getItem(STORAGE.USER_PREFIX + user);
    if (!raw) return { settings: { ...DEFAULTS }, log: [] };
    try {
      const parsed = JSON.parse(raw);
      return {
        settings: { ...DEFAULTS, ...(parsed.settings || {}) },
        log: Array.isArray(parsed.log) ? parsed.log : []
      };
    } catch {
      return { settings: { ...DEFAULTS }, log: [] };
    }
  },

  remove(user) {
    if (user === "Guest") return;
    localStorage.removeItem(STORAGE.USER_PREFIX + user);
    const cur = localStorage.getItem(STORAGE.CURRENT_USER);
    if (cur === user) localStorage.removeItem(STORAGE.CURRENT_USER);
  },

  lastUser() {
    return localStorage.getItem(STORAGE.CURRENT_USER) || "Guest";
  }
};


// then request persistence early
(async () => {
  if (navigator.storage && navigator.storage.persist) {
    try {
      const granted = await navigator.storage.persist();
      console.log('Persistence granted?', granted);
    } catch (err) {
      console.warn('Persistence request failed:', err);
    }
  }
})();


/* -------------------------
   Synth (safe gain + iOS BT fixes)
------------------------- */
class Synth {
  constructor() {
    // Lazy-init; create AudioContext on first gesture/play
    this.ctx = null;
    this.currentNodes = [];
    this.hExp = typeof DEFAULTS.hExp === "number" ? DEFAULTS.hExp : 1.8;

    if (!Synth._unlockInstalled) {
      const tryResume = () => {
        const ctx = this._ctxOrCreate();
        if (ctx.state !== "running") ctx.resume().catch(() => {});
      };
      window.addEventListener("pointerdown", tryResume, { passive: true });
      window.addEventListener("keydown", tryResume);
      document.addEventListener("visibilitychange", tryResume);
      Synth._unlockInstalled = true;
    }
     document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    try {
      const ctx = this._ctxOrCreate();
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      this.stopAll(); // clear any half-dead nodes
    } catch (e) {
      console.warn('[audio] resume on visible failed', e);
    }
  }
});
  }

  _ctxOrCreate() {
    if (this.ctx) return this.ctx;

    if (!Synth.sharedCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;

      // Prefer 48k on iOS (Bluetooth path); change to 44100 if you prefer
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

      const ctx = new Ctor(isIOS ? { sampleRate: 48000, latencyHint: "interactive" }
                                  : { latencyHint: "interactive" });
      Synth.sharedCtx = ctx;

      // Shared pre-master -> soft limiter -> destination
      const pre = ctx.createGain();
      pre.gain.value = 1.0;

      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -14;
      limiter.knee.value = 24;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;

      pre.connect(limiter).connect(ctx.destination);

      Synth.sharedPreMaster = pre;
      Synth.sharedLimiter = limiter;

      try { console.log("[audio] sampleRate:", ctx.sampleRate); } catch {}
    }

    this.ctx = Synth.sharedCtx;
    return this.ctx;
  }

  // Sum of partial amplitudes for N harmonics at exponent hExp
  _harmonicSum(count) {
    let s = 0;
    for (let h = 1; h <= count; h++) s += 1 / Math.pow(h, this.hExp);
    return s;
  }

  playArpeggio(midis, noteDur = DEFAULTS.arpNoteDur) {
    if (!midis.length) return;

    // stop anything currently sounding
    this.currentNodes.forEach(n => { try { n.stop(); } catch {} });
    this.currentNodes = [];

    const ctx = this._ctxOrCreate();
    const now = ctx.currentTime;

    const H = 11;
    const harmonicSum = this._harmonicSum(H);
    const TARGET_PEAK = 0.65;                         // ~ -3.7 dBFS
    const peakScale = Math.min(0.35, TARGET_PEAK / harmonicSum);

    const arpGain = ctx.createGain();
    arpGain.gain.value = peakScale;
    arpGain.connect(Synth.sharedPreMaster);

    // schedule notes back-to-back; no overlap
    midis.forEach((midi, idx) => {
      const start = now + noteDur * idx;
      const end   = start + noteDur;
      const f0    = midiToHz(midi);

      // compact ADSR within [start, end]
      const A = Math.min(0.02, noteDur * 0.25);
      const D = Math.min(0.08, noteDur * 0.25);
      const S = 0.75;
      const R = Math.min(0.06, noteDur * 0.25);

      for (let h = 1; h <= H; h++) {
        const osc = ctx.createOscillator();
        const g   = ctx.createGain();
        const partialAmp = 1 / Math.pow(h, this.hExp);

        osc.type = "sine";
        osc.frequency.value = f0 * h;

        // envelope fits strictly within [start, end]
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(partialAmp, start + A);
        g.gain.linearRampToValueAtTime(S * partialAmp, start + A + D);
        g.gain.setValueAtTime(S * partialAmp, Math.max(start + A + D, end - R));
        g.gain.linearRampToValueAtTime(0, end);

        osc.connect(g).connect(arpGain);
        osc.start(start);
        osc.stop(end);

        this.currentNodes.push(osc);
      }
    });

    setTimeout(() => { try { arpGain.disconnect(); } catch {} }, (noteDur * (midis.length + 1) + 0.5) * 1000);
  }

  playChord(midis, dur = DEFAULTS.duration) {
    if (!midis.length) return;

    // Kill any currently playing nodes
    this.currentNodes.forEach(node => { try { node.stop(); } catch {} });
    this.currentNodes = [];

    const ctx = this._ctxOrCreate();
    const now = ctx.currentTime;

    const H = 11;
    const harmonicSum = this._harmonicSum(H);
    const poly = Math.max(1, midis.length);

    // Headroom-aware scaling into limiter; clamp absolute max too
    const TARGET_PEAK = 0.65;                         // ~ -3.7 dBFS
    const peakScale = Math.min(0.35, TARGET_PEAK / (harmonicSum * poly));

    const chordGain = ctx.createGain();
    chordGain.connect(Synth.sharedPreMaster);

    // ADSR envelope on the chord's master gain
    const A = 0.02, D = 0.15, S = 0.75, R = 0.12;
    chordGain.gain.setValueAtTime(0, now);
    chordGain.gain.linearRampToValueAtTime(peakScale, now + A);
    chordGain.gain.linearRampToValueAtTime(peakScale * S, now + A + D);
    chordGain.gain.setValueAtTime(peakScale * S, now + dur - R);
    chordGain.gain.linearRampToValueAtTime(0, now + dur);

    midis.forEach(midi => {
      const f0 = midiToHz(midi);
      for (let h = 1; h <= H; h++) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const partialAmp = 1 / Math.pow(h, this.hExp);

        osc.type = "sine";
        osc.frequency.value = f0 * h;
        g.gain.value = partialAmp;

        osc.connect(g).connect(chordGain);
        osc.start(now);
        osc.stop(now + dur);

        this.currentNodes.push(osc);
      }
    });

    setTimeout(() => { try { chordGain.disconnect(); } catch {} }, (dur + 0.5) * 1000);
  }

  stopAll() {
    try {
      if (this.currentNodes && this.currentNodes.length) {
        this.currentNodes.forEach(n => {
          try { n.stop(); } catch (e) {}
        });
        this.currentNodes = [];
      }
    } catch (e) {
      console.warn("Synth.stopAll() failed:", e);
    }
  }
}

/* -------------------------
   Trainer
------------------------- */
const keyRel = rel => JSON.stringify(rel);

function generateUniverse({ card: [cMin, cMax], span: [sMin, sMax] }) {
  const universe = [];
  const pool = Array.from({ length: sMax }, (_, i) => i + 1);
  function combos(arr, k, start = 0, chosen = []) {
    if (k === 0) {
      const rel = [0, ...chosen];
      const span = chosen.length ? chosen[chosen.length - 1] : 0;
      if (span >= sMin && span <= sMax) universe.push(rel);
      return;
    }
    for (let i = start; i <= arr.length - k; i++) {
      chosen.push(arr[i]);
      combos(arr, k - 1, i + 1, chosen);
      chosen.pop();
    }
  }
  for (let n = cMin; n <= cMax; n++) combos(pool, n - 1);
  return universe;
}

class Trainer {
  constructor(synth, initialSettings = {}, initialLog = []) {
    this.synth = synth;
    this.settings = { ...DEFAULTS, ...initialSettings };
    this.universe = generateUniverse(this.settings);
    this.current = null;
    this.log = Array.isArray(initialLog) ? initialLog.slice() : [];
    this._replayChordCount = 0;
    this._replayGuessCount = 0;
    this.rng = (initialSettings && typeof initialSettings.rng === 'function')
      ? initialSettings.rng
      : Math.random;

    this._cacheKeys = null;
    this._cacheKeyToIndex = null;
    this._statsByIndex = null;

    this._reachedCount = 0;
    this._reachedIsApprox = false;
    this._sampleLimit = 150000;
    this._sampleK = 2000;
    this._approxRefreshEvery = 500;
    this._submitCounter = 0;

    this._rebuildUniverseAndMigrate();
  }

  _buildCacheIfNeeded() {
    if (this._cacheKeys && this._cacheKeyToIndex && this._statsByIndex) return;
    this._rebuildUniverseAndMigrate();
  }

  _rebuildUniverseAndMigrate() {
    this.universe = generateUniverse(this.settings);

    const newKeys = this.universe.map(rel => keyRel(rel));
    const newKeyToIndex = new Map(newKeys.map((k, i) => [k, i]));

    const N = newKeys.length;
    const WIN = this.settings.win || 10;

    const newStats = Array.from({ length: N }, () => ({ buffer: [], correct: 0 }));

    if (this._cacheKeys && this._statsByIndex) {
      for (let i = 0; i < this._cacheKeys.length; i++) {
        const oldKey = this._cacheKeys[i];
        const newIdx = newKeyToIndex.get(oldKey);
        if (newIdx !== undefined && this._statsByIndex[i]) {
          const oldBuf = (this._statsByIndex[i].buffer || []).slice(-WIN);
          newStats[newIdx].buffer = oldBuf.slice();
          newStats[newIdx].correct = newStats[newIdx].buffer.reduce((s, v) => s + v, 0);
        }
      }
    }

    const remaining = new Set();
    for (let i = 0; i < N; i++) {
      if (newStats[i].buffer.length < WIN) remaining.add(i);
    }

    if (remaining.size > 0 && Array.isArray(this.log) && this.log.length > 0) {
      for (let i = this.log.length - 1; i >= 0 && remaining.size > 0; i--) {
        const entry = this.log[i];
        if (!entry || !entry.rel) continue;
        const k = keyRel(entry.rel);
        const idx = newKeyToIndex.get(k);
        if (idx === undefined) continue;
        const s = newStats[idx];
        if (s.buffer.length < WIN) {
          s.buffer.unshift(entry.ok ? 1 : 0);
          if (s.buffer.length > WIN) s.buffer.shift();
          s.correct = s.buffer.reduce((a, b) => a + b, 0);
          if (s.buffer.length >= WIN) remaining.delete(idx);
        }
      }
    }

    this._cacheKeys = newKeys;
    this._cacheKeyToIndex = newKeyToIndex;
    this._statsByIndex = newStats;

    const rng = (this.rng && typeof this.rng === 'function') ? this.rng : Math.random;
    const AIM = (typeof this.settings.aim === 'number') ? this.settings.aim : 0.8;

    if (N <= this._sampleLimit) {
      let rc = 0;
      for (let i = 0; i < N; i++) {
        const s = this._statsByIndex[i] || { correct: 0 };
        const acc = (s.correct || 0) / WIN;
        if (acc >= AIM) rc++;
      }
      this._reachedCount = rc;
      this._reachedIsApprox = false;
    } else {
      const K = Math.min(this._sampleK, N);
      let hits = 0;
      for (let t = 0; t < K; t++) {
        const i = Math.floor(rng() * N);
        const s = this._statsByIndex[i] || { correct: 0 };
        if ((s.correct || 0) / WIN >= AIM) hits++;
      }
      this._reachedCount = Math.round((hits / K) * N);
      this._reachedIsApprox = true;
    }

    if (this.current && this.current.rel) {
      const curKey = keyRel(this.current.rel);
      if (!this._cacheKeyToIndex.has(curKey)) this.current = null;
    }
  }

  _randomPick() {
    this._buildCacheIfNeeded();

    const UNIVERSE = this.universe;
    if (!UNIVERSE || UNIVERSE.length === 0) return null;

    const WIN = this.settings.win || 10;
    const AIM = (typeof this.settings.aim === 'number') ? this.settings.aim : 0.8;
    const MIX_RATIO = (typeof this.settings.mixRatio === 'number') ? this.settings.mixRatio : 0.5;
    const rng = (this.rng && typeof this.rng === 'function') ? this.rng : Math.random;

    const N = UNIVERSE.length;
    const stats = this._statsByIndex || Array.from({ length: N }, () => ({ buffer: [], correct: 0 }));

    const rawWeights = new Array(N);
    let totalRaw = 0;
    for (let i = 0; i < N; i++) {
      const s = stats[i] || { correct: 0 };
      const acc = (s.correct || 0) / WIN;
      const w = Math.max(0, AIM - acc);
      const jitter = rng() * 1e-12;
      const wj = w + jitter;
      rawWeights[i] = wj;
      totalRaw += wj;
    }

    if (rng() < MIX_RATIO) {
      if (totalRaw <= 1e-12) {
        return UNIVERSE[Math.floor(rng() * N)];
      }
      let r = rng() * totalRaw;
      for (let i = 0; i < N; i++) {
        r -= rawWeights[i];
        if (r <= 0) return UNIVERSE[i];
      }
      return UNIVERSE[N - 1];
    }

    return UNIVERSE[Math.floor(rng() * N)];
  }

  changeSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    this._rebuildUniverseAndMigrate();
    if (this.current && this.current.answered) this.current = null;
  }

  loadSnapshot(snapshot = {}) {
    this.settings = { ...DEFAULTS, ...(snapshot.settings || {}) };
    this.log = Array.isArray(snapshot.log) ? snapshot.log.slice() : [];
    this.universe = generateUniverse(this.settings);
    this._rebuildUniverseAndMigrate();
    this.current = null;
  }

  nextTrial() {
    if (this.current && !this.current.answered) return this.current;
    const rel = this._randomPick();
    if (!rel) return (this.current = null);

    const maxOff = rel[rel.length - 1] || 0;
    const rootHigh = this.settings.midiHigh - maxOff;
    const rootLow = this.settings.midiLow;
    if (rootHigh < rootLow) return (this.current = null);

    const rng = (this.rng && typeof this.rng === 'function') ? this.rng : Math.random;
    const root = Math.floor(rng() * (rootHigh - rootLow + 1)) + rootLow;

    const midis = rel.map(r => root + r)
                     .filter(m => m >= this.settings.midiLow && m <= this.settings.midiHigh);

    this.current = { rel, root, midis, answered: false };
    this._replayChordCount = 0;
    this._replayGuessCount = 0;
    if (midis.length > 0) this.synth.playChord(midis, this.settings.duration);
    return this.current;
  }

  replay() {
    if (this.current && this.current.midis) {
      const playable = this.current.midis.filter(
        m => m >= this.settings.midiLow && m <= this.settings.midiHigh
      );
      if (playable.length > 0) {
        if (this.current.answered) {
          this._replayChordCount++;
          const every = Math.max(0, Math.floor(this.settings.arpEvery || 0));
          const useArp = every > 0 && (this._replayChordCount % every === 0);
          if (useArp) this.synth.playArpeggio(playable, this.settings.arpNoteDur);
          else this.synth.playChord(playable, this.settings.duration);
        } else {
          this.synth.playChord(playable, this.settings.duration);
        }
      }
    }
  }

  playGuess(guessRel) {
    if (!this.current) return;
    const root = this.current.root;
    const playable = guessRel.map(r => root + r)
      .filter(m => m >= this.settings.midiLow && m <= this.settings.midiHigh);
    if (playable.length > 0) {
      if (this.current.answered) {
        this._replayGuessCount++;
        const every = Math.max(0, Math.floor(this.settings.arpEvery || 0));
        const useArp = every > 0 && (this._replayGuessCount % every === 0);
        if (useArp) this.synth.playArpeggio(playable, this.settings.arpNoteDur);
        else this.synth.playChord(playable, this.settings.duration);
      } else {
        this.synth.playChord(playable, this.settings.duration);
      }
    }
  }

  submitGuess(text) {
    if (!this.current || this.current.answered) return null;

    let nums = (text || "").trim()
      .replace(/,/g, " ")
      .split(/\s+/)
      .filter(s => s.length > 0)
      .map(s => parseInt(s, 10))
      .filter(n => !Number.isNaN(n));

    if (nums.length === 0) return { ok: null };

    if (nums[0] !== 0) nums.unshift(0);
    nums = Array.from(new Set(nums)).sort((a, b) => a - b);

    const truth = this.current.rel;
    const ok = keyRel(nums) === keyRel(truth);
    this.current.answered = true;

    const entry = { rel: truth, guess: nums, ok };
    this.log.push(entry);

    this._buildCacheIfNeeded();
    const k = keyRel(truth);
    const idx = this._cacheKeyToIndex.get(k);
    const WIN = this.settings.win || 10;
    const AIM = (typeof this.settings.aim === 'number') ? this.settings.aim : 0.8;
    const rng = (this.rng && typeof this.rng === 'function') ? this.rng : Math.random;

    if (idx !== undefined) {
      const s = this._statsByIndex[idx] || { buffer: [], correct: 0 };
      s.buffer = s.buffer || [];

      const oldCorrect = s.correct || 0;
      const oldAcc = oldCorrect / WIN;

      s.buffer.push(ok ? 1 : 0);
      if (s.buffer.length > WIN) s.buffer.shift();

      s.correct = s.buffer.reduce((a, b) => a + b, 0);
      const newAcc = s.correct / WIN;

      this._statsByIndex[idx] = s;

      if (!this._reachedIsApprox) {
        if (oldAcc < AIM && newAcc >= AIM) this._reachedCount++;
        else if (oldAcc >= AIM && newAcc < AIM) this._reachedCount--;
        if (this._reachedCount < 0) this._reachedCount = 0;
        if (this._cacheKeys && this._reachedCount > this._cacheKeys.length) this._reachedCount = this._cacheKeys.length;
      } else {
        if (oldAcc < AIM && newAcc >= AIM) this._reachedCount++;
        else if (oldAcc >= AIM && newAcc < AIM) this._reachedCount = Math.max(0, this._reachedCount - 1);
      }
    }

    this._submitCounter = (this._submitCounter || 0) + 1;
    if (this._reachedIsApprox && (this._submitCounter % this._approxRefreshEvery === 0)) {
      const N2 = this._statsByIndex.length;
      const K2 = Math.min(this._sampleK, N2);
      let hits2 = 0;
      for (let t = 0; t < K2; t++) {
        const i2 = Math.floor(rng() * N2);
        const s2 = this._statsByIndex[i2] || { correct: 0 };
        if ((s2.correct || 0) / WIN >= AIM) hits2++;
      }
      this._reachedCount = Math.round((hits2 / K2) * N2);
    }

    return { ok, truth, guess: nums };
  }

  snapshotForSave() {
    return { settings: this.settings, log: this.log };
  }
}

/* -------------------------
   UI Boot
------------------------- */
(function initApp() {
  (function injectDisabledSafetyCSS() {
    try {
      const css = "button:disabled{pointer-events:none!important;} select:disabled{pointer-events:none!important;}";
      const s = document.createElement("style");
      s.setAttribute("data-pitchsettrainer-safety","true");
      s.appendChild(document.createTextNode(css));
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      console.warn("Failed to inject disabled-safety CSS:", e);
    }
  })();

  const el = {
    userSelect:    document.getElementById("userSelect"),
    newUserBtn:    document.getElementById("newUserBtn"),
    deleteUserBtn: document.getElementById("deleteUserBtn"),
    cardMin:       document.getElementById("cardMin"),
    cardMax:       document.getElementById("cardMax"),
    midiLow:       document.getElementById("midiLow"),
    midiHigh:      document.getElementById("midiHigh"),
    spanMin:       document.getElementById("spanMin"),
    spanMax:       document.getElementById("spanMax"),
    mixRatio:      document.getElementById("mixRatio"),
    newSetBtn:     document.getElementById("newSetBtn"),
    replaySetBtn:  document.getElementById("replaySetBtn"),
    guessInput:    document.getElementById("guessInput"),
    submitBtn:     document.getElementById("submitBtn"),
    feedback:      document.getElementById("feedback"),
  };

  let currentUser = "Guest";
  const synth   = new Synth();
  const trainer = new Trainer(synth, DEFAULTS);

  /* ---------- input restriction ---------- */
  if (el.guessInput) {
    el.guessInput.addEventListener("input", () => {
      let v = el.guessInput.value.replace(/[^0-9., ]/g, "");
      v = v.replace(/\./g, " ");
      v = v.replace(/,\s*/g, " ");
      v = v.replace(/\s+/g, " ");
      v = v.replace(/^[\s,\.]+/, "");
      el.guessInput.value = v;
    });
  }
  el.guessInput.addEventListener("keydown", e => {
    if (e.repeat) return;
    if (!e.key || e.key.length !== 1) return;
    const k = e.key.toLowerCase();
    if (k === 'c' && el.replaySetBtn && !el.replaySetBtn.disabled) {
      e.preventDefault();
      handleReplay();
    } else if (k === 'g' && el.submitBtn && !el.submitBtn.disabled) {
      e.preventDefault();
      handleSubmit();
    }
  });

  /* ---------- constraint solver ---------- */
  function computeRanges(s) {
    const ranges = {};
    ranges.cardMin  = [2, Math.min(5, s.card[1])];
    ranges.cardMax  = [Math.max(2, s.card[0]), Math.min(5, s.span[1] + 1)];
    ranges.spanMax  = [Math.max(s.card[1] - 1, 0), s.midiHigh - s.midiLow];
    ranges.spanMin  = [0, s.span[1]];
    ranges.midiLow  = [MIDI_ABS_LOW, s.midiHigh - s.span[1]];
    ranges.midiHigh = [s.midiLow + s.span[1], MIDI_ABS_HIGH];
    return ranges;
  }

  function fillSelect(select, [min, max], selected, labelFn = x => x) {
    if (!select) return;
    select.innerHTML = "";
    if (min > max) max = min;
    for (let v = min; v <= max; v++) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = labelFn(v);
      if (v === selected) opt.selected = true;
      select.appendChild(opt);
    }
    if (![...select.options].some(o => o.selected)) {
      select.options[0].selected = true;
    }
  }

  function renderSettingsUI(s) {
    const ranges = computeRanges(s);
    fillSelect(el.cardMin,  ranges.cardMin,  s.card[0]);
    fillSelect(el.cardMax,  ranges.cardMax,  s.card[1]);
    fillSelect(el.spanMax,  ranges.spanMax,  s.span[1]);
    fillSelect(el.spanMin,  ranges.spanMin,  s.span[0]);
    fillSelect(el.midiLow,  ranges.midiLow,  s.midiLow,  midiToNote);
    fillSelect(el.midiHigh, ranges.midiHigh, s.midiHigh, midiToNote);

    if (el.mixRatio) {
      el.mixRatio.innerHTML = "";
      for (let i = 0; i <= 10; i++) {
        const valNum = Math.min(1, i / 10);
        const val = valNum.toFixed(1);
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = `${Math.round(valNum * 100)}%`;
        if (Math.abs(parseFloat(val) - s.mixRatio) < 1e-6) opt.selected = true;
        el.mixRatio.appendChild(opt);
      }
    }
  }

  function readSettingsFromUI() {
    return {
      midiLow: +el.midiLow.value,
      midiHigh: +el.midiHigh.value,
      card: [ +el.cardMin.value, +el.cardMax.value ],
      span: [ +el.spanMin.value, +el.spanMax.value ],
      mixRatio: parseFloat(el.mixRatio.value),
    };
  }

  /* ---------- live refresh ---------- */
  ["midiLow","midiHigh","cardMin","cardMax","spanMin","spanMax","mixRatio"].forEach(id => {
    const node = document.getElementById(id);
    if (!node) return;
    node.addEventListener("change", () => {
      const s = readSettingsFromUI();
      trainer.changeSettings(s);
      renderSettingsUI(trainer.settings);
      trainer.changeSettings(readSettingsFromUI());
      updateButtons();
      Storage.save(currentUser, trainer.snapshotForSave());
    });
  });

  function updateButtons() {
    const cur = trainer.current;

    const supportsKeyboard = window.matchMedia('(any-hover: hover) and (any-pointer: fine)').matches;
    const replayChordLabel = supportsKeyboard ? `Replay <u class="accesskey-u">C</u>hord` : 'Replay Chord';
    const replayGuessLabel = supportsKeyboard ? `Replay <u class="accesskey-u">G</u>uess` : 'Replay Guess';
    const desiredNewInner = supportsKeyboard ? '▶ <u class="accesskey-u">N</u>ew Chord' : '▶ New Chord';

    if (el.newSetBtn && el.newSetBtn.innerHTML.trim() !== desiredNewInner) {
      el.newSetBtn.innerHTML = desiredNewInner;
    }

    if (!cur) {
      if (el.submitBtn) {
        el.submitBtn.innerHTML = `
          <span style="font-size:1.3em; line-height:1;">⏎</span>
          <span>Submit Guess</span>`;
        el.submitBtn.style.display = "inline-flex";
        el.submitBtn.style.alignItems = "center";
        el.submitBtn.style.justifyContent = "center";
        el.submitBtn.style.gap = "0.4rem";
      }
      if (el.submitBtn) el.submitBtn.disabled = true;

      if (el.newSetBtn) el.newSetBtn.disabled = false;

      if (el.replaySetBtn) {
        el.replaySetBtn.disabled = true;
        el.replaySetBtn.innerHTML = `<span style="font-size:1.8em; line-height:1; display:inline-block; transform: translateY(-0.1em);">⟳</span><span>${replayChordLabel}</span>`;
        el.replaySetBtn.style.display = "inline-flex";
        el.replaySetBtn.style.alignItems = "center";
        el.replaySetBtn.style.justifyContent = "center";
        el.replaySetBtn.style.gap = "0.4rem";
      }

      if (el.guessInput) el.guessInput.disabled = true;
      return;
    }

    if (cur.answered) {
      if (el.submitBtn) {
        el.submitBtn.innerHTML = `
          <span style="font-size:1.8em; line-height:1; display:inline-block; transform: translateY(-0.1em);">⟳</span>
          <span>${replayGuessLabel}</span>`;
        el.submitBtn.style.display = "inline-flex";
        el.submitBtn.style.alignItems = "center";
        el.submitBtn.style.justifyContent = "center";
        el.submitBtn.style.gap = "0.4rem";
      }
      if (el.submitBtn) el.submitBtn.disabled = false;
      if (el.newSetBtn) el.newSetBtn.disabled = false;

      if (el.replaySetBtn) {
        el.replaySetBtn.disabled = false;
        el.replaySetBtn.innerHTML = `<span style="font-size:1.8em; line-height:1; display:inline-block; transform: translateY(-0.1em);">⟳</span><span>${replayChordLabel}</span>`;
        el.replaySetBtn.style.display = "inline-flex";
        el.replaySetBtn.style.alignItems = "center";
        el.replaySetBtn.style.justifyContent = "center";
        el.replaySetBtn.style.gap = "0.4rem";
      }

      if (el.guessInput) el.guessInput.disabled = true;
    } else {
      if (el.submitBtn) {
        el.submitBtn.innerHTML = `
          <span style="font-size:1.3em; line-height:1;">⏎</span>
          <span>Submit Guess</span>`;
        el.submitBtn.style.display = "inline-flex";
        el.submitBtn.style.alignItems = "center";
        el.submitBtn.style.justifyContent = "center";
        el.submitBtn.style.gap = "0.4rem";
      }
      if (el.submitBtn) el.submitBtn.disabled = false;
      if (el.newSetBtn) el.newSetBtn.disabled = true;

      if (el.replaySetBtn) {
        el.replaySetBtn.disabled = false;
        el.replaySetBtn.innerHTML = `<span style="font-size:1.8em; line-height:1; display:inline-block; transform: translateY(-0.1em);">⟳</span><span>${replayChordLabel}</span>`;
        el.replaySetBtn.style.display = "inline-flex";
        el.replaySetBtn.style.alignItems = "center";
        el.replaySetBtn.style.justifyContent = "center";
        el.replaySetBtn.style.gap = "0.4rem";
      }

      if (el.guessInput) el.guessInput.disabled = false;
    }

    if (el.deleteUserBtn) el.deleteUserBtn.disabled = (currentUser === "Guest");
    if (el.newUserBtn) el.newUserBtn.disabled = false;
  }

  if (el.replaySetBtn) {
    el.replaySetBtn.accessKey = 'c';
    el.replaySetBtn.setAttribute('aria-keyshortcuts', 'c');
  }
  if (el.submitBtn) {
    el.submitBtn.accessKey = 'g';
    el.submitBtn.setAttribute('aria-keyshortcuts', 'g');
  }

  window.addEventListener('keydown', e => {
    if (e.repeat) return;
    if (document.activeElement === el.guessInput) return;
    const k = (e.key || '').toLowerCase();

    if (k === 'c') {
      if (el.replaySetBtn && !el.replaySetBtn.disabled) { e.preventDefault(); handleReplay(); }
    } else if (k === 'g') {
      if (el.submitBtn && !el.submitBtn.disabled) { e.preventDefault(); handleSubmit(); }
    } else if (k === 'n') {
      if (el.newSetBtn && !el.newSetBtn.disabled) { e.preventDefault(); handleNewSet(); }
    }
  }, false);

  /* ---------- feedback ---------- */
  function updateFeedback(ok, truth, guess) {
    const WIN = trainer.settings.win;
    const AIM = trainer.settings.aim;

    const hist = trainer.log.filter(l => keyRel(l.rel) === keyRel(truth)).slice(-WIN);
    const correct = hist.filter(h => h.ok).length;

    let minAcc = 1;
    for (const rel of trainer.universe) {
      const k = keyRel(rel);
      const relHist = trainer.log.filter(l => keyRel(l.rel) === k).slice(-WIN);
      const c = relHist.filter(h => h.ok).length;
      const acc = c / WIN;
      if (acc < minAcc) minAcc = acc;
    }
    const minCorrect = Math.round(minAcc * WIN);

    const total = trainer.log.length;
    const overall = total ? Math.round(trainer.log.filter(l => l.ok).length / total * 100) : 0;

    let reached = 0;
    for (const rel of trainer.universe) {
      const k = keyRel(rel);
      const relHist = trainer.log.filter(l => keyRel(l.rel) === k).slice(-WIN);
      const c = relHist.filter(h => h.ok).length;
      const acc = c / WIN;
      if (acc >= AIM) reached++;
    }
    const universeSize = trainer.universe.length;

    function formatSet(arr) { return "(" + arr.join(", ") + ")"; }

    let msg = "";
    if (ok) {
      const animals = ["🦚","🐢","🦜","🐧","🐤","🦔","🦩","🦥","🦨"];
      const left  = animals[Math.floor(Math.random() * animals.length)];
      let right   = animals[Math.floor(Math.random() * animals.length)];
      if (right === left && animals.length > 1) {
        right = animals[(animals.indexOf(left) + 1) % animals.length];
      }

      msg = `
        <div style="text-align:center;">
          ${left} <span style="color:rgb(48, 134, 48)">${formatSet(truth)}</span> ${right}
        </div>`;
      if (el.replaySetBtn) el.replaySetBtn.classList.add("btn-green");
      if (el.submitBtn) el.submitBtn.classList.add("btn-green");
    } else {
      msg = `
        <div style="text-align:center;">
          🙉 <span style="color:rgb(160, 68, 50)">${formatSet(guess)}</span> 
          vs. 
          <span style="color:rgb(48, 134, 48)">${formatSet(truth)}</span> 🙊
        </div>`;
      if (el.replaySetBtn) el.replaySetBtn.classList.add("btn-green");
      if (el.submitBtn) el.submitBtn.classList.add("btn-red");
    }

    msg += `
    <div style="text-align:left; margin-top:0.5rem; margin-left:3.7rem; font-family:monospace;">
      Rolling accuracy: <strong>${String(correct).padStart(2, '\u00A0')}/${WIN}</strong><br>
      Minimum accuracy: <strong>${String(Math.round(minAcc * WIN)).padStart(2, '\u00A0')}/${WIN}</strong><br>
      Overall accuracy: <strong>${String(overall).padStart(4, '\u00A0')}%</strong><br>
      Sets at min. 80%: <strong>${String(reached).padStart(2, '\u00A0')}/${universeSize}</strong>
    </div>`;

    if (el.feedback) el.feedback.innerHTML = msg;
  }

  /* ---------- user handling ---------- */
  function switchUser(name, { skipSave = false } = {}) {
    if (synth && typeof synth.stopAll === 'function') {
      synth.stopAll();
    }
    if (!skipSave && currentUser !== "Guest") {
      Storage.save(currentUser, trainer.snapshotForSave());
    }

    currentUser = name;

    const data = Storage.load(currentUser);
    trainer.changeSettings(data.settings);
    trainer.log = data.log || [];
    trainer.current = null;

    if (el.feedback) el.feedback.innerHTML = "";
    renderSettingsUI(trainer.settings);
    trainer.changeSettings(readSettingsFromUI());
    refreshUserSelect();

    if (el.deleteUserBtn) {
      el.deleteUserBtn.disabled = (currentUser === "Guest");
    }

    updateButtons();
  }

  function refreshUserSelect() {
    if (!el.userSelect) return;
    el.userSelect.innerHTML = "";
    const guestOpt = document.createElement("option");
    guestOpt.value = "Guest";
    guestOpt.textContent = "Guest";
    el.userSelect.appendChild(guestOpt);

    Storage.listUsers().forEach(u => {
      const opt = document.createElement("option");
      opt.value = u;
      opt.textContent = u;
      el.userSelect.appendChild(opt);
    });

    if (![...el.userSelect.options].some(o => o.value === currentUser)) {
      currentUser = "Guest";
    }
    el.userSelect.value = currentUser;
  }

  if (el.userSelect) el.userSelect.onchange = e => switchUser(e.target.value);

  if (el.newUserBtn) {
    el.newUserBtn.onclick = () => {
      if (el.newUserBtn.disabled) return;
      const name = prompt("Enter Username:");
      if (!name) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      if (trimmed === "Guest") { alert("User name 'Guest' is reserved."); return; }
      if (Storage.listUsers().includes(trimmed)) { alert("User already exists."); return; }
      Storage.save(trimmed, { settings: { ...DEFAULTS }, log: [] });
      switchUser(trimmed);
    };
  }

  if (el.deleteUserBtn) {
    el.deleteUserBtn.onclick = () => {
      if (el.deleteUserBtn.disabled) return;
      if (currentUser === "Guest") return;
      if (!confirm(`Delete User '${currentUser}'?`)) return;
      const toDelete = currentUser;
      Storage.remove(toDelete);
      switchUser("Guest", { skipSave: true });
    };
  }

  /* ---------- handlers ---------- */
  function handleNewSet() {
    if (!el.newSetBtn || el.newSetBtn.disabled) return;
    trainer.nextTrial();
    updateButtons();
    if (el.feedback) el.feedback.innerHTML = "";
    if (el.replaySetBtn) el.replaySetBtn.classList.remove("btn-green", "btn-red");
    if (el.submitBtn) el.submitBtn.classList.remove("btn-green", "btn-red");
    focusAfterEnterReleased(el.guessInput);
  }

  function handleReplay() {
    if (!el.replaySetBtn || el.replaySetBtn.disabled) return;
    trainer.replay();
  }

  function handleSubmit() {
    if (!el.submitBtn || el.submitBtn.disabled) return;
    const cur = trainer.current;
    if (!cur) return;

    if (!cur.answered) {
      const res = trainer.submitGuess(el.guessInput ? el.guessInput.value : "");
      if (!res) return;
      updateFeedback(res.ok, res.truth, res.guess);
      if (el.guessInput) { el.guessInput.value = ""; el.guessInput.disabled = true; }
      if (el.newSetBtn) el.newSetBtn.disabled = false;
      updateButtons();
      focusAfterEnterReleased(el.newSetBtn);
      Storage.save(currentUser, trainer.snapshotForSave());
    } else {
      const last = trainer.log[trainer.log.length - 1];
      if (last) trainer.playGuess(last.guess);
    }
  }

  if (el.newSetBtn) el.newSetBtn.onclick = handleNewSet;
  if (el.replaySetBtn) el.replaySetBtn.onclick = handleReplay;
  if (el.submitBtn) el.submitBtn.onclick = handleSubmit;

  // === Enter behavior: submit when input has content, replay chord when empty ===
  if (el.guessInput) {
    el.guessInput.addEventListener("keydown", e => {
      if (e.repeat) return;
      const val = (el.guessInput.value || "").trim();

      if (e.key === " " || e.key === "Spacebar" || e.code === "Space") {
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (val.length === 0) {
          e.preventDefault();
          if (el.replaySetBtn && !el.replaySetBtn.disabled) handleReplay();
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        const v = (el.guessInput.value || "").trim();
        if (v.length === 0) {
          if (el.replaySetBtn && !el.replaySetBtn.disabled) {
            handleReplay();
          }
        } else {
          if (el.submitBtn && !el.submitBtn.disabled) {
            handleSubmit();
          }
        }
      }
    });
  }

  // === Enter-safe focus helper ===
  const keysDown = new Set();
  window.addEventListener("keydown", e => keysDown.add(e.key), true);
  window.addEventListener("keyup",   e => keysDown.delete(e.key), true);

  function focusAfterEnterReleased(elem) {
    if (!elem) return;
    if (keysDown.has("Enter")) {
      const onUp = (e) => {
        if (e.key === "Enter") {
          window.removeEventListener("keyup", onUp, true);
          setTimeout(() => elem.focus(), 0);
        }
      };
      window.addEventListener("keyup", onUp, true);
    } else {
      elem.focus();
    }
  }

  /* ---------- startup ---------- */
  currentUser = Storage.lastUser();
  if (currentUser !== "Guest" && !Storage.listUsers().includes(currentUser)) {
    currentUser = "Guest";
  }

  const data = Storage.load(currentUser);
  trainer.changeSettings(data.settings);
  trainer.log = data.log || [];

  renderSettingsUI(trainer.settings);
  trainer.changeSettings(readSettingsFromUI());

  refreshUserSelect();
  updateButtons();

  refreshUserSelect();
  if (currentUser === "Guest") {
    el.deleteUserBtn.disabled = true;
  }
  updateButtons();

  window.addEventListener("beforeunload", () => {
    try { Storage.save(currentUser, trainer.snapshotForSave()); } catch {}
  });
})();
