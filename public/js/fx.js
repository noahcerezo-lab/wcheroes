/*
 * West Coast Heroes — fx.js: pooled particles, hit-stop and trauma screen-shake for Canvas 2D.
 * Dependency-free ES module. Zero allocation in update()/draw()/emit() once constructed.
 *
 * Usage
 * -----
 *   import { createFX } from './fx.js';
 *
 *   const fx = createFX({ capacity: 2048, budgetMs: 18 });   // budget = frame time that triggers density cuts
 *   const RED = fx.particles.color('#C40C2D');                // optional tint, register once (not per frame)
 *
 *   // on a hit:
 *   fx.particles.emit('spark', x, y, angleOfHit);             // (preset, x, y, angle = 0, scale = 1, colorIdx = -1)
 *   fx.particles.emit('slash', x, y, swingAngle, 1.2, RED);
 *   fx.shake.add(0.35);                                       // trauma 0..1 (offset ~ trauma^2)
 *   fx.hitStop(60);                                           // freeze ~60 ms (shorter with reduced motion)
 *
 *   let last = performance.now();
 *   function loop(now) {
 *       const realMs = now - last; last = now;
 *       const timeScale = fx.update(realMs);                  // measures frame time, steps hit-stop/shake/particles
 *       game.update(realMs * timeScale);                      // your sim runs on scaled time (0 while frozen)
 *       ctx.setTransform(1, 0, 0, 1, 0, 0);
 *       ctx.clearRect(0, 0, w, h);
 *       ctx.save();
 *       fx.shake.apply(ctx, w / 2, h / 2);                    // translate + tiny rotation about screen centre
 *       game.draw(ctx);
 *       fx.particles.draw(ctx);                               // normal pass, then additive ('lighter') pass
 *       ctx.restore();
 *       requestAnimationFrame(loop);
 *   }
 *   requestAnimationFrame(loop);
 *
 *   fx.setReducedMotion(true);   // manual override: true / false; null = follow the OS setting (live)
 *   fx.dispose();                // removes the matchMedia listener
 *
 * Presets: spark, slash, arcane, gold, heal, dust, arrowTrail, glint, levelUp (ring), levelUpMotes.
 *
 * Perf notes: particle state is struct-of-arrays typed arrays with swap-remove; hot scalar state also
 * lives in typed slots (V8 can box doubles written to object fields or passed between non-inlined
 * calls). Colours are a registered string table, so draw() never builds strings. Pass numbers, not
 * objects, to emit(); register tints with color() at load time.
 * Add your own with fx.particles.definePreset(name, { ...see DEFAULTS below }).
 */

// ---------------------------------------------------------------------------------------------
// Shapes / blend / fade modes
// ---------------------------------------------------------------------------------------------
export const SHAPE = { DOT: 0, STREAK: 1, RING: 2, GLINT: 3, SQUARE: 4 };
export const BLEND = { NORMAL: 0, ADD: 1 };
export const FADE = { OUT: 0, IN_OUT: 1, LINEAR: 2 };

const TAU = Math.PI * 2;

// Preset fields. Ranges are [min, max]. Units: px, px/s, s, 1/s.
const DEFAULTS = {
    count: 10,              // particles per emit at scale 1, full density
    life: [0.3, 0.6],       // seconds
    speed: [80, 220],       // px/s
    spread: TAU,            // radians around the emit angle (TAU = all directions)
    spawnRadius: 0,         // spawn jitter radius around (x, y)
    arcRadius: 0,           // > 0: spawn on an arc of this radius (slash); velocity becomes tangential + outward
    arcTangent: 0,          // tangential share of velocity for arc spawns (0..1)
    size: [2, 4],           // start size (px; ring = radius)
    sizeEnd: 0,             // end size multiplier of start size
    drag: 4,                // linear drag 1/s (velocity decays as exp(-drag * t))
    gravity: 0,             // px/s^2 (+ down)
    spin: [0, 0],           // rad/s
    shape: SHAPE.DOT,
    blend: BLEND.ADD,
    fade: FADE.OUT,
    stretch: 0.03,          // streak length = speed * stretch (s)
    colors: ['#ffffff'],
    minCount: 0,            // floor after density scaling (e.g. 1 for rings that must show)
    reducedScale: 0.35,     // extra count multiplier when reduced motion is on
};

