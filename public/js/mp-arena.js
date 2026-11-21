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

        function reset() { snaps.length = 0; clockOffset = null; seenActs.length = 0; fx.length = 0 }

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

        // Bigger sprites/labels when the canvas is shown small (phones), so heroes stay readable.
        function uiScale() {
            const cw = canvas.clientWidth || canvas.width;
            return Math.max(1, Math.min(1.7, 900 / cw));
        }
        const controllerOf = (room, i) => room && room.players.find(p => p.hero === i && p.connected);
        const reservedOf = (room, i) => room && room.players.find(p => p.hero === i && !p.connected);

        function drawHud(view, room, myId, k) {
            const W = canvas.width;
            const zone = view.zone || 0;
            g.save();
            g.scale(k, k);
            g.textAlign = 'center';
            g.fillStyle = '#ffe4ac';
            g.font = 'bold 16px monospace';
            g.fillText(R.ARENA_NAMES[zone % 4] + ' • ARENA ' + (1 + zone), W / 2 / k, 31);
            // Squad panel (top-left), like V19's player panel. Shows who is AI-controlled.
            g.textAlign = 'left';
            g.fillStyle = '#161326d9';
            g.fillRect(18, 18, 330, 30 + view.heroes.length * 22);
            g.font = 'bold 15px monospace';
            g.fillStyle = '#fff';
            const humans = view.heroes.filter((h, i) => controllerOf(room, i)).length;
            g.fillText('SQUAD • ' + humans + ' PLAYER' + (humans === 1 ? '' : 'S') + ' + ' + (view.heroes.length - humans) + ' AI', 30, 40);
            view.heroes.forEach((h, i) => {
                const human = controllerOf(room, i), waiting = reservedOf(room, i);
                const y = 62 + i * 22;
                g.fillStyle = heroCfg(h.name).color;
                g.fillRect(30, y - 11, 10, 10);
                g.fillStyle = human && human.id === myId ? '#ffd279' : human ? '#fff2c9' : '#a8f0c6';
                g.font = 'bold 13px monospace';
                const who = human ? human.name : waiting ? 'AI (' + waiting.name + ' ⟳)' : 'AI';
                g.fillText((heroCfg(h.name).slot || '') + ' ' + h.name + ' — ' + who, 48, y);
                g.fillStyle = '#292035';
                g.fillRect(262, y - 10, 74, 8);
                g.fillStyle = '#72dba3';
                g.fillRect(262, y - 10, 74 * Math.max(0, (h.hp || 0) / (h.maxHp || 100)), 8);
            });
            if (k === 1) {
                g.textAlign = 'right';
                g.fillStyle = '#fff2c9';
                g.font = '13px monospace';
                g.fillText('CO-OP MOVEMENT BUILD • COMBAT COMING NEXT', W - 24, 31);
            }
            g.restore();
        }

        // Attack/special are animation-only for now: the server validates the cooldown and bumps a
        // counter (attackN / specialN); every client plays the pose + a swoosh when it changes.
        const seenActs = [];
        const fx = [];
        function trackActions(view, now) {
            view.heroes.forEach((h, i) => {
                const prev = seenActs[i];
                if (prev && h.attackN > prev.a) fx.push({ kind: 'attack', i, start: now, life: 230 });
                if (prev && h.specialN > prev.s) fx.push({ kind: 'special', i, start: now, life: 560 });
                seenActs[i] = { a: h.attackN || 0, s: h.specialN || 0 };
            });
            for (let j = fx.length - 1; j >= 0; j--) if (now - fx[j].start > fx[j].life) fx.splice(j, 1);
        }
        function poseFor(i, now) {
            const out = {};
            for (const f of fx) if (f.i === i) {
                if (f.kind === 'attack') out.attackPoseUntil = f.start + f.life;
                else out.castPoseUntil = f.start + f.life;
            }
            return out;
        }
        function drawActionFx(h, i, now) {
            const color = heroCfg(h.name).color;
            for (const f of fx) {
                if (f.i !== i) continue;
                const t = (now - f.start) / f.life;
                g.save();
                g.globalAlpha = Math.max(0, 1 - t);
                g.strokeStyle = f.kind === 'attack' ? '#fff1c5' : color;
                g.shadowColor = color;
                g.shadowBlur = 14;
                if (f.kind === 'attack') {
                    const dir = h.facing === -1 ? -1 : 1;
                    g.lineWidth = 6;
                    g.beginPath();
                    g.arc(dir * 18, -34, 34 + t * 10, dir > 0 ? -1.1 : Math.PI - 1.1 + 2.2 * 0, dir > 0 ? 1.1 : Math.PI + 1.1);
                    g.stroke();
                } else {
                    g.lineWidth = 4;
                    g.beginPath();
                    g.ellipse(0, 0, 30 + t * 110, 10 + t * 36, 0, 0, Math.PI * 2);
                    g.stroke();
                }
                g.restore();
            }
        }

        function drawHero(h, i, now, room, myId, k) {
            const S = R.WORLD_SCALE;
            const px = h.x * S, py = h.y * S;
            const human = controllerOf(room, i), waiting = reservedOf(room, i);
            const role = human ? (human.id === myId ? 'me' : 'human') : 'ai';
            g.save();
            g.translate(Math.round(px), Math.round(py));
            g.scale(k, k);
            // Ground ring under the feet identifies who controls the hero.
            g.save();
            g.strokeStyle = ROLE_RING[role];
            g.lineWidth = role === 'me' ? 4 : 3;
            g.globalAlpha = .85;
            g.beginPath();
            g.ellipse(0, 3, 30 + Math.sin(now / 330 + i) * 2, 10, 0, 0, Math.PI * 2);
            g.stroke();
            g.restore();
            const color = heroCfg(h.name).color;
            const entity = Object.assign({ name: h.name, facing: h.facing === -1 ? -1 : 1, moving: !!h.moving, color, upgradeTier: h.upgradeTier || 0, theme: ART_THEME }, poseFor(i, now));
            R.drawSprite(g, 0, 0, color, false, h.name, now, entity);
            drawActionFx(h, i, now);
            // Name + controller label and HP bar above the head (V19 ally style).
            g.fillStyle = '#292035';
            g.fillRect(-22, -86, 44, 5);
            g.fillStyle = '#72dba3';
            g.fillRect(-22, -86, 44 * Math.max(0, (h.hp || 0) / (h.maxHp || 100)), 5);
            g.textAlign = 'center';
            g.font = 'bold 12px monospace';
            g.fillStyle = role === 'me' ? '#ffd279' : role === 'ai' ? '#a8f0c6' : '#fff2c9';
            g.fillText(h.name + (role === 'ai' ? ' AI' : role === 'me' ? ' (YOU)' : ''), 0, -92);
            const sub = role === 'human' ? human.name : waiting ? waiting.name + ' reconnecting…' : '';
            if (sub) {
                g.font = '11px monospace';
                g.fillStyle = waiting ? '#ffd9a8' : '#bfe3ff';
                g.fillText(sub, 0, 22);
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
            // Your own hero is drawn at its predicted position (instant response); others are interpolated.
            const local = opts.getLocalHero && opts.getLocalHero();
            if (local && view.heroes[local.index]) {
                view.heroes = view.heroes.slice();
                view.heroes[local.index] = Object.assign({}, view.heroes[local.index], { x: local.x, y: local.y, facing: local.facing, moving: local.moving });
            }
            trackActions(view, now);
            const k = uiScale();
            g.setTransform(1, 0, 0, 1, 0, 0);
            R.drawArena(g, now, view.zone || 0);
            // Draw back-to-front so heroes lower on screen overlap those behind them.
            view.heroes.map((h, i) => [h, i]).sort((a, b) => a[0].y - b[0].y).forEach(([h, i]) => drawHero(h, i, now, room, myId, k));
            drawHud(view, room, myId, k);
            stats.frames++;
        }

        function start() { if (!running) { running = true; requestAnimationFrame(frame) } }
        function stop() { running = false }

        return { push, reset, start, stop, sample, stats, interpolating: interpEnabled };
    }

    root.WCHArena = { createArena, TICK_MS, INTERP_DELAY_MS };
})(window);
