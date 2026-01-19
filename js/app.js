
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

const midiToHz = m => 440 * Math.pow(2, (m - 69) / 12);
const midiToNote = m => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);

const MIDI_ABS_LOW  = 20;
const MIDI_ABS_HIGH = 100;


const TONALITY_MODES = {
  "root": {
    tonicChord: [0],
    allowedPCs: new Set([0,1,2,3,4,5,6,7,8,9,10,11])
  },

  "M. dia.": {
    tonicChord: [0,4,7,12],
    allowedPCs: new Set([0,2,4,5,7,9,11])   // major diatonic
  },

  "m. dia.": {
    tonicChord: [0,3,7,12],
    allowedPCs: new Set([0,2,3,5,7,8,10])   // natural minor
  },

  "M. chr.": {
    tonicChord: [0,4,7,12],
    allowedPCs: new Set([0,1,2,3,4,5,6,7,8,9,10,11])  // chromatic
  },

  "m. chr.": {
    tonicChord: [0,3,7,12],
    allowedPCs: new Set([0,1,2,3,4,5,6,7,8,9,10,11])  // chromatic
  }
};

const ENGINE = {
  duration: 2.5,
  durationkey: 1.5,
  aim: 0.8,
  win: 10,

  tonicLeadTime: 0.45,
  arpEvery: 3,
  arpNoteDur: 0.6,
  hExp: 1.8,
  ampNoise: 0.3,
};


/* -------------------------
   Default Settings
------------------------- */

const DEFAULTS = {
  keySelect: "atonal",        
  tonalitySelect: "root",       

  tonality: "atonal",         
  keyPC: null,              

  midiLow: 48,
  midiHigh: 72,

  card: [3, 3],
  span: [0, 12],

  mixRatio: 0.8,

};

/* -------------------------
   Storage Keys
------------------------- */

const STORAGE = {
  CURRENT_USER: "pitchsettrainer_current_user",
  USER_PREFIX: "pitchsettrainer_user_",
  LAST_NON_GUEST_SETTINGS: "pitchsettrainer_last_non_guest_settings"
};

/* -------------------------
   Storage Implementation
------------------------- */

const Storage = {

  listUsers() {
    const result = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STORAGE.USER_PREFIX)) {
        result.push(k.slice(STORAGE.USER_PREFIX.length));
      }
    }
    return result.sort();
  },