// Hero palette (from heroes.json): Noah #1733C8/#FFC401, Destiny #C40C2D/#FEC200, Markie #3C2721.
export const PRESETS = {
    spark: {
        count: 14, life: [0.12, 0.32], speed: [220, 520], spread: 1.6, size: [1.5, 2.5], sizeEnd: 0.4,
        drag: 7, gravity: 600, shape: SHAPE.STREAK, stretch: 0.025, colors: ['#ffffff', '#fff3b0', '#ffd25a'],
    },
    slash: {
        count: 22, life: [0.14, 0.26], speed: [140, 260], spread: 2.4, arcRadius: 34, arcTangent: 0.75,
        size: [2, 3.5], sizeEnd: 0.2, drag: 9, shape: SHAPE.STREAK, stretch: 0.03,
        colors: ['#ffffff', '#dfe8ff', '#9fb4ff'],
    },
    arcane: {
        count: 26, life: [0.25, 0.55], speed: [90, 300], spread: TAU, spawnRadius: 6, size: [2, 4.5], sizeEnd: 0,
        drag: 5, gravity: -40, spin: [-6, 6], shape: SHAPE.DOT, colors: ['#1733C8', '#4f6dff', '#9ad8ff', '#ffffff'],
    },
    gold: {
        count: 20, life: [0.25, 0.5], speed: [120, 340], spread: TAU, size: [1.5, 3], sizeEnd: 0.3,
        drag: 6, gravity: 380, shape: SHAPE.STREAK, stretch: 0.02, colors: ['#FEC200', '#FFC401', '#fff1a8', '#ffffff'],
    },
    heal: {
        count: 12, life: [0.6, 1.1], speed: [10, 50], spread: TAU, spawnRadius: 18, size: [2, 4], sizeEnd: 0.5,
        drag: 2, gravity: -90, fade: FADE.IN_OUT, shape: SHAPE.DOT, colors: ['#9dffb0', '#e9ffd0', '#FEC200'],
    },
    dust: {
        count: 16, life: [0.35, 0.7], speed: [60, 200], spread: 2.6, spawnRadius: 8, size: [3, 7], sizeEnd: 1.8,
        drag: 5, gravity: 120, blend: BLEND.NORMAL, fade: FADE.OUT, colors: ['#8b7560', '#6b5847', '#a8937c'],
    },
    arrowTrail: {
        count: 2, life: [0.12, 0.22], speed: [5, 30], spread: TAU, size: [1.2, 2], sizeEnd: 0,
        drag: 3, shape: SHAPE.DOT, colors: ['#e8fff0', '#b8f5c8'], reducedScale: 0.5,
    },
    glint: {
        count: 4, life: [0.25, 0.45], speed: [0, 40], spread: TAU, spawnRadius: 6, size: [4, 8], sizeEnd: 0,
        drag: 4, spin: [-3, 3], shape: SHAPE.GLINT, fade: FADE.IN_OUT, colors: ['#ffffff', '#fff3b0'], minCount: 1,
    },
    levelUp: {
        count: 2, life: [0.55, 0.7], speed: [0, 0], size: [6, 10], sizeEnd: 9, drag: 0,
        shape: SHAPE.RING, fade: FADE.OUT, colors: ['#FEC200', '#ffffff'], minCount: 1, reducedScale: 1,
    },
    levelUpMotes: {
        count: 30, life: [0.6, 1.2], speed: [40, 160], spread: TAU, spawnRadius: 14, size: [1.5, 3], sizeEnd: 0.3,
        drag: 2.5, gravity: -120, shape: SHAPE.DOT, fade: FADE.IN_OUT, colors: ['#FEC200', '#fff1a8', '#ffffff'],
    },
};

