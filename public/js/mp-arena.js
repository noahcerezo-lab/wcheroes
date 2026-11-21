/*
 * West Coast Heroes — multiplayer arena renderer.
 *
 * Draws the server's battle snapshots:
 *   - V19 battlefield (Moonlit Temple and the other three zones) and V19 hero sprites
 *   - enemies with Draper's sprites (combat-art.js): Horned Acolyte, Lantern Wisp, Tomoe Archer,
 *     Temple Warden. Only idle loops exist, so walking (bob), windup (lean + telegraph), strike
 *     (lunge) and death (flash + fade) are procedural here.
 *   - combat effects from the server's per-tick events: hero attack/special sheets, hit sparks,
 *     crit flashes, damage numbers (#FFF2A0 normal, #FFD36D crit, #ADFFCB heal), heal/buff auras,
 *     stun/taunt marks, downed/revive rings, combo counter, wave banners and the game-over card.
 *
 * Smoothing: the server sends 20 snapshots per second. We render slightly in the past
 * (INTERP_DELAY_MS) and blend the two snapshots around that moment; heroes by slot, enemies by id.
 * Add ?interp=0 to the URL to turn this off for comparison.
 *
 * This file only draws. It never decides positions, damage or anything else: the server owns state.
 */
(function (root) {
    'use strict';
    const R = root.WCHRender;
    const A = root.WCHCombatArt;
    const H = root.WCHHeroes; // shared roster: slot order, colors, art theme
    const heroCfg = name => (H && H.HEROES.find(h => h.name === name)) || { color: '#cccccc' };
    const ART_THEME = (H && H.ART_THEME) || null;
    const TICK_MS = 50;
    const INTERP_DELAY_MS = 90; // ~1.8 server ticks: enough to hide normal network jitter
    const SNAP_DISTANCE = 140; // world units; bigger jumps (respawn/teleport) are not blended
    const ROLE_RING = { me: '#ffd279', human: '#80c9ff', ai: '#7ff0b6' };
    const S = (R && R.WORLD_SCALE) || 1.5; // world units -> canvas pixels
    const NUM = { normal: '#FFF2A0', crit: '#FFD36D', heal: '#ADFFCB', hurt: '#FF6B7D' };
    // Hero kit art (combat-vfx.md). Ranges/radii are world units from shared/combat.js.
    const KIT = {
        NOAH: { atk: 'noahCrescent', atkW: 110 * 2, spc: 'noahNova', range: 113 },
        DESTINY: { atk: 'destinySlash', atkW: 83 * 1.6, spc: 'destinyRally', range: 55 },
        MARKIE: { atk: 'markieCleave', atkW: 76 * 2.2, spc: 'markieQuake', range: 51 },
        ESPIRIT: { atk: 'espiritArrow', atkW: 60, spc: 'espiritStorm', range: 273 },
    };
    const SPECIAL_RADIUS = { NOAH: 140, DESTINY: 120, MARKIE: 107, ESPIRIT: 227 }; // fallback; events carry r
    const SLAM_R = 55; // Temple Warden shockwave radius (world units)

    function lerp(a, b, t) { return a + (b - a) * t }

    function createArena(canvas, opts) {
        const g = canvas.getContext('2d');
        g.imageSmoothingEnabled = false;
        const interpEnabled = opts.interpolate !== false;
        const snaps = []; // {tick, at, heroes, enemies, shots, zone, hud}
        let clockOffset = null; // estimated (client receive time - tick * TICK_MS)
        let running = false;
        const stats = { snapshots: 0, frames: 0 };

        // ---------- effects state ----------
        let overInfo = null, comboAt = -1e9;
        const fx = []; // timed effects: {kind, start, life, ...}
        const parts = [], texts = [], banners = [];
        const flashes = new Map(); // enemy id -> flash-until
        const ghosts = []; // dying enemies fading out
        const lastActs = []; // per hero {a, s} counters from the previous snapshot
        const enemyMotion = new Map(); // id -> {x, y, moveAt}

        function push(world) {
            if (!world || !Array.isArray(world.heroes)) return;
            const now = performance.now();
            const tick = Number(world.tick) || 0;
            if (snaps.length && tick < snaps[snaps.length - 1].tick) { snaps.length = 0; lastActs.length = 0 } // new battle
            if (snaps.length && tick === snaps[snaps.length - 1].tick) return;
            const sample = now - tick * TICK_MS;
            // Track the earliest-arriving snapshots (least delayed), relax slowly if latency rises.
            if (clockOffset === null || sample < clockOffset) clockOffset = sample;
            else clockOffset += (sample - clockOffset) * 0.02;
            const enemies = Array.isArray(world.enemies) ? world.enemies : [];
            const shots = Array.isArray(world.shots) ? world.shots : [];
            const prevSnap = snaps[snaps.length - 1];
            snaps.push({ tick, at: now, heroes: world.heroes, enemies, shots, zone: world.zone || 0, hud: world });
            while (snaps.length > 40) snaps.shift();
            stats.snapshots++;
            const ev = Array.isArray(world.ev) ? world.ev : [];
            trackActions(world.heroes, ev, now);
            for (const e of ev) onEvent(e, now, prevSnap);
        }

        function reset() {
            snaps.length = 0; clockOffset = null; lastActs.length = 0; fx.length = 0; parts.length = 0; texts.length = 0;
            banners.length = 0; flashes.clear(); ghosts.length = 0; enemyMotion.clear(); overInfo = null;
        }

        function burst(x, y, color, n, speed = 4) {
            for (let i = 0; i < n && parts.length < 260; i++) parts.push({ x, y, vx: (Math.random() - .5) * 2 * speed, vy: (Math.random() - .5) * 2 * speed - 1, born: performance.now(), life: 380 + Math.random() * 200, color });
        }
        function floatText(x, y, str, color, size, life = 870) { if (texts.length < 80) texts.push({ x, y, str, color, size, born: performance.now(), life, dx: (Math.random() - .5) * 14 }) } // ~26 V19 ticks
        function latestHero(i) { const s = snaps[snaps.length - 1]; return s && s.heroes[i] }

        // Attack/special animations come from the hero's attackN/specialN counters (robust to a missed
        // packet). Espirit's arrow flies to the enemy she hit this tick, or full range on a miss.
        function trackActions(heroes, ev, now) {
            heroes.forEach((h, i) => {
                const prev = lastActs[i];
                lastActs[i] = { a: h.attackN || 0, s: h.specialN || 0 };
                if (!prev) return;
                if (h.attackN > prev.a) {
                    const f = { kind: 'attack', i, name: h.name, start: now, life: 300, facing: h.facing === -1 ? -1 : 1, x: h.x, y: h.y };
                    if (h.name === 'ESPIRIT') {
                        const hit = ev.find(e => e.t === 'hit' && e.h === i);
                        f.tx = hit ? hit.x : h.x + f.facing * KIT.ESPIRIT.range;
                        f.ty = hit ? hit.y : h.y;
                        f.life = Math.max(120, Math.hypot(f.tx - h.x, f.ty - h.y) * S / 3.2);
                    }
                    fx.push(f);
                }
                if (h.specialN > prev.s) fx.push({ kind: 'cast', i, start: now, life: 560 });
            });
        }

        function onEvent(e, now, prevSnap) {
            switch (e.t) {
                case 'hit': {
                    flashes.set(e.id, now + 200);
                    const px = e.x * S, py = e.y * S - 40;
                    const sheet = e.c ? (e.h === 3 ? 'espiritCrit' : 'critFlash') : 'hitSpark';
                    fx.push({ kind: 'sheet', key: sheet, x: px + (Math.random() - .5) * 10, y: py + (Math.random() - .5) * 10, w: e.c ? 64 : 34, start: now, life: A ? A.duration(sheet) : 220 });
                    burst(px, py, e.c ? '#FFD36D' : '#FFF2B5', e.c ? 9 : 5);
                    floatText(px, py - 30, String(e.d) + (e.c ? '!' : ''), e.c ? NUM.crit : NUM.normal, e.c ? 24 : 18);
                    break;
                }
                case 'kill': {
                    burst(e.x * S, e.y * S - 30, '#FF6C78', 13, 5); // enemies.md death burst
                    const last = prevSnap && prevSnap.enemies.find(v => v[0] === e.id);
                    if (last) ghosts.push({ e: last.slice(), start: now, life: 380 });
                    if (e.combo >= 2) comboAt = now;
                    break;
                }
                case 'hurt': { const h = latestHero(e.h); if (h) { floatText(h.x * S, h.y * S - 95, '-' + e.d, NUM.hurt, 17); burst(h.x * S, h.y * S - 40, '#FF6574', 4) } break }
                case 'heal': {
                    const h = latestHero(e.h);
                    if (!h) break;
                    floatText(h.x * S, h.y * S - 100, '+' + e.n, NUM.heal, e.n >= 10 ? 20 : 14, e.n >= 10 ? 870 : 600);
                    if (e.n >= 10) fx.push({ kind: 'sheet', key: 'healAura', follow: e.h, w: 72, start: now, life: A ? A.duration('healAura') : 540 });
                    break;
                }
                case 'spc': {
                    const h = latestHero(e.h);
                    if (!h) break;
                    const r = (e.r || SPECIAL_RADIUS[h.name] || 140) * S;
                    fx.push({ kind: 'special', name: h.name, x: h.x * S, y: h.y * S, r, start: now, life: 700 });
                    banners.push({ str: h.name + ' • ' + e.k, color: heroCfg(h.name).color, born: now, life: 1300, small: true });
                    break;
                }
                case 'slam': fx.push({ kind: 'floor', key: 'impact', x: e.x * S, y: e.y * S, r: (e.r || SLAM_R) * S, start: now, life: A ? A.duration('impact') : 420 }); break;
                case 'down': { const h = latestHero(e.h); if (h) banners.push({ str: h.name + ' IS DOWN — STAND NEXT TO THEM TO REVIVE', color: '#ff8a8a', born: now, life: 2200, small: true }); break }
                case 'revive': {
                    const h = latestHero(e.h);
                    if (!h) break;
                    fx.push({ kind: 'floor', key: 'reviveRing', x: h.x * S, y: h.y * S, r: 60, start: now, life: A ? A.duration('reviveRing') : 640 });
                    burst(h.x * S, h.y * S - 40, '#A5FFBF', 16, 5);
                    banners.push({ str: h.name + ' REVIVED!', color: '#A5FFBF', born: now, life: 1500, small: true });
                    break;
                }
                case 'wave': banners.push({ str: 'WAVE ' + e.n + (e.boss ? ' • BOSS WAVE' : ''), color: '#FFD36D', born: now, life: 2000 }); break;
                case 'clear': banners.push({ str: 'WAVE ' + e.n + ' CLEARED • +25 HP', color: '#9ef0c0', born: now, life: 2200 }); break;
                case 'over': overInfo = { wave: e.wave, score: e.score, kills: e.kills, at: now }; break;
            }
        }

        // Returns the world interpolated for the given client time.
        function sample(now) {
            if (!snaps.length) return null;
            const latest = snaps[snaps.length - 1];
            if (!interpEnabled || snaps.length < 2) return { heroes: latest.heroes, enemies: latest.enemies, shots: latest.shots, zone: latest.zone, hud: latest.hud };
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
            // Enemies and shots are matched by id (they appear and vanish between snapshots).
            const blend = (listA, listB) => {
                const prev = new Map(listA.map(e => [e[0], e]));
                return listB.map(eb => {
                    const ea = prev.get(eb[0]);
                    if (!ea || Math.hypot(eb[2] - ea[2], eb[3] - ea[3]) > SNAP_DISTANCE) return eb;
                    const out = eb.slice(); out[2] = lerp(ea[2], eb[2], t); out[3] = lerp(ea[3], eb[3], t); return out;
                });
            };
            return { heroes, enemies: blend(a.enemies, b.enemies), shots: blend(a.shots, b.shots), zone: b.zone, hud: b.hud };
        }

        // Bigger sprites/labels when the canvas is shown small (phones), so units stay readable.
        function uiScale() {
            const cw = canvas.clientWidth || canvas.width;
            return Math.max(1, Math.min(1.7, 900 / cw));
        }
        const controllerOf = (room, i) => room && room.players.find(p => p.hero === i && p.connected);
        const reservedOf = (room, i) => room && room.players.find(p => p.hero === i && !p.connected);

        // ---------- HUD ----------
        function drawHud(view, room, myId, k, now) {
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
                g.fillStyle = h.state ? '#8a3a4a' : (h.hp / (h.maxHp || 100) < .3 ? '#f0a05a' : '#72dba3');
                g.fillRect(262, y - 10, 74 * Math.max(0, (h.hp || 0) / (h.maxHp || 100)), 8);
                if (h.state) { g.fillStyle = '#ff8a8a'; g.font = 'bold 10px monospace'; g.fillText('DOWN', 285, y) }
            });
            // Score / wave panel (top-right), V19 layout.
            const hud = view.hud || {};
            g.textAlign = 'right';
            g.fillStyle = '#161326d9';
            g.fillRect(W / k - 300, 18, 282, 74);
            g.fillStyle = '#fff';
            g.font = 'bold 17px monospace';
            g.fillText('WAVE ' + (hud.wave || 0) + '   SCORE ' + (hud.score || 0), W / k - 30, 42);
            g.font = '13px monospace';
            g.fillStyle = '#fff2c9';
            const mine = view.heroes.findIndex((h, i) => { const p = controllerOf(room, i); return p && p.id === myId });
            const status = hud.ws ? 'ENEMIES LEFT ' + (hud.left || 0) : 'NEXT WAVE IN ' + Math.ceil((hud.next || 0) / 1000) + 's';
            g.fillText(status + '   KOs ' + (hud.kills || 0), W / k - 30, 62);
            if (mine >= 0) {
                const cd = view.heroes[mine].cd || 0;
                g.fillStyle = cd ? '#c9b8e8' : '#9ef0c0';
                g.fillText('SPECIAL ' + (cd ? (cd / 10).toFixed(1) + 's' : 'READY'), W / k - 30, 82);
            }
            if (hud.combo >= 2) { // combo text + Draper's combo sting underlay on each new KO
                const cx = W / k - 160, cy = 112;
                if (A) A.play(g, 'comboBurst', now - comboAt, cx, cy, 240);
                g.textAlign = 'center';
                g.fillStyle = '#FFCB83';
                g.font = 'bold 18px monospace';
                g.lineWidth = 4; g.strokeStyle = '#0B0A18';
                const str = 'COMBO x' + Math.min(5, 1 + Math.floor(hud.combo / 4)) + ' • ' + hud.combo + ' KOs';
                g.strokeText(str, cx, cy + 6); g.fillText(str, cx, cy + 6);
            }
            g.restore();
        }

        function drawBanners(now, k) {
            const W = canvas.width;
            let y = 190;
            for (let j = banners.length - 1; j >= 0; j--) if (now - banners[j].born > banners[j].life) banners.splice(j, 1);
            const big = banners.filter(b => !b.small).slice(-1), small = banners.filter(b => b.small).slice(-3);
            g.save();
            g.textAlign = 'center';
            for (const b of big) {
                const t = (now - b.born) / b.life;
                g.globalAlpha = Math.min(1, (1 - t) * 3);
                g.font = 'bold ' + Math.round(44 * Math.min(k, 1.4)) + 'px monospace';
                g.lineWidth = 6; g.strokeStyle = '#111025'; g.strokeText(b.str, W / 2, y);
                g.fillStyle = b.color; g.fillText(b.str, W / 2, y);
                y += 50 * Math.min(k, 1.4);
            }
            for (const b of small) {
                const t = (now - b.born) / b.life;
                g.globalAlpha = Math.min(1, (1 - t) * 3);
                g.font = 'bold ' + Math.round(20 * Math.min(k, 1.4)) + 'px monospace';
                g.lineWidth = 4; g.strokeStyle = '#111025'; g.strokeText(b.str, W / 2, y);
                g.fillStyle = b.color; g.fillText(b.str, W / 2, y);
                y += 28 * Math.min(k, 1.4);
            }
            g.restore();
        }

        function drawGameOver(now, hud) {
            if (!(hud && hud.over) && !overInfo) return;
            const info = overInfo || { wave: hud.wave, score: hud.score, kills: hud.kills, at: now };
            const W = canvas.width, Hh = canvas.height;
            g.save();
            g.globalAlpha = Math.min(.72, (now - info.at) / 900);
            g.fillStyle = '#0b0914';
            g.fillRect(0, 0, W, Hh);
            g.globalAlpha = Math.min(1, (now - info.at) / 600);
            g.textAlign = 'center';
            g.fillStyle = '#ff8a8a';
            g.font = 'bold 72px monospace';
            g.fillText('SQUAD DEFEATED', W / 2, Hh / 2 - 40);
            g.fillStyle = '#ffe4ac';
            g.font = 'bold 28px monospace';
            g.fillText('WAVE ' + info.wave + '  •  SCORE ' + info.score + '  •  ' + info.kills + ' KOs', W / 2, Hh / 2 + 14);
            g.font = '20px monospace';
            g.fillStyle = '#fff2c9';
            g.fillText('Returning to the lobby…', W / 2, Hh / 2 + 56);
            g.restore();
        }

        // ---------- effects ----------
        function expire(now) {
            for (let j = fx.length - 1; j >= 0; j--) if (now - fx[j].start > fx[j].life) fx.splice(j, 1);
            for (let j = ghosts.length - 1; j >= 0; j--) if (now - ghosts[j].start > ghosts[j].life) ghosts.splice(j, 1);
            for (const [id, until] of flashes) if (until < now) flashes.delete(id);
        }
        function poseFor(i, now) {
            const out = {};
            for (const f of fx) if (f.i === i) {
                if (f.kind === 'attack') out.attackPoseUntil = f.start + 230;
                else if (f.kind === 'cast') out.castPoseUntil = f.start + f.life;
            }
            return out;
        }
        // Floor layer (drawn under units): special rings, slam impacts, revive rings. Never X-flipped.
        function drawFloorFx(now) {
            for (const f of fx) {
                const el = now - f.start;
                if (f.kind === 'special') {
                    const key = KIT[f.name] && KIT[f.name].spc;
                    const w = f.r * 2; // world radius wins over the 64px motif
                    const sq = f.name === 'NOAH' ? .5 : 1; // nova is drawn as a round rune; lay it on the floor
                    const drawn = A && A.play(g, key, el * (A.duration(key) / f.life), f.x, f.y, w, w * sq);
                    if (!drawn) { // fallback ring while sheets load
                        const t = el / f.life, color = heroCfg(f.name).color;
                        g.save(); g.globalAlpha = Math.max(0, .9 * (1 - t)); g.strokeStyle = color; g.lineWidth = 7;
                        g.beginPath(); g.ellipse(f.x, f.y, f.r * (.25 + .75 * t), f.r * (.25 + .75 * t) * .42, 0, 0, Math.PI * 2); g.stroke(); g.restore();
                    }
                } else if (f.kind === 'floor' && A) {
                    A.play(g, f.key, el, f.x, f.y, f.r * 2, f.r * 2 * .5);
                }
            }
        }
        // Over-unit layer: attack trails, Espirit arrows, sparks, auras that follow a hero.
        function drawActionFx(view, now, k) {
            for (const f of fx) {
                const el = now - f.start;
                if (f.kind === 'attack' && A) {
                    const h = view.heroes[f.i] || f, kit = KIT[f.name];
                    if (!kit) continue;
                    if (f.name === 'ESPIRIT') { // projectile from the bow to the target
                        const t = Math.min(1, el / f.life);
                        const sx = f.x * S + f.facing * 20, sy = f.y * S - 38, ex = f.tx * S, ey = f.ty * S - 38;
                        g.save();
                        g.translate(lerp(sx, ex, t), lerp(sy, ey, t));
                        g.rotate(Math.atan2(ey - sy, ex - sx));
                        A.loop(g, 'espiritArrow', now, 0, 0, kit.atkW * k);
                        g.restore();
                    } else {
                        const dir = h.facing === -1 ? -1 : 1;
                        const ox = f.name === 'MARKIE' ? 0 : dir * kit.atkW * .28 * k;
                        A.play(g, kit.atk, el, h.x * S + ox, h.y * S - 34 * k, kit.atkW * k, null, dir < 0);
                    }
                } else if (f.kind === 'sheet' && A) {
                    let x = f.x, y = f.y;
                    if (f.follow !== undefined) { const h = view.heroes[f.follow]; if (!h) continue; x = h.x * S; y = h.y * S }
                    A.play(g, f.key, el, x, y, f.w * k);
                }
            }
        }
        function drawParticles(now) {
            for (let j = parts.length - 1; j >= 0; j--) {
                const p = parts[j], age = now - p.born;
                if (age > p.life) { parts.splice(j, 1); continue }
                const f = age / 16.7;
                g.globalAlpha = 1 - age / p.life;
                g.fillStyle = p.color;
                g.fillRect(Math.round(p.x + p.vx * f), Math.round(p.y + p.vy * f + 0.04 * f * f), 5, 5);
            }
            g.globalAlpha = 1;
        }
        function drawNumbers(now) {
            g.textAlign = 'center';
            for (let j = texts.length - 1; j >= 0; j--) {
                const t = texts[j], age = now - t.born;
                if (age > t.life) { texts.splice(j, 1); continue }
                const u = age / t.life;
                const pop = age < 100 ? 1.25 - age / 400 : 1; // crit/normal pop on the first ticks
                g.globalAlpha = u > .77 ? (1 - u) / .23 : 1; // fade on the last ~6 ticks
                g.font = 'bold ' + Math.round(t.size * pop) + 'px monospace';
                g.lineWidth = 4; g.strokeStyle = '#0B0A18';
                const tx = t.x + t.dx * u, ty = t.y - 20 * u;
                g.strokeText(t.str, tx, ty);
                g.fillStyle = t.color; g.fillText(t.str, tx, ty);
            }
            g.globalAlpha = 1;
        }

        // ---------- units ----------
        function drawHero(h, i, now, room, myId, k) {
            const px = h.x * S, py = h.y * S;
            const human = controllerOf(room, i), waiting = reservedOf(room, i);
            const role = human ? (human.id === myId ? 'me' : 'human') : 'ai';
            const color = heroCfg(h.name).color;
            g.save();
            g.translate(Math.round(px), Math.round(py));
            g.scale(k, k);
            if (h.state && A && A.ready('downedRing')) A.loop(g, 'downedRing', now, 0, 4, 80, 28); // floor ring, not flipped
            else { // ground ring under the feet identifies who controls the hero
                g.save();
                g.strokeStyle = ROLE_RING[role];
                g.lineWidth = role === 'me' ? 4 : 3;
                g.globalAlpha = .85;
                g.beginPath();
                g.ellipse(0, 3, 30 + Math.sin(now / 330 + i) * 2, 10, 0, 0, Math.PI * 2);
                g.stroke();
                g.restore();
            }
            const entity = Object.assign({ name: h.name, facing: h.facing === -1 ? -1 : 1, moving: !!h.moving && !h.state, color, upgradeTier: h.upgradeTier || 0, theme: ART_THEME }, poseFor(i, now));
            if (h.state) { // downed: lying on the ground, greyed, with a revive progress ring
                g.save();
                g.globalAlpha = .6;
                g.rotate(-Math.PI / 2 * (h.facing === -1 ? -1 : 1));
                g.translate(0, 20);
                R.drawSprite(g, 0, 0, color, false, h.name, 0, Object.assign(entity, { moving: false }));
                g.restore();
                g.save();
                g.strokeStyle = '#3a2a3a'; g.lineWidth = 6;
                g.beginPath(); g.arc(0, -40, 26, 0, Math.PI * 2); g.stroke();
                g.strokeStyle = '#A5FFBF';
                g.beginPath(); g.arc(0, -40, 26, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (h.rv || 0) / 100); g.stroke();
                g.fillStyle = '#ffb3b3'; g.font = 'bold 12px monospace'; g.textAlign = 'center';
                g.fillText(h.rv ? 'REVIVING' : 'DOWN', 0, -36);
                g.restore();
            } else R.drawSprite(g, 0, 0, color, false, h.name, now, entity);
            if (!h.state && (h.buff || h.shield) && A) A.loop(g, 'buffAura', now, 0, -34, 58, null, false, .85, i * 90); // rally buff / Markie shield
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

        // Enemy: Draper idle loop + procedural motion. flags: 1 stunned, 2 taunted, 4 windup, 8 struck.
        function drawEnemy(e, now, k, fade) {
            const [id, type, ex, ey, hpPct, facing, flags] = e;
            const art = (A && A.ENEMY_ART[type]) || { key: 'acolyte', w: 50 };
            const flash = (flashes.get(id) || 0) > now;
            let m = enemyMotion.get(id);
            if (!m) { m = { x: ex, y: ey, moveAt: 0 }; enemyMotion.set(id, m) }
            if (Math.hypot(ex - m.x, ey - m.y) > 0.3) { m.moveAt = now; m.x = ex; m.y = ey }
            const walking = now - m.moveAt < 120;
            const dir = facing === -1 ? -1 : 1;
            let ox = 0, oy = 0, lean = 0;
            if (art.key === 'wisp') oy = Math.sin(now / 260 + id) * 4 - 6; // hovers
            else if (walking) oy = -Math.abs(Math.sin(now / 90 + id)) * 3; // step bob
            if (flags & 4) lean = -0.08 * dir; // windup: lean back
            if (flags & 8) { ox = dir * 7; lean = 0.1 * dir } // strike: lunge
            if (flash) ox += Math.sin(now / 34) * 3; // hurt shake
            g.save();
            g.translate(Math.round(ex * S), Math.round(ey * S));
            g.scale(k, k);
            if (fade !== undefined) g.globalAlpha = fade;
            // Telegraphs on the floor (enemies.md): warden = warning ring at the slam radius.
            if ((flags & 4) && art.key === 'warden' && A) A.loop(g, 'warning', now, 0, 0, SLAM_R * S * 2 / k, SLAM_R * S / k);
            g.fillStyle = '#0006';
            g.beginPath(); g.ellipse(0, 1, art.w * .36, 6, 0, 0, Math.PI * 2); g.fill();
            g.save();
            g.translate(ox, oy);
            g.rotate(lean);
            const drawn = A && A.loop(g, art.key, now, 0, 2, art.w, null, dir < 0, undefined, id * 37);
            if (!drawn) R.drawSprite(g, 0, 0, '#000', true, '', now, { facing: dir, hurt: flash ? 6 : 0, flash: flash ? 1 : 0 }); // V19 fallback while loading
            if (drawn && (flash || fade !== undefined)) { // hit flash: brighten only the sprite's own pixels
                g.globalCompositeOperation = 'lighter';
                g.globalAlpha = (fade !== undefined ? fade : 1) * .45;
                A.loop(g, art.key, now, 0, 2, art.w, null, dir < 0, undefined, id * 37);
                g.globalCompositeOperation = 'source-over';
                g.globalAlpha = fade !== undefined ? fade : 1;
            }
            if ((flags & 4) && art.key !== 'warden') { // windup glint: visor flare / bow draw / lantern flare
                g.globalAlpha = .55 + Math.sin(now / 40) * .3;
                g.fillStyle = art.key === 'wisp' ? '#FFCF8B' : '#FF5A7A';
                const hy = art.key === 'wisp' ? -28 : -48;
                g.fillRect(-6 + dir * 4, hy, 12, 4);
                g.globalAlpha = 1;
            }
            g.restore();
            const top = art.key === 'warden' ? -88 : art.key === 'wisp' ? -56 : -68;
            if (hpPct < 100 && fade === undefined) {
                g.fillStyle = '#292035'; g.fillRect(-20, top, 40, 4);
                g.fillStyle = '#ff5d73'; g.fillRect(-20, top, 40 * hpPct / 100, 4);
            }
            if (A && fade === undefined) {
                if (flags & 1) A.loop(g, 'stunStar', now, 0, top - 4, 30);
                if (flags & 2) A.loop(g, 'tauntMark', now, (flags & 1) ? 18 : 0, top - 6, 26);
            }
            g.restore();
        }

        function drawShots(shots, k) {
            for (const p of shots) {
                const [, type, x, y, vx, vy] = p;
                const art = A && A.ENEMY_ART[type];
                g.save();
                g.translate(x * S, y * S - 36);
                g.scale(k, k);
                if (art && art.key === 'wisp') { // slow ember bolt
                    g.fillStyle = '#FF9B5688'; g.beginPath(); g.arc(0, 0, 9, 0, Math.PI * 2); g.fill();
                    g.fillStyle = '#FFD36D'; g.fillRect(-4, -4, 8, 8);
                    g.fillStyle = '#FFF4AD'; g.fillRect(-2, -2, 4, 4);
                } else { // tomoe archer arrow: hilt-brown shaft, steel head, red fletching
                    g.rotate(Math.atan2(vy, vx));
                    g.fillStyle = '#C28B61'; g.fillRect(-16, -1, 26, 3);
                    g.fillStyle = '#B8C0D0'; g.fillRect(10, -2, 6, 5);
                    g.fillStyle = '#C8505A'; g.fillRect(-18, -3, 5, 7);
                }
                g.restore();
            }
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
            expire(now);
            const k = uiScale();
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.imageSmoothingEnabled = false;
            R.drawArena(g, now, view.zone || 0);
            // Layering (combat-vfx.md): floor rings -> units -> slashes/projectiles -> sparks -> numbers -> HUD/combo.
            drawFloorFx(now);
            const units = view.heroes.map((h, i) => ({ y: h.y, h, i }));
            for (const e of view.enemies || []) units.push({ y: e[3], e });
            for (const gh of ghosts) units.push({ y: gh.e[3], e: gh.e, fade: 1 - (now - gh.start) / gh.life });
            units.sort((a, b) => a.y - b.y).forEach(u => u.e ? drawEnemy(u.e, now, k, u.fade) : drawHero(u.h, u.i, now, room, myId, k));
            if (enemyMotion.size > 64) { const live = new Set((view.enemies || []).map(e => e[0])); for (const id of enemyMotion.keys()) if (!live.has(id)) enemyMotion.delete(id) }
            drawShots(view.shots || [], k);
            drawActionFx(view, now, k);
            drawParticles(now);
            drawNumbers(now);
            drawHud(view, room, myId, k, now);
            drawBanners(now, k);
            drawGameOver(now, view.hud);
            stats.frames++;
        }

        function start() { if (!running) { running = true; requestAnimationFrame(frame) } }
        function stop() { running = false }

        return { push, reset, start, stop, sample, stats, interpolating: interpEnabled, fxCounts: () => ({ fx: fx.length, parts: parts.length, texts: texts.length, banners: banners.length, art: A ? A.loadedCount() : 0 }) };
    }

    root.WCHArena = { createArena, TICK_MS, INTERP_DELAY_MS };
})(window);
