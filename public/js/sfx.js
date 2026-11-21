/*
 * sfx.js — West Coast Heroes synthesized sound cues (WebAudio, zero audio files).
 * Self-contained, dependency-free ES module. Never throws if audio is unavailable.
 *
 * Usage:
 *   import { sfx, CUES } from './sfx.js';
 *   sfx.unlock();                       // call once at boot; arms first-tap/key unlock (iOS Safari)
 *   sfx.play('swing', { variant: 2 });  // Noah combo hit 2 (1..3)
 *   sfx.swing(3);                       // shorthand for the same
 *   sfx.play('arcaneBreaker');          // big finisher
 *   sfx.play('axe');                    // Markie heavy swing + ground impact (or 'axeSwing' / 'axeImpact')
 *   sfx.play('bowDraw'); sfx.play('bowRelease'); sfx.play('arrowHit');   // Espirit, separately
 *   sfx.play('crit', { pan: -0.4, gain: 0.8, pitch: 2 }); // pan -1..1, gain mult, pitch in semitones
 *   sfx.setVolume(0.6); sfx.toggleMute();                  // persisted to localStorage
 *
 * play() opts: { variant, pan (-1..1), gain (multiplier, default 1), pitch (semitones), delay (seconds),
 *                force (bypass throttle) }  -> returns true if scheduled, false otherwise.
 */

const LS_VOL = 'wch.sfx.volume';
const LS_MUTE = 'wch.sfx.muted';
const UNLOCK_EVENTS = ['pointerdown', 'touchend', 'keydown', 'mousedown'];

// ---------- persisted settings ----------
function lsGet(k) { try { return globalThis.localStorage ? globalThis.localStorage.getItem(k) : null; } catch (_) { return null; } }
function lsSet(k, v) { try { if (globalThis.localStorage) globalThis.localStorage.setItem(k, String(v)); } catch (_) { /* private mode */ } }

let volume = (() => { const v = parseFloat(lsGet(LS_VOL)); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8; })();
let muted = lsGet(LS_MUTE) === '1';

// ---------- audio graph ----------
let ctx = null;        // AudioContext
let master = null;     // GainNode (volume/mute)
let noiseBuf = null;   // cached 2s white noise
let failed = false;    // AudioContext unsupported
let armed = false;