// ---------------------------------------------------------------------------------------------
// Reduced motion (matchMedia with live listener + manual override)
// ---------------------------------------------------------------------------------------------
export class MotionPrefs {
    constructor() {
        this.system = false;
        this.override = null;          // null = follow system, true/false = forced
        this._mq = null;
        this._onChange = (e) => { this.system = !!e.matches; };
        if (typeof globalThis.matchMedia === 'function') {
            this._mq = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
            this.system = !!this._mq.matches;
            if (this._mq.addEventListener) this._mq.addEventListener('change', this._onChange);
            else if (this._mq.addListener) this._mq.addListener(this._onChange);
        }
    }
    get reduced() { return this.override === null ? this.system : this.override; }
    set(v) { this.override = (v === null || v === undefined) ? null : !!v; }
    dispose() {
        if (!this._mq) return;
        if (this._mq.removeEventListener) this._mq.removeEventListener('change', this._onChange);
        else if (this._mq.removeListener) this._mq.removeListener(this._onChange);
        this._mq = null;
    }
}

// ---------------------------------------------------------------------------------------------
// Particle pool (struct of arrays, swap-remove)
// ---------------------------------------------------------------------------------------------
export class ParticlePool {
    constructor(capacity = 2048, motion = null) {
        const n = capacity | 0;
        this.capacity = n;
        this.count = 0;
        this.motion = motion;
        this.x = new Float32Array(n);
        this.y = new Float32Array(n);
        this.vx = new Float32Array(n);
        this.vy = new Float32Array(n);
        this.life = new Float32Array(n);
        this.invLife = new Float32Array(n);
        this.size0 = new Float32Array(n);
        this.size1 = new Float32Array(n);
        this.drag = new Float32Array(n);
        this.grav = new Float32Array(n);
        this.rot = new Float32Array(n);
        this.spin = new Float32Array(n);
        this.stretch = new Float32Array(n);
        this.col = new Uint16Array(n);
        this.shape = new Uint8Array(n);
        this.blend = new Uint8Array(n);
        this.fade = new Uint8Array(n);

        this.colors = [];             // colour table: index -> CSS string (strings are reused, never rebuilt)
        this._colorIndex = new Map();
        this.presets = Object.create(null);
        this._d = new Float64Array([1]);   // density 0..1 (set by the FX adaptive controller)
        this._dt = new Float64Array(1);
        this._e = new Float64Array(4);      // emit params x, y, angle, scale     // step input (typed slot: passing doubles between calls can box)
        this.dropped = 0;                   // particles lost to a full pool (diagnostic, small int)
        this._seed = new Uint32Array([0x9e3779b9]);   // typed slot: a uint32 > 2^30 in a field would box per write
        for (const k in PRESETS) this.definePreset(k, PRESETS[k]);
    }

    get density() { return this._d[0]; }
    set density(v) { this._d[0] = v; }

    /** Register a CSS colour once; returns its index for emit(..., colorIdx). */
    color(css) {
        let i = this._colorIndex.get(css);
        if (i === undefined) {
            i = this.colors.length;
            this.colors.push(css);
            this._colorIndex.set(css, i);
        }
        return i;
    }

    definePreset(name, def) {
        const p = Object.assign({}, DEFAULTS, def);
        const cols = new Uint16Array(p.colors.length);
        for (let i = 0; i < p.colors.length; i++) cols[i] = this.color(p.colors[i]);
        this.presets[name] = {
            count: p.count, lifeMin: p.life[0], lifeMax: p.life[1], spdMin: p.speed[0], spdMax: p.speed[1],
            spread: p.spread, spawnRadius: p.spawnRadius, arcRadius: p.arcRadius, arcTangent: p.arcTangent,
            sizeMin: p.size[0], sizeMax: p.size[1], sizeEnd: p.sizeEnd, drag: p.drag, gravity: p.gravity,
            spinMin: p.spin[0], spinMax: p.spin[1], shape: p.shape, blend: p.blend, fade: p.fade,
            stretch: p.stretch, cols, minCount: p.minCount, reducedScale: p.reducedScale,
        };
        return this.presets[name];
    }

