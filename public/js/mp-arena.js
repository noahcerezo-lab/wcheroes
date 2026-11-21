/*
 * West Coast Heroes — multiplayer arena renderer.
 *
 * Draws the server's battle snapshots with the V19 artwork from heroes-render.js:
 *   - V19 battlefield (Moonlit Temple and the other three zones)
 *   - V19 hero sprites with facing, idle bob and two-frame walk cycle
 *   - ground ring marking you (gold), other humans (blue) and AI teammates (green)
 *
 * Smoothing: the server sends 20 snapshots per second. Instead of jumping to each one,
 * we render slightly in the past (INTERP_DELAY_MS) and blend between the two snapshots
 * around that moment. Add ?interp=0 to the URL to turn this off for comparison.
 *
 * This file only draws. It never decides positions, damage or anything else: the server owns state.
 */
(function (root) {
    'use strict';
    const R = root.WCHRender;
    const H = root.WCHHeroes; // shared roster: slot order, colors, art theme
    const heroCfg = name => (H && H.HEROES.find(h => h.name === name)) || { color: '#cccccc' };
    const ART_THEME = (H && H.ART_THEME) || null;
    const TICK_MS = 50;
    const INTERP_DELAY_MS = 90; // ~1.8 server ticks: enough to hide normal network jitter
    const SNAP_DISTANCE = 140; // world units; bigger jumps (respawn/teleport) are not blended
    const ROLE_RING = { me: '#ffd279', human: '#80c9ff', ai: '#7ff0b6' };

    function lerp(a, b, t) { return a + (b - a) * t }

    function createArena(canvas, opts) {
        const g = canvas.getContext('2d');
        g.imageSmoothingEnabled = false;
        const interpEnabled = opts.interpolate !== false;
        const snaps = []; // {tick, at, heroes, zone, arena}
        let clockOffset = null; // estimated (client receive time - tick * TICK_MS)
        let running = false;
        const stats = { snapshots: 0, frames: 0 };

        function push(world) {
            if (!world || !Array.isArray(world.heroes)) return;
            const now = performance.now();
            const tick = Number(world.tick) || 0;
            if (snaps.length && tick < snaps[snaps.length - 1].tick) snaps.length = 0; // new battle
            if (snaps.length && tick === snaps[snaps.length - 1].tick) return;
            const sample = now - tick * TICK_MS;
            // Track the earliest-arriving snapshots (least delayed), relax slowly if latency rises.
            if (clockOffset === null || sample < clockOffset) clockOffset = sample;
            else clockOffset += (sample - clockOffset) * 0.02;
            snaps.push({ tick, at: now, heroes: world.heroes, zone: world.zone || 0, arena: world.arena });
            while (snaps.length > 40) snaps.shift();
            stats.snapshots++;
        }

        function reset() { snaps.length = 0; clockOffset = null }

        // Returns hero states interpolated for the given client time.
        function sample(now) {
            if (!snaps.length) return null;
            const latest = snaps[snaps.length - 1];
            if (!interpEnabled || snaps.length < 2) return { heroes: latest.heroes, zone: latest.zone, arena: latest.arena };
            const renderTick = (now - INTERP_DELAY_MS - clockOffset) / TICK_MS;
            let a = snaps[0], b = latest;
            if (renderTick >= latest.tick) { a = b = latest }
            else if (renderTick <= snaps[0].tick) { a = b = snaps[0] }
            else {
                for (let i = snaps.length - 1; i > 0; i--) {
                    if (snaps[i - 1].tick <= renderTick) { a = snaps[i - 1]; b = snaps[i]; break }
                }
            }
            const span = b.tick - a.tick;
            const t = span > 0 ? Math.max(0, Math.min(1, (renderTick - a.tick) / span)) : 1;
            const heroes = b.heroes.map((hb, i) => {
                const ha = a.heroes[i] || hb;
                if (Math.hypot(hb.x - ha.x, hb.y - ha.y) > SNAP_DISTANCE) return hb;
                return Object.assign({}, hb, { x: lerp(ha.x, hb.x, t), y: lerp(ha.y, hb.y, t) });
            });
            return { heroes, zone: b.zone, arena: b.arena };
        }

        function drawHud(view, room, myId) {
            const W = canvas.width;
            const zone = view.zone || 0;
            g.save();
            g.textAlign = 'center';
            g.fillStyle = '#ffe4ac';
            g.font = 'bold 16px monospace';
            g.fillText(R.ARENA_NAMES[zone % 4] + ' • ARENA ' + (1 + zone), W / 2, 31);
            // Squad panel (top-left), like V19's player panel.
            g.textAlign = 'left';
            g.fillStyle = '#161326d9';
            g.fillRect(18, 18, 300, 30 + view.heroes.length * 22);
            g.font = 'bold 15px monospace';
            g.fillStyle = '#fff';
            g.fillText('SQUAD ' + view.heroes.length + '/4', 30, 40);
            view.heroes.forEach((h, i) => {
                const human = room && room.players.find(p => p.hero === i);
                const y = 62 + i * 22;
                g.fillStyle = heroCfg(h.name).color;
                g.fillRect(30, y - 11, 10, 10);
                g.fillStyle = human && human.id === myId ? '#ffd279' : '#fff2c9';
                g.font = 'bold 13px monospace';
                g.fillText((heroCfg(h.name).slot || '') + ' ' + h.name + ' — ' + (human ? human.name : 'AI'), 48, y);
                g.fillStyle = '#292035';
                g.fillRect(232, y - 10, 74, 8);
                g.fillStyle = '#72dba3';
                g.fillRect(232, y - 10, 74 * Math.max(0, (h.hp || 0) / (h.maxHp || 100)), 8);
            });
            g.textAlign = 'right';
            g.fillStyle = '#fff2c9';
            g.font = '13px monospace';
            g.fillText('CO-OP MOVEMENT BUILD • COMBAT COMING NEXT', W - 24, 31);
            g.restore();
        }

        function drawHero(h, i, now, room, myId) {
            const S = R.WORLD_SCALE;
            const px = h.x * S, py = h.y * S;
            const human = room && room.players.find(p => p.hero === i);
            const role = human ? (human.id === myId ? 'me' : 'human') : 'ai';
            // Ground ring under the feet identifies who controls the hero.
            g.save();
            g.strokeStyle = ROLE_RING[role];
            g.lineWidth = role === 'me' ? 4 : 3;
            g.globalAlpha = .85;
            g.beginPath();
            g.ellipse(px, py + 3, 30 + Math.sin(now / 330 + i) * 2, 10, 0, 0, Math.PI * 2);
            g.stroke();
            g.restore();
            const color = heroCfg(h.name).color;
            const entity = { name: h.name, facing: h.facing === -1 ? -1 : 1, moving: !!h.moving, color, upgradeTier: h.upgradeTier || 0, theme: ART_THEME };
            R.drawSprite(g, px, py, color, false, h.name, now, entity);
            // Name + controller label and HP bar above the head (V19 ally style).
            g.save();
            g.fillStyle = '#292035';
            g.fillRect(px - 22, py - 86, 44, 5);
            g.fillStyle = '#72dba3';
            g.fillRect(px - 22, py - 86, 44 * Math.max(0, (h.hp || 0) / (h.maxHp || 100)), 5);
            g.textAlign = 'center';
            g.font = 'bold 12px monospace';
            g.fillStyle = role === 'me' ? '#ffd279' : '#fff2c9';
            g.fillText(h.name + (role === 'ai' ? ' AI' : role === 'me' ? ' (YOU)' : ''), px, py - 92);
            if (human && role !== 'me') {
                g.font = '11px monospace';
                g.fillStyle = '#bfe3ff';
                g.fillText(human.name, px, py + 22);
            }
            g.restore();
        }

        function frame() {
            if (!running) return;
            requestAnimationFrame(frame);
            const now = performance.now();
            const view = sample(now);
            if (!view) return;
            const room = opts.getRoom(), myId = opts.getMyId();
            g.setTransform(1, 0, 0, 1, 0, 0);
            R.drawArena(g, now, view.zone || 0);
            // Draw back-to-front so heroes lower on screen overlap those behind them.
            view.heroes.map((h, i) => [h, i]).sort((a, b) => a[0].y - b[0].y).forEach(([h, i]) => drawHero(h, i, now, room, myId));
            drawHud(view, room, myId);
            stats.frames++;
        }

        function start() { if (!running) { running = true; requestAnimationFrame(frame) } }
        function stop() { running = false }

        return { push, reset, start, stop, sample, stats, interpolating: interpEnabled };
    }

    root.WCHArena = { createArena, TICK_MS, INTERP_DELAY_MS };
})(window);