function getCtx() {
  if (ctx || failed) return ctx;
  try {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null; // not latched: cheap to re-check
    ctx = new AC({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = muted ? 0 : volume;
    // Glue compressor then brick-wall-ish limiter so stacked hits never clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 10; comp.ratio.value = 5;
    comp.attack.value = 0.003; comp.release.value = 0.18;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20;
    lim.attack.value = 0.001; lim.release.value = 0.08;
    master.connect(comp); comp.connect(lim); lim.connect(ctx.destination);
    // Cached noise
    const len = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  } catch (_) { ctx = null; failed = true; }
  return ctx;
}

function applyMaster() {
  if (!ctx || !master) return;
  try {
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setTargetAtTime(muted ? 0 : volume, t, 0.015);
  } catch (_) {}
}

// ---------- unlock (iOS Safari needs resume + a sound inside a user gesture) ----------
function onGesture() {
  const c = getCtx();
  if (!c) { disarm(); return; }
  try {
    if (c.state !== 'running' && c.resume) { const p = c.resume(); if (p && p.catch) p.catch(() => {}); }
    const b = c.createBuffer(1, 1, 22050);
    const s = c.createBufferSource();
    s.buffer = b; s.connect(c.destination); s.start(0);
  } catch (_) {}
  // Stay armed until the context is actually running (first gesture can fail on iOS).
  setTimeout(() => { if (ctx && ctx.state === 'running') disarm(); }, 0);
}
function disarm() {
  if (!armed) return;
  armed = false;
  try { for (const e of UNLOCK_EVENTS) globalThis.removeEventListener(e, onGesture, true); } catch (_) {}
}
function onVisibility() {
  try {
    if (ctx && globalThis.document && !globalThis.document.hidden && ctx.state !== 'running') {
      const p = ctx.resume(); if (p && p.catch) p.catch(() => {});
      if (!armed) unlock(); // iOS "interrupted" state may need a fresh gesture
    }
  } catch (_) {}
}
let visHooked = false;
function unlock() {
  try {
    if (ctx && ctx.state === 'running') return true;
    if (!armed && globalThis.addEventListener) {
      armed = true;
      for (const e of UNLOCK_EVENTS) globalThis.addEventListener(e, onGesture, { capture: true, passive: true });
    }
    if (!visHooked && globalThis.document && globalThis.document.addEventListener) {
      visHooked = true;
      globalThis.document.addEventListener('visibilitychange', onVisibility);
    }
  } catch (_) {}
  return false;
}

// ---------- synthesis helpers ----------
const rnd = (a, b) => a + Math.random() * (b - a);
const semis = (s) => Math.pow(2, s / 12);
const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI -> Hz

function env(g, t, a, peak, dur, tail = 'exp') {
  const p = g.gain;
  p.setValueAtTime(0.0001, t);
  p.linearRampToValueAtTime(Math.max(0.0002, peak), t + a);
  if (tail === 'exp') p.exponentialRampToValueAtTime(0.0001, t + dur);
  else p.linearRampToValueAtTime(0.0001, t + dur);
}

/** Oscillator voice. f0->f1 sweep, ADSR-lite envelope. */
function tone(V, { type = 'sine', f0, f1 = f0, at = 0, dur = 0.2, a = 0.004, peak = 0.3, sweep = 'exp', detune = 0, tail = 'exp', filter }) {
  const c = V.ctx, t = V.t + at, r = V.rate;
  const o = c.createOscillator(); const g = c.createGain();
  o.type = type; o.detune.value = detune;
  o.frequency.setValueAtTime(Math.max(1, f0 * r), t);
  if (f1 !== f0) {
    if (sweep === 'exp') o.frequency.exponentialRampToValueAtTime(Math.max(1, f1 * r), t + dur);
    else o.frequency.linearRampToValueAtTime(Math.max(1, f1 * r), t + dur);
  }
  env(g, t, a, peak * V.gain, dur, tail);
  let node = o;
  if (filter) { const f = biq(c, filter, t, dur, r); node.connect(f); node = f; }
  node.connect(g); g.connect(V.out);
  o.start(t); o.stop(t + dur + 0.05);
}

/** Filtered noise voice. */
function noise(V, { at = 0, dur = 0.2, a = 0.004, peak = 0.3, type = 'bandpass', f0 = 1000, f1 = f0, q = 1, tail = 'exp' }) {
  const c = V.ctx, t = V.t + at;
  const s = c.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
  const f = biq(c, { type, f0, f1, q }, t, dur, V.rate);
  const g = c.createGain();
  env(g, t, a, peak * V.gain, dur, tail);
  s.connect(f); f.connect(g); g.connect(V.out);
  s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
}

function biq(c, { type = 'lowpass', f0 = 1000, f1 = f0, q = 1 }, t, dur, r = 1) {
  const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(Math.max(20, f0 * r), t);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * r), t + dur);
  return f;
}