save(user, data) {
  if (user === "Guest") return;

  localStorage.setItem(
    STORAGE.USER_PREFIX + user,
    JSON.stringify({
      settings: data.settings,
      logs: data.logs,
      section: data.section ?? "synth"    })
  );

    localStorage.setItem(STORAGE.CURRENT_USER, user);

    if (data.settings) {
      localStorage.setItem(
        STORAGE.LAST_NON_GUEST_SETTINGS,
        JSON.stringify(data.settings)
      );
    }
  },

  load(user) {
    if (user === "Guest") {
      const raw = localStorage.getItem(STORAGE.LAST_NON_GUEST_SETTINGS);
      const settings = raw
        ? { ...DEFAULTS, ...JSON.parse(raw) }
        : { ...DEFAULTS };
      return { settings, logs: {} };
    }

    const raw = localStorage.getItem(STORAGE.USER_PREFIX + user);
    if (!raw) return { settings: { ...DEFAULTS }, logs: {} };

    try {
      const parsed = JSON.parse(raw);
      const settings = { ...DEFAULTS, ...(parsed.settings || {}) };
      const section = parsed.section || "synth";

      
      // MIGRATION logic 
      let logs = parsed.logs;
      if (!logs) {
        logs = {};
        if (Array.isArray(parsed.log)) {
          logs.ATONAL = parsed.log.slice();
        } else {
          logs.ATONAL = [];
        }
      }

      return { settings, logs, section };
    } catch {
      return { settings: { ...DEFAULTS }, logs: { ATONAL: [] } };
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
   Request Persistence
------------------------- */

(async () => {
  if (navigator.storage && navigator.storage.persist) {
    try {
      const granted = await navigator.storage.persist();
      console.log("Persistence granted?", granted);
    } catch (err) {
      console.warn("Persistence request failed:", err);
    }
  }
})();

/* ============================================================
   PART 2 — SYNTH
   ============================================================ */

let activeSynth = null;

/* ============================================================
   SOUND-FONT SAMPLER 
   ============================================================ */

const SHARED_AUDIO_CTX = new (window.AudioContext || window.webkitAudioContext)();





class SFSampler {
  constructor() {
    this.ctx = SHARED_AUDIO_CTX;
    this.instr = null;
    this.active = [];
  }

  async load(name, gain = 1.0) {
  this.instr = await Soundfont.instrument(this.ctx, name, {
    gain,
    format: "mp3",
    soundfont: "MusyngKite"
});  }

  stopAll() {
    for (const v of this.active) {
      try { if (v && v.stop) v.stop(0); } catch {}
    }
    this.active = [];
  }

playChord(midis, dur = 1.2, gains = null) {
  if (!this.instr) return;

  this.stopAll();
  const t = this.ctx.currentTime;

  midis.forEach((m, i) => {
    const gain = gains ? gains[i] : 1.0;
    const opt = { duration: dur, gain };

    const node = this.instr.play(midiToNote(m), t, opt);
    this.active.push(node);
  });
}


playArpeggio(midis, noteDur = 0.35, gains = null) {
  if (!this.instr) return;

  this.stopAll();
  this.active = [];

  const t0 = this.ctx.currentTime;

  console.log("---- ARPEGGIO START ----");
  console.log("MIDIS in this bucket:", midis);
  console.log("noteDur:", noteDur);
  console.log("t0:", t0);
  console.log("Expected schedule times:", midis.map((_, i) => t0 + i * noteDur));

  midis.forEach((m, i) => {
    const gain = gains ? gains[i] : 1.0;
    const opt  = { duration: noteDur, gain };

    const startTime = t0 + i * noteDur;

    console.log(`Note ${midiToNote(m)} scheduled at`, startTime);

    const node = this.instr.play(
      midiToNote(m),
      startTime,
      opt
    );

    this.active.push(node);
  });

  console.log("---- ARPEGGIO END ----");
}




}

let activeSection = null;


const SECTION_INSTRUMENTS = {

  brass: {
    low:  { name:"trombone",  low:34, high:70,  gain:1.4  },
    mid:  { name:"trombone", low:40, high:78,  gain:1.4 },
    high: { name:"trumpet",        low:55, high:96,  gain:1.4  }
  },

  sax: {
    low:  { name:"baritone_sax", low:38, high:65 ,  gain:0.9 },
    mid:  { name:"tenor_sax",    low:44, high:74 ,  gain:0.9 },
    high: { name:"alto_sax",     low:52, high:86 ,  gain:0.9 }
  },

  clarinets: {
    low:  { name:"clarinet", low:38, high:72 ,  gain:1.1 },
    mid:  { name:"clarinet", low:50, high:88 ,  gain:1.1 },
    high: { name:"clarinet", low:60, high:98 ,  gain:1.1 }
  },

  strings: {
    low:  { name:"cello",  low:36, high:64 ,  gain: 1.1 },
    mid:  { name:"viola",  low:55, high:79 ,  gain:1.1 },
    high: { name:"violin", low:55, high:103 ,  gain:1.1 }
  }
};

/* ============================================================
   VOICE DISTRIBUTION RULES (PER SECTION)
   ============================================================ */

const SECTION_DISTRIBUTIONS = {

  brass: {
    1: ["auto"],
    2: ["low","high"],
    3: ["low","mid","high"],
    4: ["low","low","mid","high"],
    5: ["low","low","mid","high","high"]
  },

  sax: {
    1: ["auto"],
    2: ["low","high"],
    3: ["low","mid","high"],
    4: ["low","low","mid","high"],
    5: ["low","low","mid","high","high"]
  },

  clarinets: {
    1: ["auto"],
    2: ["low","high"],
    3: ["low","mid","high"],
    4: ["low","low","mid","high"],
    5: ["low","low","mid","high","high"]
  },

  strings: {
    1: ["auto"],
    2: ["low","high"],
    3: ["low","mid","high"],
    4: ["low","low","mid","high"],
    5: ["low","low","mid","high","high"]
  }
};


const Sections = {};

for (const secName in SECTION_INSTRUMENTS) {
  Sections[secName] = {
    low:  new SFSampler(),
    mid:  new SFSampler(),
    high: new SFSampler()
  };
}


async function loadSection(name) {
  const sec = Sections[name];
  if (!sec) return;

  const def = SECTION_INSTRUMENTS[name];

  await sec.low.load(def.low.name);
  await sec.mid.load(def.mid.name);
  await sec.high.load(def.high.name);

  activeSection = sec;
}

function stopActiveSection() {
  if (!activeSection) return;
  activeSection.low.stopAll();
  activeSection.mid.stopAll();
  activeSection.high.stopAll();
}


function routeBuckets(midis, sectionName) {
  const defs = SECTION_INSTRUMENTS[sectionName];
  const plan = SECTION_DISTRIBUTIONS[sectionName][midis.length];
  if (!plan) return null;

  const buckets = ["low", "mid", "high"];
  const out = { low: [], mid: [], high: [] };

  for (let i = 0; i < midis.length; i++) {
    const note = midis[i];
    let b = plan[i];

    if (b === "auto") {
      let best = "low", bestDist = Infinity;
      for (const bb of buckets) {
        const c = (defs[bb].low + defs[bb].high) / 2;
        const d = Math.abs(note - c);
        if (d < bestDist) { bestDist = d; best = bb; }
      }
      b = best;
    }

    if (note >= defs[b].low && note <= defs[b].high) {
      out[b].push(note);
      continue;
    }

    const dir = (note > defs[b].high) ? 1 : -1;
    let idx = buckets.indexOf(b);

    while (true) {
      const nxt = idx + dir;
      if (nxt < 0 || nxt >= buckets.length) {
        out[buckets[idx]].push(note);
        break;
      }
      const cand = buckets[nxt];
      if (note >= defs[cand].low && note <= defs[cand].high) {
        out[cand].push(note);
        break;
      }
      idx = nxt;
    }
  }

  return out;
}

function playSection(midis, {
  mode = "chord",
  dur = ENGINE.duration,
  noteDur = ENGINE.arpNoteDur,
  gains = null
} = {}) {
  if (!activeSection) return;

  if (mode === "arp") {
    playSectionArp(midis, noteDur, gains);
  } else {
    playSectionChord(midis, dur, gains);
  }
}


function playEngineChord(midis, dur, gains = null) {
  if (activeSynth) {
    activeSynth.stopAll();
    activeSynth.playChord(midis, dur, gains);
  } else {
    stopActiveSection();
    playSection(midis, { mode: "chord", dur, gains });
  }
}

function playEngineArp(midis, noteDur, gains = null) {
  if (activeSynth) {
    activeSynth.stopAll();
    activeSynth.playArpeggio(midis, noteDur, gains);
  } else {
    stopActiveSection();
    playSection(midis, { mode: "arp", noteDur, gains });
  }
}


function playSectionArp(midis, noteDur, gains) {
  const sectionName = document.getElementById("sectionSelect").value;
  const defs = SECTION_INSTRUMENTS[sectionName];
  const buckets = routeBuckets(midis, sectionName);

  stopActiveSection();

  // Build global ordered list
  const global = [];
  for (const b of ["low","mid","high"]) {
    const bucket = buckets[b];
    for (const m of bucket) {
      global.push({
        midi: m,
        bucket: b,
        gain: (gains ? (gains[midis.indexOf(m)] || 1) : 1) * defs[b].gain
      });
    }
  }

  // Sort globally by pitch — real arpeggio order
  global.sort((a, b) => a.midi - b.midi);

  const t0 = SHARED_AUDIO_CTX.currentTime;

  // NO HELPER FUNCTION — schedule directly here
  global.forEach((o, i) => {
    const node = activeSection[o.bucket].instr.play(
      midiToNote(o.midi),
      t0 + i * noteDur,
      { duration: noteDur, gain: o.gain }
    );
    activeSection[o.bucket].active.push(node);
  });
}


function playSectionChord(midis, dur, gains) {
  const sectionName = document.getElementById("sectionSelect").value;
  const defs = SECTION_INSTRUMENTS[sectionName];
  const buckets = routeBuckets(midis, sectionName);

  stopActiveSection();

  for (const b of ["low","mid","high"]) {
    const notes = buckets[b];
    if (!notes.length) continue;

    const g = gains
      ? notes.map(n => (gains[midis.indexOf(n)] || 1) * defs[b].gain)
      : null;

    activeSection[b].playChord(notes, dur, g);
  }
}






class Synth {
  constructor() {
    this.ctx = null;
    this.currentNodes = [];

    // Install unlock handlers only once
    if (!Synth._unlockInstalled) {
      const tryResume = () => {
        const ctx = this._ctxOrCreate();
        if (ctx && ctx.state !== "running") {
          ctx.resume().catch(() => {});
        }
      };
      window.addEventListener("pointerdown", tryResume, { passive: true });
      window.addEventListener("keydown", tryResume);
      document.addEventListener("visibilitychange", tryResume);
      Synth._unlockInstalled = true;
    }

    // Visibility cleanup
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        try {
          const ctx = this._ctxOrCreate();
          if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
          this.stopAll();
        } catch (e) {
          console.warn("[audio] resume on visible failed", e);
        }
      }
    });
  }

  /* ------------------------------------------
     Get or create shared AudioContext
  ------------------------------------------ */
  _ctxOrCreate() {
    if (this.ctx) return this.ctx;

    if (!Synth.sharedCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;

      // iOS prefers 48k for BT headphones, keep identical behavior
      const isIOS =
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

      const ctx = new AC(
        isIOS
          ? { sampleRate: 48000, latencyHint: "interactive" }
          : { latencyHint: "interactive" }
      );
      Synth.sharedCtx = ctx;

      // Build pipeline: source → pre → limiter → destination
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

  /* ------------------------------------------
     Harmonic amplitude sum
  ------------------------------------------ */
  _harmonicSum(n) {
    let s = 0;
    for (let h = 1; h <= n; h++) s += 1 / Math.pow(h, ENGINE.hExp);
    return s;
  }

  /* ------------------------------------------
     Play an arpeggio (identical envelopes)
     NOW supports per-note gains[]
  ------------------------------------------ */
  playArpeggio(midis, noteDur = ENGINE.arpNoteDur, gains = null) {
    if (!midis.length) return;

    // Kill any existing nodes
    this.currentNodes.forEach(n => { try { n.stop(); } catch {} });
    this.currentNodes = [];

    const ctx = this._ctxOrCreate();
    const now = ctx.currentTime;

    const H = 11;
    const harmonicSum = this._harmonicSum(H);

    // same peak logic as original
    const TARGET_PEAK = 0.65;
    const peakScale = Math.min(0.35, TARGET_PEAK / harmonicSum);

    const arpGain = ctx.createGain();
    arpGain.gain.value = peakScale;
    arpGain.connect(Synth.sharedPreMaster);

    midis.forEach((midi, idx) => {
      const start = now + idx * noteDur;
      const end   = start + noteDur;
      const f0    = midiToHz(midi);

      // per-note gain (defaults to 1)
      const noteGain = gains ? (gains[idx] ?? 1) : 1;

      // ADSR scaled to noteDur
      const A = Math.min(0.02, noteDur * 0.25);
      const D = Math.min(0.08, noteDur * 0.25);
      const S = 0.75;
      const R = Math.min(0.06, noteDur * 0.25);

      for (let h = 1; h <= H; h++) {
        const osc = ctx.createOscillator();
        const g   = ctx.createGain();
        const amp = 1 / Math.pow(h, ENGINE.hExp);

        osc.type = "sine";
        osc.frequency.value = f0 * h;

        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(amp * noteGain, start + A);
        g.gain.linearRampToValueAtTime(S * amp * noteGain, start + A + D);
        g.gain.setValueAtTime(
          S * amp * noteGain,
          Math.max(start + A + D, end - R)
        );
        g.gain.linearRampToValueAtTime(0, end);

        osc.connect(g).connect(arpGain);
        osc.start(start);
        osc.stop(end);

        this.currentNodes.push(osc);
      }
    });

    // Cleanup
    setTimeout(() => {
      try { arpGain.disconnect(); } catch {}
    }, (noteDur * (midis.length + 1) + 0.5) * 1000);
  }

  /* ------------------------------------------
     Play chord (identical to original)
     NOW supports per-note gains[]
  ------------------------------------------ */
  playChord(midis, dur = ENGINE.duration, gains = null) {
    if (!midis.length) return;

    // Kill anything sounding
    this.currentNodes.forEach(n => { try { n.stop(); } catch {} });
    this.currentNodes = [];

    const ctx = this._ctxOrCreate();
    const now = ctx.currentTime;

    const H = 11;
    const harmonicSum = this._harmonicSum(H);
    const poly = Math.max(1, midis.length);

    const TARGET_PEAK = 0.65;
    const peakScale = Math.min(0.35, TARGET_PEAK / (harmonicSum * poly));

    const chordGain = ctx.createGain();
    chordGain.connect(Synth.sharedPreMaster);

    const A = 0.02, D = 0.15, S = 0.75, R = 0.12;

    chordGain.gain.setValueAtTime(0, now);
    chordGain.gain.linearRampToValueAtTime(peakScale, now + A);
    chordGain.gain.linearRampToValueAtTime(peakScale * S, now + A + D);
    chordGain.gain.setValueAtTime(peakScale * S, now + dur - R);
    chordGain.gain.linearRampToValueAtTime(0, now + dur);

    midis.forEach((midi, i) => {
      const base = midiToHz(midi);

      // per-note gain (defaults to 1)
      const noteGain = gains ? (gains[i] ?? 1) : 1;

      for (let h = 1; h <= H; h++) {
        const osc = ctx.createOscillator();
        const g   = ctx.createGain();
        const amp = 1 / Math.pow(h, ENGINE.hExp);

        osc.type = "sine";
        osc.frequency.value = base * h;
        g.gain.value = amp * noteGain;

        osc.connect(g).connect(chordGain);
        osc.start(now);
        osc.stop(now + dur);

        this.currentNodes.push(osc);
      }
    });

    setTimeout(() => {
      try { chordGain.disconnect(); } catch {}
    }, (dur + 0.5) * 1000);
  }

  /* ------------------------------------------
     Stop everything (unchanged)
  ------------------------------------------ */
  stopAll() {
    try {
      for (const n of this.currentNodes) {
        try { n.stop(); } catch {}
      }
      this.currentNodes = [];
    } catch (e) {
      console.warn("Synth.stopAll() failed:", e);
    }
  }
}


const KEY_TO_PC = {
  "C":0, "C#":1, "D":2, "D#":3, "E":4, "F":5,
  "F#":6, "G":7, "G#":8, "A":9, "A#":10, "B":11
};


function playKeyCenterChord(trainer) {
  const s = trainer.settings;

  // Atonal → no tonic cue
  if (s.tonality === "atonal") return;

  const pc = trainer.current.keyPC;   

  // Midpoint of user’s range
  const mid = Math.round((s.midiLow + s.midiHigh) / 2);

  let tonic = mid;
  const tonicPC = tonic % 12;
  const diff = (pc - tonicPC + 12) % 12;
  tonic += diff;

  // Clamp inside the actual MIDI playback range
  if (tonic < s.midiLow)  tonic += 12;
  if (tonic > s.midiHigh) tonic -= 12;


  const mode = TONALITY_MODES[s.tonalitySelect];
  const chord = mode.tonicChord.map(n => tonic + n);
  playEngineChord(chord, ENGINE.durationkey, null);
}



function resolveTonality(settings) {
  const s = { ...settings };
  const validModes = ["root","M. dia.","m. dia.","M. chr.","m. chr."];

  if (!validModes.includes(s.tonalitySelect)) {
    s.tonalitySelect = "root";
  }

  if (s.keySelect === "atonal") {
    s.tonality = "atonal";
    s.keyPC = null;
  }
  else if (s.keySelect === "random") {
    s.tonality = "random";
    s.keyPC = null;
  }
  else {
    // fixed key mode
    s.tonality = "fixed";
    s.keyPC = KEY_TO_PC[s.keySelect];
  }

  return s;
}



function generateUniverse(settingsRaw) {
  const s = resolveTonality(settingsRaw);

  const { 
    card: [cMin, cMax],
    span: [spanMin, spanMax],
    midiLow, midiHigh,
    tonality,
    keyPC
  } = s;

  const allowed = TONALITY_MODES[s.tonalitySelect].allowedPCs;
  const restrictPC = (allowed.size !== 12);


  const base = [];

function build(seq, next, left) {
  if (!left) {
    const sp = seq[seq.length - 1];

    // cardinality 1 → ignore span
    if (seq.length === 1) {
      base.push(seq.slice());
    } else {
      if (sp >= spanMin && sp <= spanMax) {
        base.push(seq.slice());
      }
    }
    return;
  }
  for (let v = next; v <= spanMax; v++) {
    seq.push(v);
    build(seq, v + 1, left - 1);
    seq.pop();
  }
}


  for (let c = cMin; c <= cMax; c++) build([0], 1, c - 1);


  if (tonality === "atonal") return base;

  const shifted = [];
  for (const rel of base) {
    for (let r = 0; r < 12; r++) {
      const rel2 = rel.map(v => v + r);

      // 4. IF RESTRICTED PCS → FILTER NOW (after shift)
      if (restrictPC) {
        const pcs = rel2.map(v => v % 12);
        if (!pcs.every(pc => allowed.has(pc))) continue;
      }

      shifted.push(rel2);
    }
  }

 
  if (tonality === "random") return shifted;


  return shifted.filter(rel => {
    const low = rel[0] + keyPC;
    const hi  = rel[rel.length - 1] + keyPC;
    const zMin = Math.ceil((midiLow  - low) / 12);
    const zMax = Math.floor((midiHigh - hi) / 12);
    return zMin <= zMax;
  });
}


function keyRel(rel) {
  return JSON.stringify(rel);
}





class Trainer {

  constructor(synth, initialSettings = {}) {

    this.settings = { ...DEFAULTS, ...initialSettings };
    this.settings = resolveTonality(this.settings);

    this.universe = generateUniverse(this.settings);

    this.current = null;

    this._replayUnansweredCount = 0;
    this._replayChordCount = 0;
    this._replayGuessCount = 0;

    this._playedTonicForCurrentKey = false;
    this._lastKeyPC = null;

    this.rng = (initialSettings && typeof initialSettings.rng === "function")
      ? initialSettings.rng
      : Math.random;

    // Cache for stats
    this._cacheKeys = null;
    this._cacheKeyToIndex = null;
    this._statsByIndex = null;

    this._reachedCount = 0;
    this._reachedIsApprox = false;
    this._sampleLimit = 150000;
    this._sampleK = 2000;
    this._approxRefreshEvery = 500;
    this._submitCounter = 0;

    // logs assigned later by UI
    this.logs = {};
    this.log  = [];

    this._rebuildUniverseAndMigrate();
    
  }



  _cyclePos(count, tonal) {
  const every = Math.max(1, Math.floor(ENGINE.arpEvery));

  if (!tonal) {
    // ATONAL → cycle length = every
    // cycle position in [1 … every]
    return ((count - 1) % every) + 1;
  }

  // TONAL → cycle length = every + 1
  const full = every + 1; // includes key-center step at pos = 0
  const pos = (count % full);

  // pos = 0 means the key-center step
  return pos;  
}

    _isCycleStart(count) {
    const n = Math.max(1, Math.floor(ENGINE.arpEvery));
    return ((count - 1) % n) === 0;
  }

  _buildCacheIfNeeded() {
    if (this._cacheKeys && this._cacheKeyToIndex && this._statsByIndex) return;
    this._rebuildUniverseAndMigrate();
  }

  _rebuildUniverseAndMigrate() {
    this.settings = resolveTonality(this.settings);
    this.universe = generateUniverse(this.settings);

    const newKeys = this.universe.map(keyRel);
    const newMap  = new Map(newKeys.map((k,i)=>[k,i]));

    const N = newKeys.length;
    const WIN = ENGINE.win;

    const newStats = Array.from({ length:N }, () => ({
      buffer: [],
      correct: 0
    }));


// Recompute stats ONLY from the currently active log (mode-specific)
if (this.log && Array.isArray(this.log) && this.log.length > 0) {
  const remaining = new Set([...Array(N).keys()]);

  for (let i = this.log.length - 1; i >= 0 && remaining.size > 0; i--) {
    const entry = this.log[i];
    if (!entry?.rel) continue;

    const idx = newMap.get(keyRel(entry.rel));
    if (idx === undefined) continue;

    const st = newStats[idx];
    if (st.buffer.length < WIN) {
      st.buffer.unshift(entry.ok ? 1 : 0);
      if (st.buffer.length === WIN) remaining.delete(idx);
    }
  }
}

// finalize correct counts
for (const st of newStats) {
  st.correct = st.buffer.reduce((a, b) => a + b, 0);
}

    this._cacheKeys = newKeys;
    this._cacheKeyToIndex = newMap;
    this._statsByIndex = newStats;

    // compute how many reached AIM (same behavior)
    const AIM = ENGINE.aim;
    const rng = this.rng;
    if (N <= this._sampleLimit) {
      let rc = 0;
      for (let i=0; i<N; i++) {
        const s = newStats[i];
        if ((s.correct / WIN) >= AIM) rc++;
      }
      this._reachedCount = rc;
      this._reachedIsApprox = false;
    } else {
      const K = Math.min(this._sampleK, N);
      let hits = 0;
      for (let t=0; t<K; t++) {
        const idx = Math.floor(rng()*N);
        const s = newStats[idx];
        if ((s.correct / WIN) >= AIM) hits++;
      }
      this._reachedCount = Math.round((hits/K)*N);
      this._reachedIsApprox = true;
    }

    // validate current
    if (this.current && this.current.rel) {
      const curKey = keyRel(this.current.rel);
      if (!newMap.has(curKey)) this.current = null;
    }
  }

  _randomPick() {
    this._buildCacheIfNeeded();

    const UN = this.universe;
    if (!UN.length) return null;

    const WIN = ENGINE.win;
    const AIM = ENGINE.aim;
    const MIX = this.settings.mixRatio;
    const rng = this.rng;

    const N = UN.length;
    const stats = this._statsByIndex;

    const rawWeights = new Array(N);
    let total = 0;

    for (let i=0; i<N; i++) {
      const s = stats[i];
      const acc = s.correct / WIN;
      let w = AIM - acc;
      if (w < 0) w = 0;

      // jitter
      w += rng() * 1e-12;

      rawWeights[i] = w;
      total += w;
    }

    if (rng() < MIX) {
      if (total <= 1e-12) {
        return UN[Math.floor(rng()*N)];
      }
      let r = rng() * total;
      for (let i=0; i<N; i++) {
        r -= rawWeights[i];
        if (r <= 0) return UN[i];
      }
      return UN[N-1];
    }

    return UN[Math.floor(rng()*N)];
  }


  changeSettings(newSettings) {
    this.settings = resolveTonality({ ...this.settings, ...newSettings });
    this._rebuildUniverseAndMigrate();
    if (this.current && this.current.answered) this.current = null;
  }

  loadSnapshot(snapshot={}) {
    const st = snapshot.settings || {};
    this.settings = resolveTonality({ ...DEFAULTS, ...st });
    this.universe = generateUniverse(this.settings);
    this._rebuildUniverseAndMigrate();
    this.current = null;
  }

nextTrial() {
  if (this.current && !this.current.answered) return this.current;

  const rel = this._randomPick();
  if (!rel) return (this.current = null);

  const s = this.settings;
  const { midiLow, midiHigh, tonality, keyPC } = s;
  const rng = this.rng;

  const lowOff = rel[0];
  const hiOff  = rel[rel.length - 1];

  let root;

  if (tonality === "atonal" || tonality === "random") {
    const rootLow  = midiLow  - lowOff;
    const rootHigh = midiHigh - hiOff;
    root = rootLow + Math.floor(rng() * (rootHigh - rootLow + 1));
  } else {
    const zMin = Math.ceil((midiLow  - (keyPC + lowOff)) / 12);
    const zMax = Math.floor((midiHigh - (keyPC + hiOff)) / 12);
    const z = Math.floor(rng() * (zMax - zMin + 1)) + zMin;
    root = keyPC + 12*z;
  }

  const midis = rel.map(o => root + o);

  const gains = midis.map(() =>   0.9 + (Math.random()*2 - 1) * ENGINE.ampNoise);

  this.current = {
    rel,
    root,
    midis,
    gains,             
    keyPC: (s.tonality === "fixed" ? s.keyPC : (root % 12)),
    answered: false
  };

  this._replayUnansweredCount = 0;
  this._replayChordCount = 0;
  this._replayGuessCount = 0;

  const tonal = (s.tonality === "random" || s.tonality === "fixed");

  if (!tonal) {
    playEngineChord(midis, ENGINE.duration, gains);  // ← pass gains
    return this.current;
  }

  if (s.tonality === "random") {
    playKeyCenterChord(this);
    setTimeout(() => playEngineChord(midis, ENGINE.duration, gains),
               (ENGINE.durationkey + ENGINE.tonicLeadTime) * 1000);
    return this.current;
  }

  if (!this._playedTonicForCurrentKey || this._lastKeyPC !== s.keyPC) {
    playKeyCenterChord(this);
    this._playedTonicForCurrentKey = true;
    this._lastKeyPC = s.keyPC;
    setTimeout(() => playEngineChord(midis, ENGINE.duration, gains),
               (ENGINE.durationkey + ENGINE.tonicLeadTime) * 1000);
  } else {
    playEngineChord(midis, ENGINE.duration, gains);
  }

  return this.current;
}




replay() {
  const cur = this.current;
  if (!cur) return;

  const s = this.settings;
  const tonal = (s.tonality === "random" || s.tonality === "fixed");
  const every = Math.max(1, Math.floor(ENGINE.arpEvery));

  const truePlayable = cur.midis.filter(
    m => m >= s.midiLow && m <= s.midiHigh
  );
  if (!truePlayable.length) return;

if (!cur.answered) {
  this._replayUnansweredCount = (this._replayUnansweredCount || 0) + 1;

  if (tonal) {
    const full = every + 1;
    const pos  = this._replayUnansweredCount % full;
    if (pos === 0) playKeyCenterChord(this);
    else           playEngineChord(truePlayable, ENGINE.duration, cur.gains);
  } else {
    playEngineChord(truePlayable, ENGINE.duration, cur.gains);
  }

  return;
}


  this._replayChordCount = (this._replayChordCount || 0) + 1;

  if (!tonal) {
    // atonal: simple N-cycle arpeggio
    const isEnd = (this._replayChordCount % every === 0);
    if (isEnd) playEngineArp(truePlayable, ENGINE.arpNoteDur, cur.gains);
    else       playEngineChord(truePlayable, ENGINE.duration, cur.gains);
    return;
  }

  // ------- TONAL replay cycle ------- cycle length = every + 1 (chords + tonic)
  const full = every + 1;
  const pos  = this._replayChordCount % full;

  if (pos === 0) {
    playKeyCenterChord(this);
    return;
  }

  if (pos === every) {
    playEngineArp(truePlayable, ENGINE.arpNoteDur, cur.gains);
    return;
  }

  playEngineChord(truePlayable, ENGINE.duration, cur.gains);
}


playGuess(guessRel) {
  if (!this.current) return;

  const s = this.settings;
  const tonal = (s.tonality === "random" || s.tonality === "fixed");
  const every = Math.max(1, Math.floor(ENGINE.arpEvery));

  const root = this.current.root;

  // IMPORTANT: convert offsets -> MIDI
  const raw = guessRel.map(r => root + r);

  // choose octave shift (0, -12, +12) with your priorities
  const muA = this.current.midis.reduce((a,b)=>a+b,0) / this.current.midis.length;

  let best = null;
  let bestCount = -1;
  let bestDist = Infinity;

  for (const k of [-1, 0, 1]) {
    const shifted = raw.map(m => m + 12*k);
    const playable = shifted.filter(m => m >= s.midiLow && m <= s.midiHigh);
    if (!playable.length) continue;

    const count = playable.length;
    const muP = playable.reduce((a,b)=>a+b,0) / count;
    const dist = Math.abs(muA - muP);

    // 1) keep most notes, 2) then closest mean
    if (count > bestCount || (count === bestCount && dist < bestDist)) {
      best = playable;
      bestCount = count;
      bestDist = dist;
    }
  }

  if (!best || !best.length) return;

  best.sort((a,b)=>a-b);

  // --- now reuse your existing replay cycle logic, but with `best`
  if (!this.current.answered) {
    playEngineChord(best, ENGINE.duration, this.current.gains);
    return;
  }

  this._replayGuessCount = (this._replayGuessCount || 0) + 1;

  if (!tonal) {
    const isEnd = (this._replayGuessCount % every === 0);
    if (isEnd) playEngineArp(best, ENGINE.arpNoteDur, this.current.gains);
    else       playEngineChord(best, ENGINE.duration, this.current.gains);
    return;
  }

  const full = every + 1;
  const pos  = this._replayGuessCount % full;

  if (pos === 0) { playKeyCenterChord(this); return; }
  if (pos === every) { playEngineArp(best, ENGINE.arpNoteDur, this.current.gains); return; }

  playEngineChord(best, ENGINE.duration, this.current.gains);
}

  playEngineChord(playable, ENGINE.duration, this.current.gains);
}
  submitGuess(text) {
  if (!this.current || this.current.answered) return null;

  let nums = (text || "")
    .trim()
    .replace(/,/g, " ")
    .split(/\s+/)
    .filter(s => s.length > 0)
    .map(s => parseInt(s, 10))
    .filter(n => !Number.isNaN(n));

  if (!nums.length) return { ok: null };

if (this.settings.tonality === "atonal") {
  if (nums[0] !== 0) nums.unshift(0);
}

nums = Array.from(new Set(nums)).sort((a,b)=>a-b);


  const truth = this.current.rel;
  const ok = keyRel(nums) === keyRel(truth);
  this.current.answered = true;

  const entry = { rel: truth, guess: nums, ok };
  this.logs[tag].push(entry);
  this._buildCacheIfNeeded();

  const k = keyRel(truth);
  const idx = this._cacheKeyToIndex.get(k);
  const WIN = ENGINE.win;
  const AIM = ENGINE.aim;
  const rng = this.rng;

  if (idx !== undefined) {
    const s = this._statsByIndex[idx];
    const oldAcc = s.correct / WIN;

    s.buffer.push(ok ? 1 : 0);
    if (s.buffer.length > WIN) s.buffer.shift();

    s.correct = s.buffer.reduce((a,b)=>a+b,0);
    const newAcc = s.correct / WIN;

    if (!this._reachedIsApprox) {
      if (oldAcc < AIM && newAcc >= AIM) this._reachedCount++;
      else if (oldAcc >= AIM && newAcc < AIM) this._reachedCount--;
      if (this._reachedCount < 0) this._reachedCount = 0;
      if (this._reachedCount > this._cacheKeys.length)
        this._reachedCount = this._cacheKeys.length;
    } else {
      if (oldAcc < AIM && newAcc >= AIM) this._reachedCount++;
      else if (oldAcc >= AIM && newAcc < AIM)
        this._reachedCount = Math.max(0, this._reachedCount - 1);
    }
  }

  this._submitCounter = (this._submitCounter || 0) + 1;

  if (this._reachedIsApprox &&
      (this._submitCounter % this._approxRefreshEvery === 0)) {

    const N2 = this._statsByIndex.length;
    const K2 = Math.min(this._sampleK, N2);

    let hits2 = 0;
    for (let t=0; t<K2; t++) {
      const i2 = Math.floor(rng()*N2);
      const s2 = this._statsByIndex[i2];
      if ((s2.correct / WIN) >= AIM) hits2++;
    }
    this._reachedCount = Math.round((hits2/K2)*N2);
  }

  return { ok, truth, guess: nums };
}


snapshotForSave() {
  return {
    settings: this.settings,
    logs: this.logs,
    section: document.getElementById("sectionSelect")?.value || "synth"
  };
}
}