    _rand() {                          // xorshift32 -> [0, 1)
        const st = this._seed;
        let s = st[0] | 0;
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        st[0] = s;
        return st[0] / 4294967296;
    }

    /**
     * Emit a preset burst. angle = centre direction (radians), scale multiplies count and speed^0.5.
     * colorIdx >= 0 tints every particle with a colour from color(). Returns particles spawned.
     */
    emit(name, x, y, angle = 0, scale = 1, colorIdx = -1) {
        const p = this.presets[name];
        if (p === undefined) return 0;
        const E = this._e;
        E[0] = x; E[1] = y; E[2] = angle; E[3] = scale;
        return this._spawn(p, colorIdx);
    }

    _spawn(p, colorIdx) {                          // reads x, y, angle, scale from the typed slot _e
        const E = this._e;
        const x = E[0], y = E[1], angle = E[2], scale = E[3];
        let want = p.count * scale * this._d[0];
        if (this.motion !== null && this.motion.reduced) want *= p.reducedScale;
        let n = Math.floor(want);
        if (this._rand() < want - n) n++;          // stochastic rounding keeps small counts alive
        if (n < p.minCount) n = p.minCount;
        const free = this.capacity - this.count;
        if (n > free) { this.dropped += n - free; n = free; }
        if (n <= 0) return 0;

        const spdScale = Math.sqrt(scale);
        const ncol = p.cols.length;
        const arc = p.arcRadius * spdScale;
        for (let k = 0; k < n; k++) {
            const i = this.count++;
            const a = angle + (this._rand() - 0.5) * p.spread;
            const ca = Math.cos(a), sa = Math.sin(a);
            const spd = (p.spdMin + (p.spdMax - p.spdMin) * this._rand()) * spdScale;
            // Write straight into the typed arrays: mutable double locals that merge with tagged
            // params (x, y may be Smis) get boxed by the optimiser, which would allocate per particle.
            const X = this.x, Y = this.y, VX = this.vx, VY = this.vy;
            if (arc > 0) {
                // On the arc, velocity = mix of outward radial and tangential (swing direction).
                const t = p.arcTangent, r = 1 - t;
                X[i] = x + ca * arc; Y[i] = y + sa * arc;
                VX[i] = (ca * r - sa * t) * spd;
                VY[i] = (sa * r + ca * t) * spd;
            } else {
                X[i] = x; Y[i] = y;
                VX[i] = ca * spd; VY[i] = sa * spd;
            }
            if (p.spawnRadius > 0) {
                const ra = this._rand() * TAU, rr = p.spawnRadius * Math.sqrt(this._rand());
                X[i] += Math.cos(ra) * rr; Y[i] += Math.sin(ra) * rr;
            }
            const life = p.lifeMin + (p.lifeMax - p.lifeMin) * this._rand();
            const s0 = p.sizeMin + (p.sizeMax - p.sizeMin) * this._rand();
            this.life[i] = life; this.invLife[i] = 1 / life;
            this.size0[i] = s0; this.size1[i] = s0 * p.sizeEnd;
            this.drag[i] = p.drag; this.grav[i] = p.gravity;
            this.rot[i] = this._rand() * TAU;
            this.spin[i] = p.spinMin + (p.spinMax - p.spinMin) * this._rand();
            this.stretch[i] = p.stretch;
            this.col[i] = colorIdx >= 0 ? colorIdx : p.cols[(this._rand() * ncol) | 0];
            this.shape[i] = p.shape; this.blend[i] = p.blend; this.fade[i] = p.fade;
        }
        return n;
    }