// ---------- cue definitions ----------
// gap: min ms between triggers; voices: max simultaneous; len: approx seconds (for voice bookkeeping); pv: pitch variance (semitones)
const DEFS = {
  // Noah — sword combo. variant 1: quick slash, 2: reverse slash, 3: heavy spin with steel ring.
  swing: { gap: 45, voices: 4, len: 0.35, pv: 0.7, fn(V, o) {
    const n = Math.min(3, Math.max(1, (o.variant | 0) || 1));
    if (n === 1) {
      noise(V, { dur: 0.16, a: 0.01, peak: 0.45, type: 'bandpass', f0: 900, f1: 3800, q: 1.6 });
    } else if (n === 2) {
      noise(V, { dur: 0.18, a: 0.012, peak: 0.45, type: 'bandpass', f0: 3600, f1: 1100, q: 1.8 });
    } else {
      noise(V, { dur: 0.28, a: 0.03, peak: 0.55, type: 'bandpass', f0: 500, f1: 4200, q: 1.2 });
      tone(V, { type: 'triangle', f0: 1568, at: 0.05, dur: 0.3, peak: 0.08 });
      tone(V, { type: 'sine', f0: 2349, at: 0.05, dur: 0.25, peak: 0.05 });
    }
  } },
  // Noah — arcane hit: glassy blue zap
  arcaneHit: { gap: 40, voices: 5, len: 0.3, pv: 1, fn(V) {
    tone(V, { type: 'sine', f0: 1320, f1: 520, dur: 0.22, peak: 0.28 });
    tone(V, { type: 'triangle', f0: 1980, f1: 990, dur: 0.16, peak: 0.12, detune: 12 });
    noise(V, { dur: 0.12, peak: 0.18, type: 'highpass', f0: 5000, q: 0.7 });
  } },
  // Noah — Arcane Breaker finisher: rising charge, boom, sub drop, shimmer chord
  arcaneBreaker: { gap: 400, voices: 1, len: 1.6, pv: 0.3, fn(V) {
    tone(V, { type: 'sawtooth', f0: 180, f1: 900, dur: 0.28, a: 0.2, peak: 0.12, tail: 'lin', filter: { type: 'lowpass', f0: 600, f1: 4000, q: 4 } });
    const h = 0.28;
    tone(V, { type: 'sine', f0: 150, f1: 32, at: h, dur: 0.9, a: 0.005, peak: 0.9 });
    noise(V, { at: h, dur: 0.7, a: 0.003, peak: 0.6, type: 'lowpass', f0: 3000, f1: 200, q: 0.8 });
    noise(V, { at: h, dur: 0.25, peak: 0.25, type: 'highpass', f0: 6000, q: 0.5 });
    [76, 79, 83, 88].forEach((m, i) => tone(V, { type: 'sine', f0: NOTE(m), at: h + 0.06 + i * 0.04, dur: 1.1, a: 0.02, peak: 0.09 }));
  } },
  // Markie — axe heavy swing (low, slow whoosh)
  axeSwing: { gap: 90, voices: 2, len: 0.45, pv: 0.6, fn(V) {
    noise(V, { dur: 0.36, a: 0.08, peak: 0.6, type: 'bandpass', f0: 250, f1: 1300, q: 1.4 });
    noise(V, { dur: 0.3, a: 0.1, peak: 0.2, type: 'lowpass', f0: 180, f1: 500, q: 2 });
  } },
  // Markie — ground impact: thump + dirt crunch
  axeImpact: { gap: 90, voices: 3, len: 0.6, pv: 0.5, fn(V) {
    tone(V, { type: 'sine', f0: 110, f1: 34, dur: 0.45, a: 0.002, peak: 0.95 });
    noise(V, { dur: 0.35, a: 0.002, peak: 0.55, type: 'lowpass', f0: 1600, f1: 150, q: 0.7 });
    noise(V, { at: 0.02, dur: 0.18, peak: 0.18, type: 'bandpass', f0: 2500, q: 2 });
  } },
  // Markie — combined
  axe: { gap: 120, voices: 2, len: 0.85, pv: 0.5, fn(V) {
    DEFS.axeSwing.fn(V);
    DEFS.axeImpact.fn({ ...V, t: V.t + 0.24 });
  } },
  // Espirit — bow draw: string creak tension
  bowDraw: { gap: 120, voices: 2, len: 0.45, pv: 0.4, fn(V) {
    tone(V, { type: 'sawtooth', f0: 95, f1: 140, dur: 0.38, a: 0.25, peak: 0.07, tail: 'lin', filter: { type: 'bandpass', f0: 700, f1: 1400, q: 6 } });
    noise(V, { dur: 0.38, a: 0.3, peak: 0.08, type: 'bandpass', f0: 1800, f1: 3200, q: 5, tail: 'lin' });
  } },
  // Espirit — release: string twang + air
  bowRelease: { gap: 50, voices: 3, len: 0.3, pv: 0.8, fn(V) {
    tone(V, { type: 'triangle', f0: 330, f1: 300, dur: 0.22, a: 0.002, peak: 0.3 });
    tone(V, { type: 'sine', f0: 660, f1: 600, dur: 0.12, a: 0.002, peak: 0.1 });
    noise(V, { dur: 0.14, a: 0.003, peak: 0.3, type: 'bandpass', f0: 4500, f1: 1800, q: 1.2 });
  } },
  // Espirit — arrow hit: woody thunk
  arrowHit: { gap: 35, voices: 5, len: 0.2, pv: 1, fn(V) {
    tone(V, { type: 'sine', f0: 340, f1: 110, dur: 0.12, a: 0.001, peak: 0.45 });
    noise(V, { dur: 0.07, a: 0.001, peak: 0.35, type: 'bandpass', f0: 1400, q: 2.5 });
  } },
  // Espirit — combined
  bow: { gap: 150, voices: 2, len: 0.85, pv: 0.4, fn(V) {
    DEFS.bowDraw.fn(V);
    DEFS.bowRelease.fn({ ...V, t: V.t + 0.36 });
    DEFS.arrowHit.fn({ ...V, t: V.t + 0.55 });
  } },
  // Destiny — gold strike: metallic clang with inharmonic bell partials
  goldStrike: { gap: 45, voices: 4, len: 0.6, pv: 0.6, fn(V) {
    noise(V, { dur: 0.05, a: 0.001, peak: 0.4, type: 'highpass', f0: 3000, q: 0.7 });
    [[523, 0.22], [1420, 0.12], [2650, 0.07], [3840, 0.04]].forEach(([f, p]) =>
      tone(V, { type: 'sine', f0: f, dur: 0.5, a: 0.002, peak: p }));
    tone(V, { type: 'square', f0: 220, f1: 140, dur: 0.08, a: 0.001, peak: 0.08, filter: { type: 'lowpass', f0: 1200 } });
  } },
  // Destiny — heal chime: soft rising major arpeggio
  healChime: { gap: 200, voices: 2, len: 0.9, pv: 0.2, fn(V) {
    [84, 88, 91, 96].forEach((m, i) => {
      tone(V, { type: 'sine', f0: NOTE(m), at: i * 0.07, dur: 0.6, a: 0.015, peak: 0.13 });
      tone(V, { type: 'triangle', f0: NOTE(m) * 2, at: i * 0.07, dur: 0.3, a: 0.01, peak: 0.03 });
    });
  } },
  // Crit — bright, sparkly ping
  crit: { gap: 60, voices: 3, len: 0.35, pv: 0.5, fn(V) {
    tone(V, { type: 'square', f0: 1760, dur: 0.09, a: 0.001, peak: 0.08, filter: { type: 'lowpass', f0: 6000 } });
    tone(V, { type: 'triangle', f0: 2637, at: 0.04, dur: 0.25, a: 0.002, peak: 0.16 });
    tone(V, { type: 'sine', f0: 3520, at: 0.07, dur: 0.22, a: 0.002, peak: 0.08 });
    noise(V, { dur: 0.1, a: 0.001, peak: 0.25, type: 'highpass', f0: 7000, q: 0.5 });
  } },
  // Enemy stagger: low buzzy wobble
  stagger: { gap: 70, voices: 4, len: 0.25, pv: 1.5, fn(V) {
    tone(V, { type: 'sawtooth', f0: 210, f1: 75, dur: 0.18, a: 0.003, peak: 0.22, filter: { type: 'lowpass', f0: 1400, f1: 300, q: 3 } });
    tone(V, { type: 'square', f0: 105, f1: 60, dur: 0.14, a: 0.003, peak: 0.08, filter: { type: 'lowpass', f0: 600 } });
  } },
  // Pickup: two-note coin blip
  pickup: { gap: 50, voices: 4, len: 0.22, pv: 0.3, fn(V) {
    tone(V, { type: 'square', f0: 988, dur: 0.06, a: 0.002, peak: 0.1, filter: { type: 'lowpass', f0: 5000 } });
    tone(V, { type: 'square', f0: 1319, at: 0.06, dur: 0.14, a: 0.002, peak: 0.1, filter: { type: 'lowpass', f0: 5000 } });
  } },
  // Level-up fanfare: brassy arpeggio into held chord
  levelUp: { gap: 800, voices: 1, len: 1.5, pv: 0, fn(V) {
    const brass = (m, at, dur, p) => {
      tone(V, { type: 'sawtooth', f0: NOTE(m), at, dur, a: 0.02, peak: p, filter: { type: 'lowpass', f0: 900, f1: 3500, q: 1 } });
      tone(V, { type: 'square', f0: NOTE(m), at, dur, a: 0.02, peak: p * 0.4, detune: 7, filter: { type: 'lowpass', f0: 2000 } });
    };
    [67, 72, 76].forEach((m, i) => brass(m, i * 0.11, 0.14, 0.11));
    [72, 76, 79, 84].forEach((m) => brass(m, 0.36, 0.95, 0.07));
    tone(V, { type: 'sine', f0: NOTE(48), at: 0.36, dur: 0.9, a: 0.02, peak: 0.25 });
    noise(V, { at: 0.36, dur: 0.6, a: 0.05, peak: 0.06, type: 'highpass', f0: 8000 });
  } },
  // Wave cleared: triumphant cadence (IV-V-I) with shimmer tail
  waveCleared: { gap: 800, voices: 1, len: 1.6, pv: 0, fn(V) {
    const chord = (ms, at, dur, p) => ms.forEach((m) =>
      tone(V, { type: 'triangle', f0: NOTE(m), at, dur, a: 0.01, peak: p }));
    chord([65, 69, 72], 0, 0.22, 0.09);
    chord([67, 71, 74], 0.2, 0.22, 0.09);
    chord([72, 76, 79, 84], 0.42, 1.0, 0.08);
    tone(V, { type: 'sine', f0: NOTE(48), at: 0.42, dur: 1.0, a: 0.01, peak: 0.22 });
    [96, 100, 103, 108].forEach((m, i) => tone(V, { type: 'sine', f0: NOTE(m), at: 0.5 + i * 0.06, dur: 0.5, a: 0.005, peak: 0.03 }));
  } },
};
// Aliases so swing1..3 can be addressed by name too.
DEFS.swing1 = { ...DEFS.swing, fn: (V) => DEFS.swing.fn(V, { variant: 1 }) };
DEFS.swing2 = { ...DEFS.swing, fn: (V) => DEFS.swing.fn(V, { variant: 2 }) };
DEFS.swing3 = { ...DEFS.swing, fn: (V) => DEFS.swing.fn(V, { variant: 3 }) };
DEFS.groundImpact = DEFS.axeImpact;

