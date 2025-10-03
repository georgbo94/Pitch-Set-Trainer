
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
  arpNoteDur: 0.18, // seconds per arpeggio note
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

/* -------------------------
   Synth (final version)
------------------------- */
class Synth {
  constructor() {
    // Reuse one global AudioContext across all Synths
    if (!Synth.sharedCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      Synth.sharedCtx = new Ctor();
    }
    this.ctx = Synth.sharedCtx;

    // Track currently playing nodes (single voice)
    this.currentNodes = [];

// Replace your "Only install unlock once" block with this:
if (!Synth._unlockInstalled) {
  const tryResume = () => {
    // iOS may use "suspended" or "interrupted"
    if (this.ctx && this.ctx.state !== "running") {
      this.ctx.resume().catch(() => {});
    }
  };
  // Keep these listeners forever; they're cheap and idempotent
  window.addEventListener("pointerdown", tryResume, { passive: true });
  window.addEventListener("keydown", tryResume);
  document.addEventListener("visibilitychange", tryResume);
  // Optional: observe state changes (for debugging)
  if (this.ctx && this.ctx.addEventListener) {
    this.ctx.addEventListener("statechange", tryResume);
  }
  Synth._unlockInstalled = true;
}
  }

  playArpeggio(midis, noteDur = DEFAULTS.arpNoteDur) {
    if (!midis.length) return;

    // stop anything currently sounding
    this.currentNodes.forEach(n => { try { n.stop(); } catch {} });
    this.currentNodes = [];

    const now = this.ctx.currentTime;
    const masterGain = this.ctx.createGain();
    masterGain.connect(this.ctx.destination);

    // schedule notes back-to-back; no overlap
    midis.forEach((midi, idx) => {
      const start = now + noteDur * idx;
      const end   = start + noteDur;
      const f0    = midiToHz(midi);

      // compact ADSR that fits entirely inside [start, end]
      const A = Math.min(0.02, noteDur * 0.25);
      const D = Math.min(0.08, noteDur * 0.25);
      const S = 0.75;
      const R = Math.min(0.06, noteDur * 0.25);

      for (let h = 1; h <= 11; h++) {
        const osc = this.ctx.createOscillator();
        const g   = this.ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = f0 * h;

        // envelope fits strictly within [start, end]
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(1 / h, start + A);
        g.gain.linearRampToValueAtTime(S / h, start + A + D);
        g.gain.setValueAtTime(S / h, Math.max(start + A + D, end - R));
        g.gain.linearRampToValueAtTime(0, end);

        osc.connect(g).connect(masterGain);
        osc.start(start);
        osc.stop(end);

        this.currentNodes.push(osc);
      }
    });
  }
   
  playChord(midis, dur = DEFAULTS.duration) {
    if (!midis.length) return;

    // Kill any currently playing nodes
    this.currentNodes.forEach(node => {
      try { node.stop(); } catch {}
    });
    this.currentNodes = [];

    const now = this.ctx.currentTime;
    const masterGain = this.ctx.createGain();
    masterGain.connect(this.ctx.destination);

    // ADSR envelope
    const A = 0.02, D = 0.15, S = 0.75, R = 0.12;
    masterGain.gain.setValueAtTime(0, now);
    masterGain.gain.linearRampToValueAtTime(1, now + A);
    masterGain.gain.linearRampToValueAtTime(S, now + A + D);
    masterGain.gain.setValueAtTime(S, now + dur - R);
    masterGain.gain.linearRampToValueAtTime(0, now + dur);

    midis.forEach(midi => {
      const f0 = midiToHz(midi);
      for (let h = 1; h <= 11; h++) {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = f0 * h;
        g.gain.value = 1 / (h**1.2);
        osc.connect(g).connect(masterGain);
        osc.start(now);
        osc.stop(now + dur);

        // track nodes so we can kill them on next chord
        this.currentNodes.push(osc);
      }
    });
  }

