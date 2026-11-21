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
    const HERO_SPEED = 5; // default world units per input step (one input = one 50 ms step)
    // World size decision (Phase C): the server simulates in 960x540 units; V19 used 1440x810 pixels.
    // So V19 distances divide by 1.5. V19 speeds are pixels per 60 fps frame: one 50 ms tick = 3 frames,
    // so a V19 speed becomes speed * 3 / 1.5 = speed * 2 units per tick (Noah 3.7 -> 7.4).
    const V19_SCALE = 1 / 1.5;
    const fromV19 = px => px * V19_SCALE;
    const speedFromV19 = v => Math.round(v * 2 * 100) / 100;
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

    // Movement feel (Phase C): velocity eases toward the stick instead of jumping. ACCEL is the share of
    // the gap to the target velocity closed per 50 ms input while a direction is held (full speed in
    // ~4 inputs = 200 ms); DECEL is the same when the stick is released (stops in ~4 inputs).
    const ACCEL = 0.5, DECEL = 0.55, STOP_EPS = 0.05;
    // Aim: 8 directions (0 = right, 2 = down, 4 = left, 6 = up; odd = diagonals). Attacks use it.
    const DIR8 = Array.from({ length: 8 }, (_, i) => Object.freeze({ x: Math.round(Math.cos(i * Math.PI / 4) * 1e6) / 1e6, y: Math.round(Math.sin(i * Math.PI / 4) * 1e6) / 1e6 }));
    const dir8Of = (x, y) => ((Math.round(Math.atan2(y, x) / (Math.PI / 4)) % 8) + 8) % 8;

    // Apply one input step to a hero {x, y, facing, vx, vy, aim}. Returns true if the hero moved.
    // Same function on server and client, so prediction replays match the server exactly.
    function stepHero(h, move, speed = HERO_SPEED) {
        const ox = h.x, oy = h.y;
        const held = Math.hypot(move.x, move.y) > 0.01; // move is already normalized (length <= 1): diagonals aren't faster
        const k = held ? ACCEL : DECEL;
        let vx = num(h.vx), vy = num(h.vy);
        vx += (move.x * speed - vx) * k;
        vy += (move.y * speed - vy) * k;
        if (!held && Math.hypot(vx, vy) < STOP_EPS) { vx = 0; vy = 0 }
        h.x = clamp(h.x + vx, ARENA.minX, ARENA.maxX);
        h.y = clamp(h.y + vy, ARENA.minY, ARENA.maxY);
        if (h.x !== ox + vx) vx = 0; // hit a wall: lose that component instead of sliding into it
        if (h.y !== oy + vy) vy = 0;
        h.vx = vx; h.vy = vy;
        if (Math.hypot(move.x, move.y) > 0.25) { // aim follows the direction you last pushed
            h.aim = dir8Of(move.x, move.y);
            if (Math.abs(DIR8[h.aim].x) > 0.01) h.facing = DIR8[h.aim].x > 0 ? 1 : -1;
        } else if (h.aim === undefined) h.aim = h.facing === -1 ? 4 : 0;
        return Math.abs(h.x - ox) + Math.abs(h.y - oy) > 0.01;
    }

    const api = { ARENA, TICK_MS, HERO_SPEED, V19_SCALE, fromV19, speedFromV19, clamp, normalizeMove, stepHero, ACCEL, DECEL, DIR8, dir8Of };
    root.WCHSim = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