(function initApp() {

  (function injectDisabledSafetyCSS() {
    try {
      const css = "button:disabled{pointer-events:none!important;} select:disabled{pointer-events:none!important;}";
      const s = document.createElement("style");
      s.setAttribute("data-pitchsettrainer-safety","true");
      s.appendChild(document.createTextNode(css));
      document.head.appendChild(s);
    } catch (e) {
      console.warn("Failed to inject safety CSS:", e);
    }
  })();

  const el = {
    userSelect:    document.getElementById("userSelect"),
    newUserBtn:    document.getElementById("newUserBtn"),
    deleteUserBtn: document.getElementById("deleteUserBtn"),

    keySelect:        document.getElementById("keySelect"),
    tonalitySelect:   document.getElementById("tonalitySelect"),

    cardMin:          document.getElementById("cardMin"),
    cardMax:          document.getElementById("cardMax"),
    midiLow:          document.getElementById("midiLow"),
    midiHigh:         document.getElementById("midiHigh"),
    spanMin:          document.getElementById("spanMin"),
    spanMax:          document.getElementById("spanMax"),
    mixRatio:         document.getElementById("mixRatio"),
    sectionSelect:    document.getElementById("sectionSelect"),

    newSetBtn:        document.getElementById("newSetBtn"),
    replaySetBtn:     document.getElementById("replaySetBtn"),
    guessInput:       document.getElementById("guessInput"),
    submitBtn:        document.getElementById("submitBtn"),

    feedback:         document.getElementById("feedback")
  };

  let currentUser = "Guest";
  const realSynth = new Synth();       

  activeSynth = realSynth;             // default
  const trainer = new Trainer(null, DEFAULTS);
  trainer.synth = null;  


  if (el.guessInput) {

    el.guessInput.addEventListener("paste", e => e.preventDefault());
    el.guessInput.addEventListener("drop",  e => e.preventDefault());
    el.guessInput.addEventListener("beforeinput", e => {
      if (e.inputType === "insertFromPaste" || e.inputType === "insertFromDrop") {
        e.preventDefault();
      }
    });


    el.guessInput.addEventListener("keydown", (e) => {
      const input = el.guessInput;
      const key = e.key;

      if ([
        "ArrowLeft","ArrowRight","ArrowUp","ArrowDown",
        "Backspace","Delete","Tab","Home","End"
      ].includes(key)) return;

      // digits allowed
      if (/^\d$/.test(key)) return;

      // separators (space/comma/dot)
      if ([" ", ",", "."].includes(key)) {
        e.preventDefault();

        const start = input.selectionStart;
        const end = input.selectionEnd;

        const val = input.value;
        const before = val.slice(0, start);
        const after  = val.slice(end);

        const hadDigitBefore = /\d$/.test(before);

        if (hadDigitBefore) {
          let withSpace = before;
          if (!before.endsWith(" ")) withSpace += " ";
          const evaluated = evaluateSequence(withSpace);
          const newVal = evaluated + after;

          input.value = newVal;

          let pos = evaluated.length;
          if (input.value[pos] !== " ") {
            input.value = input.value.slice(0,pos) + " " + input.value.slice(pos);
          }
          pos++;
          input.setSelectionRange(pos, pos);
        } else {
          // caret "^"
          const newVal = before + "^" + after;
          input.value = newVal;
          input.setSelectionRange(start+1, start+1);
        }
        return;
      }

      // Enter → evaluate OR block empty submission
      if (key === "Enter") {
        if (/\d/.test(input.value)) {
          e.preventDefault();
          input.value = evaluateSequence(input.value);
          const p = input.value.length;
          input.setSelectionRange(p,p);
        } else {
          e.preventDefault();
        }
        return;
      }

      // block everything else
      e.preventDefault();
    });


    el.guessInput.addEventListener("keydown", e => {
      if (e.repeat) return;
      if (!e.key || e.key.length !== 1) return;

      const k = e.key.toLowerCase();

      if (k === "c" && !el.replaySetBtn.disabled) {
        e.preventDefault(); handleReplay();
      } else if (k === "g" && !el.submitBtn.disabled) {
        e.preventDefault(); handleSubmit();
      }
    });




function computeRanges(s) {
  const ranges = {};

  const allowSingles = (s.tonality !== "atonal");
  const minCard = allowSingles ? 1 : 2;

  ranges.cardMin = [minCard, Math.min(5, s.card[1])];
  ranges.cardMax = [Math.max(minCard, s.card[0]), Math.min(5, s.span[1] + 1)];

  ranges.spanMax  = [Math.max(s.card[1]-1,0), s.midiHigh - s.midiLow];
  ranges.spanMin  = [0, s.span[1]];

  ranges.midiLow  = [MIDI_ABS_LOW, s.midiHigh - s.span[1]];
  ranges.midiHigh = [s.midiLow + s.span[1], MIDI_ABS_HIGH];

  return ranges;
}

  function fillSelect(select, [min,max], selected, labelFn = x=>x) {
    if (!select) return;
    select.innerHTML = "";

    if (min > max) max = min;

    for (let v=min; v<=max; v++) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = labelFn(v);
      if (v === selected) opt.selected = true;
      select.appendChild(opt);
    }

    if (![...select.options].some(o=>o.selected)) {
      if (select.options.length) select.options[0].selected = true;
    }
  }

  function renderSettingsUI(s) {
    const ranges = computeRanges(s);

    fillSelect(el.cardMin,  ranges.cardMin,  s.card[0]);
    fillSelect(el.cardMax,  ranges.cardMax,  s.card[1]);
    fillSelect(el.spanMin,  ranges.spanMin,  s.span[0]);
    fillSelect(el.spanMax,  ranges.spanMax,  s.span[1]);
    fillSelect(el.midiLow,  ranges.midiLow,  s.midiLow, midiToNote);
    fillSelect(el.midiHigh, ranges.midiHigh, s.midiHigh, midiToNote);

    el.mixRatio.innerHTML = "";
    for (let i=0; i<=10; i++) {
      const val = (i/10).toFixed(1);
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = `${Math.round(i*10)}%`;
      if (Math.abs(parseFloat(val) - s.mixRatio) < 1e-6) opt.selected = true;
      el.mixRatio.appendChild(opt);
    }

    el.keySelect.value = s.keySelect;
    const modes = ["root","M. dia.","m. dia.","M. chr.","m. chr."];

    if (!modes.includes(s.tonalitySelect)) {
      el.tonalitySelect.value = "root";   // old users → fallback
    } else {
      el.tonalitySelect.value = s.tonalitySelect;
    }
    // Disable tonalitySelect ONLY when atonal
    el.tonalitySelect.disabled = (s.keySelect === "atonal");
  }

  function readSettingsFromUI() {
    return resolveTonality({
      keySelect:      el.keySelect.value,
      tonalitySelect: el.tonalitySelect.value,

      midiLow:  +el.midiLow.value,
      midiHigh: +el.midiHigh.value,

      card: [ +el.cardMin.value, +el.cardMax.value ],
      span: [ +el.spanMin.value, +el.spanMax.value ],

      mixRatio: parseFloat(el.mixRatio.value)
    });
  }

  [
    "midiLow","midiHigh","cardMin","cardMax",
    "spanMin","spanMax","mixRatio",
    "keySelect","tonalitySelect"
  ].forEach(id => {
    const node = document.getElementById(id);
    if (!node) return;

    node.addEventListener("change", () => {
      const s = readSettingsFromUI();

      let tag;
      if (s.keySelect === "atonal") tag = "ATONAL";
      else tag = s.tonalitySelect;

      if (!trainer.logs[tag]) trainer.logs[tag] = [];
const t = trainer.settings.tonalitySelect;

      if (t === "M. chr.") {
        trainer.log = (trainer.logs["M. dia."] || [])
          .concat(trainer.logs["M. chr."] || []);
      }
      else if (t === "m. chr.") {
        trainer.log = (trainer.logs["m. dia."] || [])
          .concat(trainer.logs["m. chr."] || []);
      }
      else {
        trainer.log = trainer.logs[tag];
      }
      trainer.changeSettings(s);

      if (id === "keySelect" || id === "tonalitySelect") {
        trainer.current = null;
      }

      renderSettingsUI(trainer.settings);
      updateButtons();
      Storage.save(currentUser, { ...trainer.snapshotForSave(), section: el.sectionSelect.value });
    });
  });

el.sectionSelect.addEventListener("change", async () => {
  const v = el.sectionSelect.value;

  setPlayControlsEnabled(false);

  if (v === "synth") {
    activeSynth = realSynth;
    activeSection = null;

    setPlayControlsEnabled(true);
    updateButtons();
    return;
  }

  activeSynth = null;

  await loadSection(v);  // load fonts  (300–800ms)

  setPlayControlsEnabled(true);
  updateButtons();
});


  function updateButtons() {
    const cur = trainer.current;

    const supportsKeyboard =
      window.matchMedia("(any-hover: hover) and (any-pointer: fine)").matches;

    const replayChordLabel =
      supportsKeyboard ? `Replay <u class="accesskey-u">C</u>hord` : "Replay chord";

    const replayGuessLabel =
      supportsKeyboard ? `Replay <u class="accesskey-u">G</u>uess` : "Replay guess";

    const newLabel =
      supportsKeyboard ? `▶ <u class="accesskey-u">N</u>ew Chord` : "▶ New Chord";

    if (el.newSetBtn.innerHTML.trim() !== newLabel) {
      el.newSetBtn.innerHTML = newLabel;
    }

    if (!cur) {
      if (el.submitBtn) el.submitBtn.disabled = true;
      if (el.newSetBtn) el.newSetBtn.disabled = false;
      if (el.replaySetBtn) {
        el.replaySetBtn.disabled = true;
        el.replaySetBtn.innerHTML = 
        `<span style="font-size:1.8em; transform: translateY(-0.1em);">⟳</span><span>${replayChordLabel}</span>`;
      }
      if (el.guessInput) el.guessInput.disabled = true;
      return;
    }

    if (cur.answered) {
      if (el.submitBtn) {
        el.submitBtn.disabled = false;
        el.submitBtn.innerHTML =
          `<span style="font-size:1.8em; transform: translateY(-0.1em);">⟳</span><span>${replayGuessLabel}</span>`;
      }
      if (el.newSetBtn) el.newSetBtn.disabled = false;

      if (el.replaySetBtn) {
        el.replaySetBtn.disabled = false;
        el.replaySetBtn.innerHTML =
          `<span style="font-size:1.8em; transform: translateY(-0.1em);">⟳</span><span>${replayChordLabel}</span>`;
      }
      if (el.guessInput) el.guessInput.disabled = true;
    }

    else {
      // Awaiting guess
      if (el.submitBtn) {
        el.submitBtn.disabled = false;
        el.submitBtn.innerHTML =
          `<span style="font-size:1.3em;">⏎</span><span>Submit Guess</span>`;
      }
      if (el.newSetBtn) el.newSetBtn.disabled = true;
      if (el.replaySetBtn) {
        el.replaySetBtn.disabled = false;
        el.replaySetBtn.innerHTML =
          `<span style="font-size:1.8em; transform: translateY(-0.1em);">⟳</span><span>${replayChordLabel}</span>`;
      }
      if (el.guessInput) el.guessInput.disabled = false;
    }

    if (el.deleteUserBtn)
      el.deleteUserBtn.disabled = (currentUser === "Guest");
  }

  if (el.replaySetBtn) {
    el.replaySetBtn.accessKey = "c";
    el.replaySetBtn.setAttribute("aria-keyshortcuts","c");
  }
  if (el.submitBtn) {
    el.submitBtn.accessKey = "g";
    el.submitBtn.setAttribute("aria-keyshortcuts","g");
  }

  window.addEventListener("keydown", e => {
    if (e.repeat) return;
    if (document.activeElement === el.guessInput) return;

    const k = (e.key || "").toLowerCase();

    if (k === "c" && !el.replaySetBtn.disabled) {
      e.preventDefault(); handleReplay();
    } else if (k === "g" && !el.submitBtn.disabled) {
      e.preventDefault(); handleSubmit();
    } else if (k === "n" && !el.newSetBtn.disabled) {
      e.preventDefault(); handleNewSet();
    }
  });


function updateFeedback(ok, truth, guess) {
  const WIN = ENGINE.win;
  const AIM = ENGINE.aim;

  const formatSet = arr => "(" + arr.join(", ") + ")";

  const key = keyRel(truth);
  const idx = trainer._cacheKeyToIndex.get(key);
  const stats = trainer._statsByIndex;

  // --- rolling accuracy for current set (EXACT)
  const correct = idx !== undefined ? stats[idx].correct : 0;

  // --- minimum accuracy across all sets (EXACT)
  let minAcc = 1;
  for (const s of stats) {
    const acc = s.correct / WIN;
    if (acc < minAcc) minAcc = acc;
  }

  // --- overall accuracy (still from log: global stat, unchanged)
  const total = trainer.log.length;
  const overall = total
    ? Math.round(trainer.log.filter(l => l.ok).length / total * 100)
    : 0;

  // --- sets ≥ AIM (EXACT)
  const reached = trainer._reachedCount;

  let msg = "";
  if (ok) {
    const animals = ["🦚","🐢","🦜","🐧","🐤","🦔","🦩","🦥","🦨"];
    const L = animals[Math.floor(Math.random()*animals.length)];
    let R = animals[Math.floor(Math.random()*animals.length)];
    if (R === L && animals.length > 1)
      R = animals[(animals.indexOf(L)+1) % animals.length];

    msg = `
      <div style="text-align:center;">
      ${L} <span style="color:rgb(48,134,48)">${formatSet(truth)}</span> ${R}
      </div>`;
    el.replaySetBtn.classList.add("btn-green");
    el.submitBtn.classList.add("btn-green");
  } else {
    msg = `
      <div style="text-align:center;">
      🙉 <span style="color:rgb(160,68,50)">${formatSet(guess)}</span>
      vs.
      <span style="color:rgb(48,134,48)">${formatSet(truth)}</span> 🙊
      </div>`;
    el.replaySetBtn.classList.add("btn-green");
    el.submitBtn.classList.add("btn-red");
  }

  msg += `
    <div style="text-align:left; margin-top:0.5rem; margin-left:3.7rem; font-family:monospace;">
    Rolling accuracy: <strong>${correct}/${WIN}</strong><br>
    Minimum accuracy: <strong>${Math.round(minAcc*WIN)}/${WIN}</strong><br>
    Overall accuracy: <strong>${overall}%</strong><br>
    Sets &ge;80%: <strong>${reached}/${trainer.universe.length}</strong>
    </div>`;

  el.feedback.innerHTML = msg;
}


  async function switchUser(name, opts={}) {
    if (activeSynth && activeSynth.stopAll) activeSynth.stopAll();

    if (!opts.skipSave && currentUser !== "Guest") {
      Storage.save(currentUser, trainer.snapshotForSave());
    }

    currentUser = name;
    const data = Storage.load(currentUser);

    trainer.changeSettings(data.settings);
    trainer.logs = data.logs || {};

        // --- RESTORE USER'S SECTION ---
    if (data.section) {
      el.sectionSelect.value = data.section;

      if (data.section === "synth") {
        activeSynth = realSynth;
        activeSection = null;
      } else {
        activeSynth = null;
        await loadSection(data.section);
      }
    }

    // select bucket
    const keySel = trainer.settings.keySelect;
    let tag;
    if (keySel === "atonal") tag = "ATONAL";
    else tag = trainer.settings.tonalitySelect;

    if (!trainer.logs[tag]) trainer.logs[tag] = [];

    trainer.log = trainer.logs[tag];
    trainer.current = null;

    el.feedback.innerHTML = "";

    renderSettingsUI(trainer.settings);
    trainer.changeSettings(readSettingsFromUI());
    refreshUserSelect();
    updateButtons();
  }

  function refreshUserSelect() {
    el.userSelect.innerHTML = "";

    const g = document.createElement("option");
    g.value = "Guest";
    g.textContent = "Guest";
    el.userSelect.appendChild(g);

    for (const u of Storage.listUsers()) {
      const opt = document.createElement("option");
      opt.value = u;
      opt.textContent = u;
      el.userSelect.appendChild(opt);
    }

    if (![...el.userSelect.options].some(o=>o.value===currentUser)) {
      currentUser = "Guest";
    }

    el.userSelect.value = currentUser;
  }

  el.userSelect.onchange = e => switchUser(e.target.value);

  el.newUserBtn.onclick = () => {
    if (el.newUserBtn.disabled) return;
    const name = prompt("Enter Username:");
    if (!name) return;

    const trimmed = name.trim();
    if (!trimmed) return;
    if (trimmed === "Guest") { alert("User name 'Guest' is reserved."); return; }
    if (Storage.listUsers().includes(trimmed)) { alert("User already exists."); return; }

    Storage.save(trimmed, { settings:{...DEFAULTS}, logs:{} });
    switchUser(trimmed);
  };

  el.deleteUserBtn.onclick = () => {
    if (el.deleteUserBtn.disabled) return;
    if (currentUser === "Guest") return;
    if (!confirm(`Delete User '${currentUser}'?`)) return;

    Storage.remove(currentUser);
    switchUser("Guest", { skipSave:true });
  };

  function setPlayControlsEnabled(on) {
    el.newSetBtn.disabled    = !on;
    el.replaySetBtn.disabled = !on;
    el.submitBtn.disabled    = !on;
    if (el.guessInput) el.guessInput.disabled = !on;
  }

  function handleNewSet() {
    if (el.newSetBtn.disabled) return;

    trainer.nextTrial();
    updateButtons();

    el.feedback.innerHTML = "";
    el.replaySetBtn.classList.remove("btn-green","btn-red");
    el.submitBtn.classList.remove("btn-green","btn-red");

    focusAfterEnterReleased(el.guessInput);
  }

  function handleReplay() {
    if (!el.replaySetBtn.disabled) {
      trainer.replay();
    }
  }

    function evaluateSequence(str) {
      const tokens = str.match(/\d+|\^/g);
      if (!tokens) return str;

      const result = [];
      let pendingCarets = 0;

      for (const tok of tokens) {
        if (tok === "^") {
          pendingCarets++;
          continue;
        }
        let n = parseInt(tok,10);
        if (result.length > 0) {
          while (n <= result[result.length-1]) n += 12;
        }
        if (pendingCarets > 0) {
          n += 12 * pendingCarets;
          pendingCarets = 0;
        }
        result.push(n);
      }
      return result.join(" ");
    }
  }

  function handleSubmit() {
    if (el.submitBtn.disabled) return;

    const cur = trainer.current;
    if (!cur) return;

    el.guessInput.value = evaluateSequence(el.guessInput.value || "");

    if (!cur.answered) {
      const res = trainer.submitGuess(el.guessInput.value || "");
      if (!res) return;

      updateFeedback(res.ok, res.truth, res.guess);

      el.guessInput.value = "";
      el.guessInput.disabled = true;
      el.newSetBtn.disabled = false;

      updateButtons();

      focusAfterEnterReleased(el.newSetBtn);
      Storage.save(currentUser, trainer.snapshotForSave());
    } else {
      const last = trainer.log[trainer.log.length-1];
      if (last) trainer.playGuess(last.guess);
    }
  }

  el.newSetBtn.onclick    = handleNewSet;
  el.replaySetBtn.onclick = handleReplay;
  el.submitBtn.onclick    = handleSubmit;

  if (el.guessInput) {
    el.guessInput.addEventListener("keydown", e => {
      if (e.repeat) return;

      const val = (el.guessInput.value || "").trim();

      // SPACE = replay when empty
      if (e.key === " " || e.key === "Spacebar" || e.code === "Space") {
        if (!e.ctrlKey && !e.altKey && !e.metaKey) {
          if (!val.length) {
            e.preventDefault();
            if (!el.replaySetBtn.disabled) handleReplay();
          }
        }
        return;
      }

      // ENTER = replay when empty, submit when non-empty
      if (e.key === "Enter") {
        e.preventDefault();
        if (!val.length) {
          if (!el.replaySetBtn.disabled) handleReplay();
        } else {
          if (!el.submitBtn.disabled) handleSubmit();
        }
      }
    });
  }

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

  currentUser = Storage.lastUser();
  if (currentUser !== "Guest" && !Storage.listUsers().includes(currentUser))
    currentUser = "Guest";

  const data = Storage.load(currentUser);

  trainer.changeSettings(data.settings);
  trainer.logs = data.logs || {};

  const keySel = trainer.settings.keySelect;
  let tag;
  if (keySel === "atonal") tag = "ATONAL";
  else tag = trainer.settings.tonalitySelect;

  if (!trainer.logs[tag]) trainer.logs[tag] = [];
  trainer.log = trainer.logs[tag];

  renderSettingsUI(trainer.settings);
  trainer.changeSettings(readSettingsFromUI());

  refreshUserSelect();
  updateButtons();

  if (currentUser === "Guest") el.deleteUserBtn.disabled = true;

  window.addEventListener("beforeunload", () => {
    try {
      Storage.save(currentUser, trainer.snapshotForSave());
    } catch {}
  });

})();