  stopAll() {
    try {
      if (this.currentNodes && this.currentNodes.length) {
        this.currentNodes.forEach(n => {
          try { n.stop(); } catch (e) { /* ignore already-stopped errors */ }
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
    // RNG: allow optional seeded RNG via initialSettings.rng, otherwise Math.random
    this.rng = (initialSettings && typeof initialSettings.rng === 'function')
      ? initialSettings.rng
      : Math.random;

    // caches for fast sampling & incremental stats
    this._cacheKeys = null;         // array of keyRel(rel)
    this._cacheKeyToIndex = null;   // Map keyRel -> universe index
    this._statsByIndex = null;      // array parallel to universe: { buffer: [], correct: number }

    // reached-count bookkeeping (exact if N <= sampleLimit, otherwise approx)
    this._reachedCount = 0;
    this._reachedIsApprox = false;
    this._sampleLimit = 150000;    // universe size threshold to switch to approximate counting
    this._sampleK = 2000;          // number of samples for approximation
    this._approxRefreshEvery = 500; // refresh approx estimate every N submits
    this._submitCounter = 0;

    // build caches and fill buffers from existing log
    this._rebuildUniverseAndMigrate();
  }

  /* -------------------------
     Cache & migration helpers
     ------------------------- */
  _buildCacheIfNeeded() {
    if (this._cacheKeys && this._cacheKeyToIndex && this._statsByIndex) return;
    this._rebuildUniverseAndMigrate();
  }

  // Rebuild universe caches and migrate existing stats where possible.
  // Fills per-rel buffers from this.log (backwards) up to WIN entries each.
  _rebuildUniverseAndMigrate() {
    // Recompute universe (call this when settings change)
    this.universe = generateUniverse(this.settings);

    const newKeys = this.universe.map(rel => keyRel(rel));
    const newKeyToIndex = new Map(newKeys.map((k, i) => [k, i]));

    const N = newKeys.length;
    const WIN = this.settings.win || 10;

    // new empty stats
    const newStats = Array.from({ length: N }, () => ({ buffer: [], correct: 0 }));

    // migrate buffers for keys that persist
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

    // fill missing buffers from log by backward scan (most recent first)
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
          // unshift because we walk backwards; result is oldest-first
          s.buffer.unshift(entry.ok ? 1 : 0);
          if (s.buffer.length > WIN) s.buffer.shift();
          s.correct = s.buffer.reduce((a, b) => a + b, 0);
          if (s.buffer.length >= WIN) remaining.delete(idx);
        }
      }
    }

    // finalize caches
    this._cacheKeys = newKeys;
    this._cacheKeyToIndex = newKeyToIndex;
    this._statsByIndex = newStats;

    // compute reachedCount (exact or approximate)
    const rng = (this.rng && typeof this.rng === 'function') ? this.rng : Math.random;
    const AIM = (typeof this.settings.aim === 'number') ? this.settings.aim : 0.8;

    if (N <= this._sampleLimit) {
      // exact
      let rc = 0;
      for (let i = 0; i < N; i++) {
        const s = this._statsByIndex[i] || { correct: 0 };
        const acc = (s.correct || 0) / WIN; // ALWAYS divide by WIN
        if (acc >= AIM) rc++;
      }
      this._reachedCount = rc;
      this._reachedIsApprox = false;
    } else {
      // approximate by sampling K indices
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

    // drop current if its rel no longer exists
    if (this.current && this.current.rel) {
      const curKey = keyRel(this.current.rel);
      if (!this._cacheKeyToIndex.has(curKey)) this.current = null;
    }
  }

  /* -------------------------
     Sampling: _randomPick()
     ------------------------- */
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

    // compute raw weights per your semantics (acc = correct / WIN always)
    const rawWeights = new Array(N);
    let totalRaw = 0;
    for (let i = 0; i < N; i++) {
      const s = stats[i] || { correct: 0 };
      const acc = (s.correct || 0) / WIN;
      const w = Math.max(0, AIM - acc);
      const jitter = rng() * 1e-12; // tiny jitter to break exact ties
      const wj = w + jitter;
      rawWeights[i] = wj;
      totalRaw += wj;
    }

    // with probability MIX_RATIO use weighted sampling (roulette), else uniform
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

    // uniform fallback
    return UNIVERSE[Math.floor(rng() * N)];
  }

  /* -------------------------
     Public API
     ------------------------- */
  changeSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };

    // rebuild universe & migrate buffers
    this._rebuildUniverseAndMigrate();