    /** Emit along a segment (e.g. arrow trail from last to current position). */
    emitLine(name, x0, y0, x1, y1, steps = 3, scale = 1, colorIdx = -1) {
        const p = this.presets[name];
        if (p === undefined) return 0;
        let total = 0;
        const inv = steps > 1 ? 1 / (steps - 1) : 0;
        const E = this._e;
        for (let s = 0; s < steps; s++) {
            const t = s * inv;
            E[0] = x0 + (x1 - x0) * t; E[1] = y0 + (y1 - y0) * t;
            E[2] = Math.atan2(y1 - y0, x1 - x0) + Math.PI; E[3] = scale / steps;
            total += this._spawn(p, colorIdx);
        }
        return total;
    }

    /** Integrate with dt in seconds (scaled game time). Exact per step, so frame-rate independent. */
    update(dt) { this._dt[0] = dt; this._advance(); }

    _advance() {
        let dt = this._dt[0];
        if (!(dt > 0)) return;
        if (dt > 0.1) dt = 0.1;
        const X = this.x, Y = this.y, VX = this.vx, VY = this.vy, L = this.life;
        let i = 0;
        while (i < this.count) {
            const l = L[i] - dt;
            if (l <= 0) { this._kill(i); continue; }   // swap-remove, re-check slot i
            L[i] = l;
            // Exact closed-form step for dv/dt = -k*v + g (linear drag + gravity): identical
            // trajectories at any frame rate, unlike Euler.
            const k = this.drag[i], g = this.grav[i], vx = VX[i], vy = VY[i];
            if (k > 1e-4) {
                const e = Math.exp(-k * dt), w = (1 - e) / k, term = g / k;
                X[i] += vx * w;
                Y[i] += vy * w + term * (dt - w);
                VX[i] = vx * e;
                VY[i] = vy * e + term * (1 - e);
            } else {
                X[i] += vx * dt;
                Y[i] += (vy + 0.5 * g * dt) * dt;
                VY[i] = vy + g * dt;
            }
            this.rot[i] += this.spin[i] * dt;
            i++;
        }
    }

