/*
 * West Coast Heroes — movement rules shared by the server and the browser.
 *
 * The server is the authority: it applies every input with stepHero(). The browser runs the SAME
 * function on its own inputs to predict where your hero is going (so movement feels instant) and
 * then corrects itself from the server's snapshot. Keeping one copy of the math means the
 * prediction and the server agree to the last decimal.
 */
(function (root) {
    'use strict';
    // Playable area in world units (960x540). Matches V19's walkable bounds (V19 used a 1440x810 world, i.e. x1.5).
    const ARENA = Object.freeze({ width: 960, height: 540, minX: 28, maxX: 932, minY: 80, maxY: 520 });
    const TICK_MS = 50;
    const HERO_SPEED = 5; // world units per input step (one input = one 50 ms step)
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0 };

    // Turn any client payload into a safe movement vector (length <= 1). Never returns NaN.
    function normalizeMove(x, y) {
        x = clamp(num(x), -1, 1);
        y = clamp(num(y), -1, 1);
        const len = Math.hypot(x, y);
        if (len > 1) { x /= len; y /= len }
        return { x, y };
    }

    // Apply one input step to a hero {x, y, facing}. Returns true if the hero moved.
    function stepHero(h, move) {
        const ox = h.x, oy = h.y;
        h.x = clamp(h.x + move.x * HERO_SPEED, ARENA.minX, ARENA.maxX);
        h.y = clamp(h.y + move.y * HERO_SPEED, ARENA.minY, ARENA.maxY);
        if (Math.abs(move.x) > 0.01) h.facing = move.x > 0 ? 1 : -1;
        return Math.abs(h.x - ox) + Math.abs(h.y - oy) > 0.01;
    }

    const api = { ARENA, TICK_MS, HERO_SPEED, clamp, normalizeMove, stepHero };
    root.WCHSim = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