    // preserve previous behavior: clear current when it was answered
    if (this.current && this.current.answered) this.current = null;
  }

  // load a snapshot containing {settings, log}
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

    this.current = { rel, root, midis, answered: false 
   this._replayChordCount = 0;  // reset per question
    this._replayGuessCount = 0;  // reset per question       
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

  // submit guess: parse, record in log, update per-rel buffer & reachedCount incrementally
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

    // incremental buffer update + reached-count adjustment
    this._buildCacheIfNeeded();
    const k = keyRel(truth);
    const idx = this._cacheKeyToIndex.get(k);
    const WIN = this.settings.win || 10;
    const AIM = (typeof this.settings.aim === 'number') ? this.settings.aim : 0.8;
    const rng = (this.rng && typeof this.rng === 'function') ? this.rng : Math.random;

    if (idx !== undefined) {
      const s = this._statsByIndex[idx] || { buffer: [], correct: 0 };
      s.buffer = s.buffer || [];

      // compute oldAcc BEFORE we mutate the buffer (we always divide by WIN)
      const oldCorrect = s.correct || 0;
      const oldAcc = oldCorrect / WIN;

      // push new result (oldest-first buffer)
      s.buffer.push(ok ? 1 : 0);
      if (s.buffer.length > WIN) s.buffer.shift();

      // recompute correct/newAcc
      s.correct = s.buffer.reduce((a, b) => a + b, 0);
      const newAcc = s.correct / WIN;

      // put back
      this._statsByIndex[idx] = s;

      // update reachedCount O(1) when in exact mode
      if (!this._reachedIsApprox) {
        if (oldAcc < AIM && newAcc >= AIM) this._reachedCount++;
        else if (oldAcc >= AIM && newAcc < AIM) this._reachedCount--;
        // clamp
        if (this._reachedCount < 0) this._reachedCount = 0;
        if (this._cacheKeys && this._reachedCount > this._cacheKeys.length) this._reachedCount = this._cacheKeys.length;
      } else {
        // optional small nudge in approx mode (keeps estimate somewhat current)
        if (oldAcc < AIM && newAcc >= AIM) this._reachedCount++;
        else if (oldAcc >= AIM && newAcc < AIM) this._reachedCount = Math.max(0, this._reachedCount - 1);
      }
    }

    // approximate-mode periodic refresh (optional)
    this._submitCounter = (this._submitCounter || 0) + 1;
    if (this._reachedIsApprox && (this._submitCounter % this._approxRefreshEvery === 0)) {
      // recompute approximate estimate by sampling
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
  // inject CSS safety-net so disabled buttons cannot be clicked regardless of page CSS
  (function injectDisabledSafetyCSS() {
    try {
      const css = "button:disabled{pointer-events:none!important;} select:disabled{pointer-events:none!important;}"; 
      const s = document.createElement("style");
      s.setAttribute("data-pitchsettrainer-safety","true");
      s.appendChild(document.createTextNode(css));
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      // if injection fails, we'll still rely on JS guards
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
      // allow only digits, dot, comma, space
      let v = el.guessInput.value.replace(/[^0-9., ]/g, "");
  
      // normalize separators into single spaces
      v = v.replace(/\./g, " ");     // dot -> space
      v = v.replace(/,\s*/g, " ");   // comma -> space (drop any following spaces)
      v = v.replace(/\s+/g, " ");    // collapse multiple spaces
  
      // remove any leading separators (so input never starts with space/comma/dot)
      v = v.replace(/^[\s,\.]+/, "");
  
      el.guessInput.value = v;
    });
  }
el.guessInput.addEventListener("keydown", e => {
  if (e.repeat) return;
  if (!e.key || e.key.length !== 1) return;           // ignore non-printable keys
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
    const valNum = Math.min(1, i / 10);      // 0.0, 0.1, ..., 1.0
    const val = valNum.toFixed(1);           // "0.0", "0.1", ...
    const opt = document.createElement("option");
    opt.value = val;                         // keep the actual numeric value as the option value
    opt.textContent = `${Math.round(valNum * 100)}%`; // visible label in 10% steps
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

// -------------- replace/update updateButtons with this version --------------
function updateButtons() {
  const cur = trainer.current;

  // Helper label fragments (underline the important key)
  // detect keyboard-capable devices and only insert <u> on those
  const supportsKeyboard = window.matchMedia('(any-hover: hover) and (any-pointer: fine)').matches;
  const replayChordLabel = supportsKeyboard
    ? `Replay <u class="accesskey-u">C</u>hord`
    : 'Replay Chord';
  const replayGuessLabel = supportsKeyboard
    ? `Replay <u class="accesskey-u">G</u>uess`
    : 'Replay Guess';


  // keep original simple label format; only add underlined N on keyboard devices.
  const desiredNewInner = supportsKeyboard ? '▶ <u class="accesskey-u">N</u>ew Chord' : '▶ New Chord';

  // only touch the DOM if the label actually differs (avoid churn)
  if (el.newSetBtn && el.newSetBtn.innerHTML.trim() !== desiredNewInner) {
    el.newSetBtn.innerHTML = desiredNewInner;
  }

  const submitLabel = `
    <span style="font-size:1.3em; line-height:1;">⏎</span>
    <span>Submit Guess</span>`;

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
      // keep consistent styling and label even when disabled
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
    // Submit state
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

// -------------- add keyboard shortcuts (c = replay chord, g = replay guess) --------------
/* Put this somewhere after updateButtons() and after el.* elements exist */
if (el.replaySetBtn) {
  el.replaySetBtn.accessKey = 'c';
  el.replaySetBtn.setAttribute('aria-keyshortcuts', 'c');
}
if (el.submitBtn) {
  // We use 'g' for replay-guess; note submitBtn doubles as replay guess when appropriate
  el.submitBtn.accessKey = 'g';
  el.submitBtn.setAttribute('aria-keyshortcuts', 'g');
}

// global key handler for C / G; don't trigger when typing in the guess input
window.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (document.activeElement === el.guessInput) return; // don't interfere while typing
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
  
    // rolling accuracy for this rel
    const hist = trainer.log.filter(l => keyRel(l.rel) === keyRel(truth)).slice(-WIN);
    const correct = hist.filter(h => h.ok).length;
  
    // minimum accuracy across all rels
    let minAcc = 1;
    for (const rel of trainer.universe) {
      const k = keyRel(rel);
      const relHist = trainer.log.filter(l => keyRel(l.rel) === k).slice(-WIN);
      const c = relHist.filter(h => h.ok).length;
      const acc = c / WIN;
      if (acc < minAcc) minAcc = acc;
    }
    const minCorrect = Math.round(minAcc * WIN);
  
    // overall accuracy
    const total = trainer.log.length;
    const overall = total ? Math.round(trainer.log.filter(l => l.ok).length / total * 100) : 0;
  
    // count how many rels reached AIM (acc >= AIM) out of universe size
    let reached = 0;
    for (const rel of trainer.universe) {
      const k = keyRel(rel);
      const relHist = trainer.log.filter(l => keyRel(l.rel) === k).slice(-WIN);
      const c = relHist.filter(h => h.ok).length;
      const acc = c / WIN; // IMPORTANT: divide by WIN always (your semantics)
      if (acc >= AIM) reached++;
    }
    const universeSize = trainer.universe.length;
  
    // formatted strings (monospace padding with spaces, not zeros)
    const rolling       = `${correct.toString().padStart(2," ")}/${WIN}`;
    const minDisplay    = `${minCorrect.toString().padStart(2," ")}/${WIN}`;
    const overallDisplay = `${overall.toString().padStart(3," ")}%`;
  
    function formatSet(arr) { return "(" + arr.join(", ") + ")"; }
  
    let msg = "";
    if (ok) {
      msg = `
        <div style="text-align:center;">
          🐢🐢 <span style="color:rgb(48, 134, 48)">${formatSet(truth)}</span>
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
    // Save old user
    if (synth && typeof synth.stopAll === 'function') {
      synth.stopAll();
    }
    if (!skipSave && currentUser !== "Guest") {
      Storage.save(currentUser, trainer.snapshotForSave());
    }
  
    // Update global
    currentUser = name;
  
    // Load user data
    const data = Storage.load(currentUser);
    trainer.changeSettings(data.settings);
    trainer.log = data.log || [];
    trainer.current = null;
  
    // Reset UI
    if (el.feedback) el.feedback.innerHTML = "";
    renderSettingsUI(trainer.settings);
    trainer.changeSettings(readSettingsFromUI());
    refreshUserSelect();
  
    // 🔒 Force delete button state right here
    if (el.deleteUserBtn) {
      el.deleteUserBtn.disabled = (currentUser === "Guest");
    }
  
    updateButtons(); // still safe to call
  

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
    focusAfterEnterReleased(el.guessInput);  }

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
    // ignore auto-repeat to avoid machine-gunning when holding Enter
    if (e.repeat) return;

    if (e.repeat) return; // avoid auto-repeat

    const val = (el.guessInput.value || "").trim();
    
    // handle Space: when input empty -> act like 'c' (replay), otherwise allow space insertion
    if (e.key === " " || e.key === "Spacebar" || e.code === "Space") {
      if (e.ctrlKey || e.altKey || e.metaKey) return; // don't intercept modifier combos
      if (val.length === 0) {
        e.preventDefault(); // prevent a leading space from being inserted (no flicker)
        if (el.replaySetBtn && !el.replaySetBtn.disabled) handleReplay();
      }
      return; // done handling Space
    }

    if (e.key === "Enter") {
      e.preventDefault(); // prevent form submission

      const val = (el.guessInput.value || "").trim();
      if (val.length === 0) {
        // act like 'c' — replay the chord if available
        if (el.replaySetBtn && !el.replaySetBtn.disabled) {
          handleReplay();
        }
      } else {
        // submit as before
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
        setTimeout(() => elem.focus(), 0); // defer until after release
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