/** Cue names, grouped for docs/demo. */
export const CUES = Object.freeze([
  'swing1', 'swing2', 'swing3', 'arcaneHit', 'arcaneBreaker',
  'axeSwing', 'axeImpact', 'axe',
  'bowDraw', 'bowRelease', 'arrowHit', 'bow',
  'goldStrike', 'healChime',
  'crit', 'stagger', 'pickup', 'levelUp', 'waveCleared',
]);
export const CUE_ALIASES = Object.freeze({ swing: 'swing (opts.variant 1..3)', groundImpact: 'axeImpact' });

// ---------- throttling / voices ----------
const lastAt = Object.create(null);   // cue -> ms
const active = Object.create(null);   // cue -> live count
const throttleKey = (name) => (DEFS[name] && DEFS[name].fn && name.startsWith('swing') ? 'swing' : name);
const now = () => (globalThis.performance && performance.now ? performance.now() : Date.now());

function play(name, opts = {}) {
  try {
    const def = DEFS[name];
    if (!def) return false;
    if (muted || volume <= 0) return false;
    const c = getCtx();
    if (!c || !master) return false;
    if (c.state !== 'running') {
      try { const p = c.resume && c.resume(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
      if (c.state === 'closed') return false;
      // Suspended contexts silently queue; fine, but don't pile up.
    }
    const key = throttleKey(name);
    const ms = now();
    if (!opts.force) {
      if (lastAt[key] !== undefined && ms - lastAt[key] < def.gap) return false;
      if ((active[key] || 0) >= def.voices) return false;
    }
    lastAt[key] = ms;
    active[key] = (active[key] || 0) + 1;

    // Per-trigger bus: gain + optional pan.
    const bus = c.createGain();
    const gainMul = (opts.gain === undefined ? 1 : Math.max(0, +opts.gain || 0)) * rnd(0.88, 1.06);
    bus.gain.value = 1;
    let out = bus;
    if (opts.pan && c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, +opts.pan || 0));
      bus.connect(p); p.connect(master);
    } else bus.connect(master);

    const pv = def.pv || 0;
    const V = {
      ctx: c, out,
      t: c.currentTime + 0.005 + Math.max(0, +opts.delay || 0),
      rate: semis((+opts.pitch || 0) + (pv ? rnd(-pv, pv) : 0)),
      gain: gainMul,
    };
    def.fn(V, opts);

    const lifeMs = (def.len + (+opts.delay || 0)) * 1000 + 120;
    setTimeout(() => {
      active[key] = Math.max(0, (active[key] || 1) - 1);
      try { bus.disconnect(); } catch (_) {}
    }, lifeMs);
    return true;
  } catch (_) {
    return false;
  }
}

// ---------- public API ----------
function setVolume(v) {
  const n = +v;
  volume = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : volume;
  lsSet(LS_VOL, volume); applyMaster(); return volume;
}
function getVolume() { return volume; }
function setMuted(m) { muted = !!m; lsSet(LS_MUTE, muted ? '1' : '0'); applyMaster(); return muted; }
function isMuted() { return muted; }
function toggleMute() { return setMuted(!muted); }
function isUnlocked() { return !!(ctx && ctx.state === 'running'); }
function isSupported() { return !!(globalThis.AudioContext || globalThis.webkitAudioContext); }

export const sfx = {
  unlock, play, setVolume, getVolume, setMuted, isMuted, toggleMute, isUnlocked, isSupported,
  cues: CUES,
  // convenience
  swing: (n = 1, o = {}) => play('swing', { ...o, variant: n }),
  bowDraw: (o) => play('bowDraw', o), bowRelease: (o) => play('bowRelease', o), arrowHit: (o) => play('arrowHit', o),
  get context() { return ctx; },
};
export default sfx;
