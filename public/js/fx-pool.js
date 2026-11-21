/*
 * West Coast Heroes — pooled particles for the multiplayer renderer (client-only, cosmetic).
 *
 * - Fixed pool (no allocation while playing): particles are recycled from a free list.
 * - Frame-rate independent: positions advance by real elapsed ms (velocities are px/ms).
 * - Adaptive density: spawn counts are multiplied by `density` (0.35..1), which the arena lowers when
 *   frames get slow and raises again when they recover. Small screens start lower.
 * Kinds: 0 square, 1 crystal shard (diamond), 2 streak (short line along velocity), 3 soft glow dot (additive),
 *        4 dust puff (grows while fading).
 */
(function (root) {
    'use strict';
    function createPool(cap) {
        const P = [];
        for (let i = 0; i < cap; i++) P.push({ x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 1, size: 4, color: '#fff', kind: 0, grav: 0, drag: 0, rot: 0, vr: 0, alpha: 1, add: false });
        let n = 0; // live particles are P[0..n-1]
        const pool = {
            density: 1,
            cap,
            get count() { return n },
            spawned: 0,
            // Spawn up to `count` (scaled by density) particles; `init(p, j)` fills fields. Returns how many spawned.
            emit(count, init) {
                let want = count * pool.density;
                let c = Math.floor(want) + (Math.random() < want % 1 ? 1 : 0);
                let made = 0;
                while (c-- > 0 && n < cap) {
                    const p = P[n++];
                    p.vx = p.vy = p.grav = p.drag = p.rot = p.vr = 0; p.age = 0; p.alpha = 1; p.add = false; p.kind = 0; p.size = 4; p.life = 400;
                    init(p, made++);
                    pool.spawned++;
                }
                return made;
            },
            // Simple radial burst (compat with the old burst()): speed in px/16.7ms like before.
            burst(x, y, color, count, speed = 4, o) {
                return pool.emit(count, p => {
                    const s = speed / 16.7;
                    p.x = x; p.y = y; p.color = color;
                    p.vx = (Math.random() - .5) * 2 * s;
                    p.vy = (Math.random() - .5) * 2 * s * (o && o.flat || 1) - (o && o.lift !== undefined ? o.lift : 1) / 16.7;
                    p.life = (o && o.life || 380) + Math.random() * 200;
                    p.size = o && o.size || 4;
                    p.grav = (o && o.grav !== undefined ? o.grav : .04) * 2 / (16.7 * 16.7);
                    p.kind = o && o.kind || 0;
                    p.add = !!(o && o.add);
                    p.drag = o && o.drag || 0;
                    if (p.kind === 1) { p.rot = Math.random() * 6.28; p.vr = (Math.random() - .5) * .02 }
                });
            },
            update(dt) {
                if (dt > 50) dt = 50; // tab was hidden: don't teleport particles
                for (let i = n - 1; i >= 0; i--) {
                    const p = P[i];
                    p.age += dt;
                    if (p.age >= p.life) { const last = P[--n]; P[n] = p; P[i] = last; continue }
                    if (p.drag) { const f = Math.max(0, 1 - p.drag * dt); p.vx *= f; p.vy *= f }
                    p.vy += p.grav * dt;
                    p.x += p.vx * dt; p.y += p.vy * dt;
                    if (p.vr) p.rot += p.vr * dt;
                }
            },
            draw(g) {
                if (!n) return;
                let add = null;
                for (let i = 0; i < n; i++) {
                    const p = P[i], u = p.age / p.life;
                    if (p.add !== add) { add = p.add; g.globalCompositeOperation = add ? 'lighter' : 'source-over' }
                    g.globalAlpha = p.alpha * (p.kind === 4 ? (1 - u) * .55 : 1 - u * u);
                    g.fillStyle = p.color;
                    const s = p.size;
                    if (p.kind === 0) g.fillRect(Math.round(p.x - s / 2), Math.round(p.y - s / 2), s, s);
                    else if (p.kind === 1) { // crystal shard: rotated diamond
                        const c = Math.cos(p.rot), sn = Math.sin(p.rot), a = s * (1 - u * .5), b = a * .38;
                        g.beginPath();
                        g.moveTo(p.x + c * a, p.y + sn * a); g.lineTo(p.x - sn * b, p.y + c * b);
                        g.lineTo(p.x - c * a, p.y - sn * a); g.lineTo(p.x + sn * b, p.y - c * b);
                        g.closePath(); g.fill();
                    } else if (p.kind === 2) { // streak
                        g.strokeStyle = p.color; g.lineWidth = s * .5;
                        g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x - p.vx * 22, p.y - p.vy * 22); g.stroke();
                    } else { // 3 glow dot / 4 dust puff
                        const r = p.kind === 4 ? s * (1 + u * 1.6) : s * (1 - u * .4);
                        g.beginPath(); g.arc(p.x, p.y, r, 0, 6.2832); g.fill();
                    }
                }
                g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
            },
            clear() { n = 0 },
        };
        return pool;
    }
    root.WCHFxPool = { createPool };
    if (typeof module === 'object' && module.exports) module.exports = { createPool };
})(typeof window !== 'undefined' ? window : globalThis);