    _kill(i) {
        const j = --this.count;
        if (i === j) return;
        this.x[i] = this.x[j]; this.y[i] = this.y[j]; this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j];
        this.life[i] = this.life[j]; this.invLife[i] = this.invLife[j];
        this.size0[i] = this.size0[j]; this.size1[i] = this.size1[j];
        this.drag[i] = this.drag[j]; this.grav[i] = this.grav[j];
        this.rot[i] = this.rot[j]; this.spin[i] = this.spin[j]; this.stretch[i] = this.stretch[j];
        this.col[i] = this.col[j]; this.shape[i] = this.shape[j];
        this.blend[i] = this.blend[j]; this.fade[i] = this.fade[j];
    }

    clear() { this.count = 0; }

    /** Draw all particles: normal-blend pass, then additive pass. Restores composite op and alpha. */
    draw(ctx) {
        if (this.count === 0) return;
        const prevOp = ctx.globalCompositeOperation, prevAlpha = ctx.globalAlpha;
        ctx.lineCap = 'round';
        this._pass(ctx, BLEND.NORMAL);
        ctx.globalCompositeOperation = 'lighter';
        this._pass(ctx, BLEND.ADD);
        ctx.globalCompositeOperation = prevOp;
        ctx.globalAlpha = prevAlpha;
    }

    _pass(ctx, blend) {
        const C = this.colors;
        for (let i = 0; i < this.count; i++) {
            if (this.blend[i] !== blend) continue;
            const t = this.life[i] * this.invLife[i];          // 1 -> 0 over lifetime
            const f = this.fade[i];
            const a = f === 0 ? t * (2 - t) : f === 1 ? 4 * t * (1 - t) : t;
            if (a <= 0.004) continue;
            const s = this.size1[i] + (this.size0[i] - this.size1[i]) * t;
            if (s <= 0.05) continue;
            ctx.globalAlpha = a > 1 ? 1 : a;
            const css = C[this.col[i]];
            const x = this.x[i], y = this.y[i];
            switch (this.shape[i]) {
                case 1: { // STREAK along velocity
                    const k = this.stretch[i];
                    ctx.strokeStyle = css;
                    ctx.lineWidth = s;
                    ctx.beginPath();
                    ctx.moveTo(x, y);
                    ctx.lineTo(x - this.vx[i] * k, y - this.vy[i] * k);
                    ctx.stroke();
                    break;
                }
                case 2: { // RING (size = radius; thins as it fades)
                    ctx.strokeStyle = css;
                    ctx.lineWidth = 1 + 4 * t;
                    ctx.beginPath();
                    ctx.arc(x, y, s, 0, TAU);
                    ctx.stroke();
                    break;
                }
                case 3: { // GLINT: 4-point star from two thin diamonds
                    const c = Math.cos(this.rot[i]) * s, sn = Math.sin(this.rot[i]) * s;
                    const w = 0.18;
                    ctx.fillStyle = css;
                    ctx.beginPath();
                    ctx.moveTo(x + c, y + sn);
                    ctx.lineTo(x - sn * w, y + c * w);
                    ctx.lineTo(x - c, y - sn);
                    ctx.lineTo(x + sn * w, y - c * w);
                    ctx.closePath();
                    ctx.moveTo(x - sn, y + c);
                    ctx.lineTo(x - c * w, y - sn * w);
                    ctx.lineTo(x + sn, y - c);
                    ctx.lineTo(x + c * w, y + sn * w);
                    ctx.closePath();
                    ctx.fill();
                    break;
                }
                case 4: // SQUARE
                    ctx.fillStyle = css;
                    ctx.fillRect(x - s * 0.5, y - s * 0.5, s, s);
                    break;
                default: // DOT (tiny dots as rects: cheaper than arcs)
                    ctx.fillStyle = css;
                    if (s < 1.6) { ctx.fillRect(x - s * 0.5, y - s * 0.5, s, s); break; }
                    ctx.beginPath();
                    ctx.arc(x, y, s * 0.5, 0, TAU);
                    ctx.fill();
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Trauma screen shake (trauma^2, linear decay, smooth value noise)
// ---------------------------------------------------------------------------------------------
function hash16(i, seed) {              // integer lattice -> 0..65535 (returns a Smi: never boxed)
    let h = (Math.imul(i, 374761393) + Math.imul(seed, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return h & 0xffff;
}

export class Shake {
    constructor(opts = {}, motion = null) {
        this.maxOffset = opts.maxOffset ?? 14;      // px at trauma 1
        this.maxAngle = opts.maxAngle ?? 0.035;     // rad at trauma 1
        this.decay = opts.decay ?? 1.4;             // trauma per second
        this.frequency = opts.frequency ?? 22;      // noise samples per second
        this.motion = motion;
        // Mutable state lives in a typed array: writing doubles to object fields can box (allocate).
        this._s = new Float64Array(6);              // trauma, time, x, y, angle, dt-in
    }
    get trauma() { return this._s[0]; }
    get x() { return this._s[2]; }
    get y() { return this._s[3]; }
    get angle() { return this._s[4]; }
    /** Offsets in px / rad, for cameras that don't use ctx transforms. */
    get offsetX() { return this._s[2]; }
    get offsetY() { return this._s[3]; }
    /** Add trauma (0..1). Ignored when reduced motion is on. */
    add(amount) {
        if (this.motion !== null && this.motion.reduced) return;
        const t = this._s[0] + amount;
        this._s[0] = t > 1 ? 1 : t < 0 ? 0 : t;
    }
    /** dt in seconds (real time: shake keeps moving during hit-stop). */
    update(dt) { this._s[5] = dt; this._advance(); }

    _advance() {
        const S = this._s;
        let dt = S[5];
        if (!(dt > 0)) return;
        if (dt > 0.1) dt = 0.1;
        if (this.motion !== null && this.motion.reduced) S[0] = 0;
        S[1] += dt;
        if (S[1] > 1e5) S[1] -= 1e5;                // keep noise input precise on long sessions
        if (S[0] > 0) {
            const t = S[0] - this.decay * dt;
            S[0] = t < 0 ? 0 : t;
        }
        const s = S[0] * S[0];
        if (s === 0) { S[2] = 0; S[3] = 0; S[4] = 0; return; }
        // Smooth 1D value noise (smoothstep between hashed lattice values), one channel per axis.
        const n = S[1] * this.frequency;
        const fl = Math.floor(n), i0 = fl | 0, f = n - fl;
        const u = f * f * (3 - 2 * f);
        for (let c = 1; c <= 3; c++) {
            const a = hash16(i0, c), b = hash16(i0 + 1, c);
            const v = (a + (b - a) * u) / 32767.5 - 1;             // -1..1
            S[1 + c] = (c === 3 ? this.maxAngle : this.maxOffset) * s * v;
        }
    }
    /** Apply to ctx (call between save/restore). Rotation pivots on (cx, cy). */
    apply(ctx, cx = 0, cy = 0) {
        const S = this._s;
        if (S[2] === 0 && S[3] === 0 && S[4] === 0) return;
        if (S[4] !== 0) {
            ctx.translate(cx + S[2], cy + S[3]);
            ctx.rotate(S[4]);
            ctx.translate(-cx, -cy);
        } else {
            ctx.translate(S[2], S[3]);
        }
    }
    reset() { this._s[0] = 0; this._s[2] = 0; this._s[3] = 0; this._s[4] = 0; }
}

// ---------------------------------------------------------------------------------------------
// Hit-stop (freeze then short ramp back to full speed)
// ---------------------------------------------------------------------------------------------
export class HitStop {
    constructor(opts = {}, motion = null) {
        this.maxMs = opts.maxMs ?? 180;
        this.freezeScale = opts.freezeScale ?? 0;     // time scale while frozen (0 = full stop)
        this.rampFrac = opts.rampFrac ?? 0.3;          // last 30% eases back to 1
        this.reducedFactor = opts.reducedFactor ?? 0.35;
        this.reducedMaxMs = opts.reducedMaxMs ?? 50;
        this.motion = motion;
        this._s = new Float64Array([0, 0, 1, 0]);      // remaining ms, duration ms, scale, dt-in
    }
    get remaining() { return this._s[0]; }
    get scale() { return this._s[2]; }
    get active() { return this._s[0] > 0; }
    /** Start (or extend, never stack) a freeze. Returns the time scale now in effect. */
    trigger(ms) {
        let d = ms;
        if (this.motion !== null && this.motion.reduced) {
            d *= this.reducedFactor;
            if (d > this.reducedMaxMs) d = this.reducedMaxMs;
        }
        if (d > this.maxMs) d = this.maxMs;
        const S = this._s;
        if (d > S[0]) { S[0] = d; S[1] = d; }
        this._calc();
        return S[2];
    }
    _calc() {
        const S = this._s;
        if (S[0] <= 0) { S[2] = 1; return; }
        const ramp = S[1] * this.rampFrac;
        if (S[0] > ramp || ramp <= 0) { S[2] = this.freezeScale; return; }
        const u = 1 - S[0] / ramp;                     // 0 -> 1 over the ramp
        S[2] = this.freezeScale + (1 - this.freezeScale) * u * u;
    }
    /** Advance by real ms; returns time scale for this frame (0..1). */
    update(realMs) { this._s[3] = realMs; this._advance(); return this._s[2]; }

    _advance() {
        const S = this._s;
        if (S[0] > 0) {
            const r = S[0] - S[3];
            S[0] = r < 0 ? 0 : r;
        }
        this._calc();
    }
    reset() { this._s[0] = 0; this._s[2] = 1; }
}

// ---------------------------------------------------------------------------------------------
// Adaptive density (EMA of frame time with hysteresis)
// ---------------------------------------------------------------------------------------------
export class DensityController {
    constructor(opts = {}) {
        this.budgetMs = opts.budgetMs ?? 18;          // frames slower than this (EMA) cut density
        this.recoverMs = opts.recoverMs ?? this.budgetMs * 0.8;   // must be under this to recover
        this.alpha = opts.emaAlpha ?? 0.1;
        this.minDensity = opts.minDensity ?? 0.2;
        this.downStep = opts.downStep ?? 0.8;          // multiply on each cut
        this.upStep = opts.upStep ?? 0.1;              // add on each recovery
        this.downHoldMs = opts.downHoldMs ?? 250;      // sustained over-budget before a cut
        this.upHoldMs = opts.upHoldMs ?? 1500;         // sustained headroom before recovering
        this._s = new Float64Array([1000 / 60, 1, 0, 0, 0]);   // ema, density, overMs, underMs, frame-in
    }
    get ema() { return this._s[0]; }
    get density() { return this._s[1]; }
    set density(v) { this._s[1] = v; }
    sample(frameMs) { this._s[4] = frameMs; this._advance(); return this._s[1]; }

    _advance() {
        const S = this._s;
        const frameMs = S[4];
        if (!(frameMs > 0) || frameMs > 250) return;   // ignore tab switches / stalls
        S[0] += (frameMs - S[0]) * this.alpha;
        if (S[0] > this.budgetMs) {
            S[3] = 0;
            S[2] += frameMs;
            if (S[2] >= this.downHoldMs) {
                S[2] = 0;
                const d = S[1] * this.downStep;
                S[1] = d < this.minDensity ? this.minDensity : d;
            }
        } else if (S[0] < this.recoverMs) {
            S[2] = 0;
            S[3] += frameMs;
            if (S[3] >= this.upHoldMs) {
                S[3] = 0;
                const d = S[1] + this.upStep;
                S[1] = d > 0.999 ? 1 : d;
            }
        } else {                                       // dead band: hold
            S[2] = 0;
            S[3] = 0;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------------------------
export class FX {
    constructor(opts = {}) {
        this.motion = new MotionPrefs();
        if (opts.reducedMotion !== undefined) this.motion.set(opts.reducedMotion);
        this.particles = new ParticlePool(opts.capacity ?? 2048, this.motion);
        this.shake = new Shake(opts.shake || {}, this.motion);
        this.stop = new HitStop(opts.hitStop || {}, this.motion);
        this.density = new DensityController(opts);
        this._t = new Float64Array([1]);
    }
    get timeScale() { return this._t[0]; }
    get reducedMotion() { return this.motion.reduced; }
    /** true/false forces; null follows the OS setting. */
    setReducedMotion(v) { this.motion.set(v); if (this.motion.reduced) this.shake.reset(); }
    hitStop(ms) { this._t[0] = this.stop.trigger(ms); return this._t[0]; }
    /** Call once per frame with real elapsed ms. Returns the game time scale. */
    update(realMs) {
        if (!(realMs > 0)) realMs = 0;
        // Internal hand-off goes through typed slots + argument-free calls, so no doubles are boxed.
        this.density._s[4] = realMs; this.density._advance();
        this.particles._d[0] = this.density._s[1];
        this.stop._s[3] = realMs; this.stop._advance();
        const ts = this.stop._s[2];
        this._t[0] = ts;
        const realS = realMs * 0.001;
        this.shake._s[5] = realS; this.shake._advance();
        this.particles._dt[0] = realS * ts; this.particles._advance();
        return this._t[0];
    }
    draw(ctx) { this.particles.draw(ctx); }
    dispose() { this.motion.dispose(); }
}

export function createFX(opts) { return new FX(opts); }
