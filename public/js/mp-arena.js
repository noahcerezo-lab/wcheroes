/*
 * West Coast Heroes — multiplayer arena renderer.
 *
 * Draws the server's battle snapshots:
 *   - V19 battlefield (Moonlit Temple and the other three zones) and V19 hero sprites
 *   - enemies with Draper's sprites (combat-art.js):  Horned Acolyte and
 *     Temple Warden (no projectile enemies), each with idle / walk / windup / strike / die sheets picked from server flags.
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
    // Power-ups (shared/combat.js PICKUP_KINDS order) and buff colors. pu[] in snapshots = FURY, HASTE, WARD, SYNERGY.
    const PICKUP = [
        { key: 'heal', label: 'HEAL', color: '#74FFB2', core: '#ADFFCB' },
        { key: 'fury', label: 'FURY', color: '#FF7A45', core: '#FFD36D' },
        { key: 'haste', label: 'HASTE', color: '#53BAFF', core: '#D8FFFF' },
        { key: 'ward', label: 'WARD', color: '#A9B8FF', core: '#E8EEFF' },
    ];
    const BUFF = [PICKUP[1], PICKUP[2], PICKUP[3], { key: 'synergy', label: 'SYNERGY', color: '#E6AD57', core: '#FFD36D' }];
    const BUFF_MAX = [105, 105, 110, 65]; // full duration in 0.1 s, for the HUD timer bars

    function lerp(a, b, t) { return a + (b - a) * t }
    // 8-way aim index (shared-sim DIR8: 0 right, 2 down, 4 left, 6 up) -> unit vector.
    const aimVec = (aim, facing) => { const i = Number.isInteger(aim) ? aim : (facing === -1 ? 4 : 0); return { x: Math.cos(i * Math.PI / 4), y: Math.sin(i * Math.PI / 4) } };
    const reducedMotion = () => { try { return root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } };

    function createArena(canvas, opts) {
        const g = canvas.getContext('2d');
        g.imageSmoothingEnabled = false;
        const interpEnabled = opts.interpolate !== false;
        const snaps = []; // {tick, at, heroes, enemies, zone, hud}
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
        const chains = []; // per hero: {n, at} latest Critical Chain (2+ crits in a row)
        // Screen shake: small (<= 7 px) and short (<= 180 ms); disabled under prefers-reduced-motion.
        const shake = { amp: 0, start: 0, life: 1, count: 0 };
        function addShake(amp, life, now) {
            if (reducedMotion()) return;
            const left = shake.amp * Math.max(0, 1 - (now - shake.start) / shake.life);
            if (amp < left) return;
            Object.assign(shake, { amp: Math.min(7, amp), start: now, life: Math.min(180, life) });
            shake.count++;
        }
        function shakeOffset(now) {
            const t = (now - shake.start) / shake.life;
            if (t >= 1 || !shake.amp) return { x: 0, y: 0 };
            const a = shake.amp * (1 - t);
            return { x: Math.round(Math.sin(now / 17) * a), y: Math.round(Math.cos(now / 23) * a * .6) };
        }

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
            const prevSnap = snaps[snaps.length - 1];
            snaps.push({ tick, at: now, heroes: world.heroes, enemies, zone: world.zone || 0, hud: world });
            while (snaps.length > 40) snaps.shift();
            stats.snapshots++;
            const ev = Array.isArray(world.ev) ? world.ev : [];
            trackActions(world.heroes, ev, now);
            for (const e of ev) onEvent(e, now, prevSnap);
        }

        function reset() {
            snaps.length = 0; clockOffset = null; lastActs.length = 0; fx.length = 0; parts.length = 0; texts.length = 0;
            banners.length = 0; chains.length = 0; flashes.clear(); ghosts.length = 0; enemyMotion.clear(); overInfo = null;
        }

        // Particle cap keeps phones smooth: 260 squares at most, each one fillRect (no blur/shadows).
        function burst(x, y, color, n, speed = 4, o) {
            for (let i = 0; i < n && parts.length < 260; i++) parts.push({ x, y, vx: (Math.random() - .5) * 2 * speed, vy: (Math.random() - .5) * 2 * speed * (o && o.flat || 1) - (o && o.lift !== undefined ? o.lift : 1), born: performance.now(), life: (o && o.life || 380) + Math.random() * 200, color, sz: o && o.size || 5, gr: o && o.grav !== undefined ? o.grav : .04 });
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
                    // Swing direction = the hero's 8-way aim; stage 2 = chain finisher (bigger effect).
                    const f = { kind: 'attack', i, name: h.name, start: now, life: 300, facing: h.facing === -1 ? -1 : 1, aim: aimVec(h.aim, h.facing), stage: h.cs || 0, x: h.x, y: h.y };
                    if (h.name === 'ESPIRIT') {
                        const hit = ev.find(e => e.t === 'hit' && e.h === i);
                        f.tx = hit ? hit.x : h.x + f.aim.x * KIT.ESPIRIT.range;
                        f.ty = hit ? hit.y : h.y + f.aim.y * KIT.ESPIRIT.range;
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
                    const big = e.c || e.f; // crit or 3rd-hit finisher
                    const sheet = e.c ? (e.h === 3 ? 'espiritCrit' : 'critFlash') : e.f ? 'critFlash' : 'hitSpark';
                    fx.push({ kind: 'sheet', key: sheet, x: px + (Math.random() - .5) * 10, y: py + (Math.random() - .5) * 10, w: big ? 64 : 34, start: now, life: A ? A.duration(sheet) : 220 });
                    // Expanding impact ring on the floor under the target.
                    fx.push({ kind: 'ring', x: e.x * S, y: e.y * S, r0: 8, r1: e.f ? 62 : big ? 44 : 30, color: e.c ? '#FFD36D' : e.f ? '#FFF1C5' : '#FFF2B5', width: e.f ? 5 : 3, start: now, life: e.f ? 320 : 230 });
                    burst(px, py, e.c ? '#FFD36D' : '#FFF2B5', e.f ? 16 : e.c ? 12 : 5, e.f ? 6 : e.c ? 5 : 4);
                    if (e.f) burst(px, py, heroCfg(latestHero(e.h)?.name).color, 8, 6);
                    if (e.c) { // critical hit: extra impact (white-gold flash particles + a second gold ring)
                        burst(px, py, '#FFF1C5', 8, 7); burst(px, py, '#E6AD57', 6, 3);
                        fx.push({ kind: 'ring', x: e.x * S, y: e.y * S, r0: 14, r1: 70, color: '#E6AD57', width: 2, start: now + 40, life: 300 });
                        stats.crits = (stats.crits || 0) + 1;
                        if (e.cc >= 2) { chains[e.h] = { n: e.cc, at: now }; stats.maxChain = Math.max(stats.maxChain || 0, e.cc) }
                    }
                    floatText(px, py - 30, String(e.d) + (e.c ? '!' : ''), e.c ? NUM.crit : NUM.normal, e.f ? 26 : e.c ? 28 : 18);
                    // Crits shake harder than normal hits (still capped at 7 px / 180 ms; off with reduced motion).
                    if (e.c) addShake(Math.min(7, 3.5 + 0.5 * Math.min(6, e.cc || 1) + (e.f ? 1 : 0)), 160, now);
                    else if (e.f) addShake(4, 140, now);
                    break;
                }
                case 'kill': {
                    burst(e.x * S, e.y * S - 30, '#FF6C78', 13, 5); // enemies.md death burst
                    const last = prevSnap && prevSnap.enemies.find(v => v[0] === e.id);
                    if (last) { const art = A && A.ENEMY_ART[last[1]]; ghosts.push({ e: last.slice(), start: now, life: art && A.ready(art.die) ? A.duration(art.die) + 120 : 380 }) }
                    if (e.combo >= 2) comboAt = now;
                    break;
                }
                case 'hurt': {
                    const h = latestHero(e.h);
                    if (!h) break;
                    floatText(h.x * S, h.y * S - 95, '-' + e.d, NUM.hurt, 17); burst(h.x * S, h.y * S - 40, '#FF6574', 4);
                    const myId = opts.getMyId && opts.getMyId();
                    if (myId && h.controller === myId) addShake(3, 120, now); // only when YOUR hero is hit
                    break;
                }
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
                    addShake(3, 150, now);
                    banners.push({ str: h.name + ' • ' + e.k, color: heroCfg(h.name).color, born: now, life: 1300, small: true });
                    break;
                }
                case 'slam': addShake(5, 170, now); fx.push({ kind: 'floor', key: 'impact', x: e.x * S, y: e.y * S, r: (e.r || SLAM_R) * S, start: now, life: A ? A.duration('impact') : 420 }); break;
                case 'down': { const h = latestHero(e.h); if (h) banners.push({ str: h.name + ' IS DOWN — STAND NEXT TO THEM TO REVIVE', color: '#ff8a8a', born: now, life: 2200, small: true }); break }
                case 'revive': {
                    const h = latestHero(e.h);
                    if (!h) break;
                    fx.push({ kind: 'floor', key: 'reviveRing', x: h.x * S, y: h.y * S, r: 60, start: now, life: A ? A.duration('reviveRing') : 640 });
                    burst(h.x * S, h.y * S - 40, '#A5FFBF', 16, 5);
                    banners.push({ str: h.name + ' REVIVED!', color: '#A5FFBF', born: now, life: 1500, small: true });
                    break;
                }
                case 'pspawn': { // a power-up appears: small flash where it lands
                    const P = PICKUP[e.k] || PICKUP[0];
                    fx.push({ kind: 'ring', x: e.x * S, y: e.y * S, r0: 6, r1: 46, color: P.color, width: 3, start: now, life: 420 });
                    burst(e.x * S, e.y * S - 24, P.core, 8, 3);
                    break;
                }
                case 'pick': {
                    const P = PICKUP[e.k] || PICKUP[0], h = latestHero(e.h);
                    stats.picks = (stats.picks || 0) + 1;
                    fx.push({ kind: 'ring', x: e.x * S, y: e.y * S, r0: 10, r1: 80, color: P.color, width: 4, start: now, life: 380 });
                    burst(e.x * S, e.y * S - 30, P.color, 14, 5); burst(e.x * S, e.y * S - 30, P.core, 8, 3);
                    if (h) floatText(h.x * S, h.y * S - 118, P.label + (P.key === 'heal' ? '' : '!'), P.core, 22, 1000);
                    if (h) banners.push({ str: h.name + ' • ' + P.label + (P.key === 'heal' ? ' +32% HP' : P.key === 'fury' ? ' • CRIT UP' : P.key === 'haste' ? ' • SPEED UP' : ' • DAMAGE DOWN'), color: P.core, born: now, life: 1400, small: true });
                    break;
                }
                case 'syn': { // SQUAD SYNERGY: gold particles on every boosted hero + a short banner
                    stats.synergy = (stats.synergy || 0) + 1;
                    for (const j of e.all || []) { const u = latestHero(j); if (u) { burst(u.x * S, u.y * S - 50, '#FFD36D', 10, 4, { life: 600 }); burst(u.x * S, u.y * S - 50, '#E6AD57', 6, 2, { lift: 2.2, grav: 0, life: 700 }) } }
                    banners.push({ str: 'SQUAD SYNERGY • CRIT UP', color: '#FFD36D', born: now, life: 1700 });
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
            if (!interpEnabled || snaps.length < 2) return { heroes: latest.heroes, enemies: latest.enemies, zone: latest.zone, hud: latest.hud, pk: latest.hud.pk || [] };
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
            // Enemies are matched by id (they appear and vanish between snapshots).
            const blend = (listA, listB) => {
                const prev = new Map(listA.map(e => [e[0], e]));
                return listB.map(eb => {
                    const ea = prev.get(eb[0]);
                    if (!ea || Math.hypot(eb[2] - ea[2], eb[3] - ea[3]) > SNAP_DISTANCE) return eb;
                    const out = eb.slice(); out[2] = lerp(ea[2], eb[2], t); out[3] = lerp(ea[3], eb[3], t); return out;
                });
            };
            return { heroes, enemies: blend(a.enemies, b.enemies), zone: b.zone, hud: b.hud, pk: latest.hud.pk || [] };
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
            if (mine >= 0) { // power-up timers for your hero (under the squad panel)
                const pu = view.heroes[mine].pu || [];
                let yy = 18 + 30 + view.heroes.length * 22 + 10;
                for (let j = 0; j < 4; j++) if (pu[j]) {
                    const B = BUFF[j];
                    g.textAlign = 'left';
                    g.fillStyle = '#161326d9'; g.fillRect(18, yy, 200, 24);
                    g.fillStyle = B.color; g.fillRect(22, yy + 18, 192 * Math.min(1, pu[j] / BUFF_MAX[j]), 3);
                    g.fillStyle = B.core; g.font = 'bold 13px monospace';
                    g.fillText(B.label + ' ' + (pu[j] / 10).toFixed(1) + 's', 30, yy + 15);
                    yy += 28;
                }
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
                } else if (f.kind === 'ring') { // expanding impact ring (perspective ellipse, never flipped)
                    const t = el / f.life, r = lerp(f.r0, f.r1, 1 - (1 - t) * (1 - t));
                    g.save(); g.globalAlpha = Math.max(0, 1 - t); g.strokeStyle = f.color; g.lineWidth = f.width;
                    g.beginPath(); g.ellipse(f.x, f.y, r, r * .42, 0, 0, Math.PI * 2); g.stroke(); g.restore();
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
                        // Directional swing: the sheet faces right; mirror for leftward aims, then rotate to
                        // the 8-way aim (up/down/diagonals). Markie's cleave is 360° so it only mirrors.
                        const a = f.aim, fin = f.stage === 2, size = kit.atkW * Math.min(k, 1.15) * (fin ? 1.35 : 1); // world-scale reach: barely grows on phones
                        g.save();
                        g.translate(h.x * S, h.y * S - 34 * k);
                        if (a.x < -0.01) g.scale(-1, 1);
                        if (f.name !== 'MARKIE') g.rotate(Math.atan2(a.y, Math.abs(a.x) < 0.01 ? 0.0001 : Math.abs(a.x)));
                        const ox = f.name === 'MARKIE' ? 0 : kit.atkW * .28 * Math.min(k, 1.15);
                        A.play(g, kit.atk, el, ox, 0, size);
                        if (fin) { g.globalAlpha = .5; g.globalCompositeOperation = 'lighter'; A.play(g, kit.atk, el, ox, 0, size * 1.15); }
                        g.restore();
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
                g.fillRect(Math.round(p.x + p.vx * f), Math.round(p.y + p.vy * f + p.gr * f * f), p.sz, p.sz);
            }
            g.globalAlpha = 1;
        }
        // Critical Chain counter over a hero who landed 2+ crits in a row (fades 1.4 s after the last one).
        function drawChains(view, now, k) {
            g.save(); g.textAlign = 'center';
            chains.forEach((c, i) => {
                const h = view.heroes[i];
                if (!c || !h) return;
                const age = now - c.at;
                if (age > 1400) { chains[i] = null; return }
                const pop = age < 120 ? 1.35 - age / 400 : 1, sz = Math.round(Math.min(k, 1.3) * 19 * pop);
                g.globalAlpha = age > 1000 ? (1400 - age) / 400 : 1;
                g.font = 'bold ' + sz + 'px monospace';
                const x = h.x * S, y = h.y * S - 128 * Math.min(k, 1.3);
                g.lineWidth = 5; g.strokeStyle = '#2a1606';
                const str = 'CRITICAL CHAIN x' + c.n;
                g.strokeText(str, x, y); g.fillStyle = '#FFD36D'; g.fillText(str, x, y);
            });
            g.restore();
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
        // Power-up icon (vector, no images): heal cross, fury star, haste chevrons, ward shield.
        function pickupIcon(kind, r) {
            g.beginPath();
            if (kind === 0) { const a = r * .32; g.rect(-a, -r, 2 * a, 2 * r); g.rect(-r, -a, 2 * r, 2 * a) }
            else if (kind === 1) { for (let j = 0; j < 8; j++) { const rr = j % 2 ? r * .42 : r, an = j * Math.PI / 4 - Math.PI / 2; g.lineTo(Math.cos(an) * rr, Math.sin(an) * rr) } g.closePath() }
            else if (kind === 2) { for (const ox of [-r * .55, r * .25]) { g.moveTo(ox, -r * .8); g.lineTo(ox + r * .6, 0); g.lineTo(ox, r * .8); g.lineTo(ox + r * .3, r * .8); g.lineTo(ox + r * .9, 0); g.lineTo(ox + r * .3, -r * .8); g.closePath() } }
            else { g.moveTo(0, -r); g.lineTo(r * .85, -r * .6); g.quadraticCurveTo(r * .8, r * .55, 0, r); g.quadraticCurveTo(-r * .8, r * .55, -r * .85, -r * .6); g.closePath() }
            g.fill();
        }
        // Glowing pickups on the floor: pulsing halo, bobbing orb + icon, blinks in its last 3 s.
        function drawPickups(view, now, k) {
            for (const p of view.pk || []) {
                const [id, kind, x, y, secs] = p, P = PICKUP[kind] || PICKUP[0];
                if (secs <= 3 && Math.floor(now / 150) % 2) continue;
                const px = x * S, py = y * S, bob = Math.sin(now / 260 + id) * 5, pulse = .5 + .5 * Math.sin(now / 180 + id), r = 17 * Math.min(k, 1.3);
                g.save();
                g.globalAlpha = .55; g.fillStyle = '#0b0914'; g.beginPath(); g.ellipse(px, py + 4, r * 1.3, r * .45, 0, 0, Math.PI * 2); g.fill();
                g.globalCompositeOperation = 'lighter';
                g.globalAlpha = .22 + .2 * pulse; g.fillStyle = P.color;
                g.beginPath(); g.ellipse(px, py + 2, r * (2 + pulse * .5), r * (.8 + pulse * .2), 0, 0, Math.PI * 2); g.fill();
                g.globalAlpha = .35 + .25 * pulse; g.beginPath(); g.arc(px, py - 30 + bob, r * 1.55, 0, Math.PI * 2); g.fill();
                g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
                g.fillStyle = '#141024'; g.beginPath(); g.arc(px, py - 30 + bob, r, 0, Math.PI * 2); g.fill();
                g.lineWidth = 3; g.strokeStyle = P.color; g.stroke();
                g.translate(px, py - 30 + bob); g.fillStyle = P.core; pickupIcon(kind, r * .62);
                g.restore();
                if (Math.random() < .08) burst(px + (Math.random() - .5) * r * 2, py - 30 + bob, P.core, 1, 1, { lift: 1.6, grav: 0, life: 500, size: 4 });
            }
        }
        // Destiny's passive aura (combat-vfx.md: dashed ellipse 145x85, five orbiting #9BFFCB pips), made more
        // present: brighter stroke, soft mint floor glow, and a pulse that expands when she attacks.
        function drawDestinyAura(view, now) {
            view.heroes.forEach((h, i) => {
                if (h.name !== 'DESTINY' || h.state) return;
                const x = h.x * S, y = h.y * S, rx = 145, ry = 85;
                let pulse = 0;
                for (const f of fx) if (f.i === i && (f.kind === 'attack' || f.kind === 'cast')) pulse = Math.max(pulse, 1 - (now - f.start) / 420);
                pulse = Math.max(0, pulse);
                const breathe = .5 + .5 * Math.sin(now / 500);
                g.save();
                g.globalCompositeOperation = 'lighter';
                g.globalAlpha = .1 + .05 * breathe + .18 * pulse; g.fillStyle = '#74FFB2';
                g.beginPath(); g.ellipse(x, y, rx * .92, ry * .92, 0, 0, Math.PI * 2); g.fill();
                g.globalAlpha = 1;
                g.setLineDash([12, 9]); g.lineDashOffset = -now / 40;
                g.lineWidth = 3; g.strokeStyle = 'rgba(105,255,170,' + (.32 + .14 * breathe + .3 * pulse).toFixed(3) + ')';
                g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.stroke();
                g.setLineDash([]);
                if (pulse > 0) { // attack pulse: a bright ring sweeping outward
                    const t = 1 - pulse;
                    g.lineWidth = 4 * pulse + 1; g.strokeStyle = 'rgba(173,255,203,' + (.75 * pulse).toFixed(3) + ')';
                    g.beginPath(); g.ellipse(x, y, rx * (.45 + .6 * t), ry * (.45 + .6 * t), 0, 0, Math.PI * 2); g.stroke();
                }
                g.fillStyle = '#9BFFCB';
                for (let j = 0; j < 5; j++) { const an = now / 900 + j * Math.PI * 2 / 5; g.fillRect(Math.round(x + Math.cos(an) * rx - 2), Math.round(y + Math.sin(an) * ry - 2), 5, 5) }
                g.restore();
            });
        }
        // Buffed heroes: FURY flames, HASTE speed streaks, WARD bubble, SYNERGY gold orbit; icons over the head.
        function drawBuffs(view, now, k) {
            view.heroes.forEach((h, i) => {
                const pu = h.pu; if (!pu || h.state || !(pu[0] || pu[1] || pu[2] || pu[3])) return;
                const x = h.x * S, y = h.y * S, kk = Math.min(k, 1.3);
                g.save();
                g.globalCompositeOperation = 'lighter';
                if (pu[2]) { // WARD: translucent shield bubble
                    g.globalAlpha = .16 + .06 * Math.sin(now / 200); g.fillStyle = '#A9B8FF';
                    g.beginPath(); g.ellipse(x, y - 40 * kk, 40 * kk, 52 * kk, 0, 0, Math.PI * 2); g.fill();
                    g.globalAlpha = .7; g.lineWidth = 2; g.strokeStyle = '#E8EEFF'; g.stroke();
                }
                if (pu[1] && h.moving) { // HASTE: cyan streaks trailing behind
                    g.globalAlpha = .6; g.strokeStyle = '#79E4FF'; g.lineWidth = 3;
                    const dir = h.facing === -1 ? 1 : -1;
                    for (let j = 0; j < 3; j++) { const yy = y - (18 + j * 18) * kk, off = (now / 6 + j * 37) % 30; g.beginPath(); g.moveTo(x + dir * (22 + off) * kk, yy); g.lineTo(x + dir * (46 + off) * kk, yy); g.stroke() }
                }
                if (pu[3]) { // SYNERGY: four gold pips orbiting
                    g.globalAlpha = .9; g.fillStyle = '#FFD36D';
                    for (let j = 0; j < 4; j++) { const an = now / 300 + j * Math.PI / 2; g.fillRect(Math.round(x + Math.cos(an) * 36 * kk - 3), Math.round(y - 40 * kk + Math.sin(an) * 14 * kk - 3), 6, 6) }
                }
                g.restore();
                if (pu[0] && Math.random() < .35) burst(x + (Math.random() - .5) * 40 * kk, y - Math.random() * 60 * kk, Math.random() < .5 ? '#FF7A45' : '#FFD36D', 1, 1, { lift: 2.4, grav: -.01, life: 420, size: 4 }); // FURY flames
                if (pu[3] && Math.random() < .2) burst(x + (Math.random() - .5) * 50 * kk, y - 20 - Math.random() * 60 * kk, '#FFD36D', 1, 1, { lift: 1.5, grav: 0, life: 520, size: 4 });
                // little buff icons above the name
                const on = [0, 1, 2, 3].filter(j => pu[j]);
                g.save(); g.translate(x - (on.length - 1) * 10 * kk, y - 112 * kk);
                for (const j of on) { g.fillStyle = '#141024d0'; g.beginPath(); g.arc(0, 0, 8 * kk, 0, Math.PI * 2); g.fill(); g.fillStyle = BUFF[j].core; if (j < 3) pickupIcon(j + 1, 5 * kk); else { g.beginPath(); g.arc(0, 0, 4 * kk, 0, Math.PI * 2); g.fill() } g.translate(20 * kk, 0) }
                g.restore();
            });
        }
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
            if (role === 'me' && !h.state) { // aim marker: where your next attack goes (8-way)
                const a = aimVec(h.aim, h.facing);
                g.save();
                g.translate(a.x * 44, 3 + a.y * 44 * .42);
                g.rotate(Math.atan2(a.y * .42, a.x));
                g.fillStyle = '#ffd279'; g.globalAlpha = .85;
                g.beginPath(); g.moveTo(8, 0); g.lineTo(-5, -6); g.lineTo(-2, 0); g.lineTo(-5, 6); g.closePath(); g.fill();
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

        // Enemy: Draper's sheets chosen from the server flags (1 stunned, 2 taunted, 4 winding up,
        // 8 just struck): wind -> windup/charge/draw/plant, strike -> slash/fire/slam, moving -> walk
        // (front-facing, not flipped), else idle. Dying enemies play their die sheet then fade.
        function drawEnemy(e, now, k, fade, dieAt) {
            const [id, type, ex, ey, hpPct, facing, flags] = e;
            const art = (A && A.ENEMY_ART[type]) || { key: 'acolyte', w: 50 };
            const flash = (flashes.get(id) || 0) > now;
            let m = enemyMotion.get(id);
            if (!m) { m = { x: ex, y: ey, moveAt: 0, windAt: 0, strikeAt: 0, wasWind: false, wasStrike: false }; enemyMotion.set(id, m) }
            if (Math.hypot(ex - m.x, ey - m.y) > 0.3) { m.moveAt = now; m.x = ex; m.y = ey }
            const wind = !!(flags & 4), struck = !!(flags & 8);
            if (wind && !m.wasWind) m.windAt = now;
            if (struck && !m.wasStrike) m.strikeAt = now;
            m.wasWind = wind; m.wasStrike = struck;
            const walking = now - m.moveAt < 120;
            const dir = facing === -1 ? -1 : 1;
            // Pick the sheet; fall back to idle + procedural motion if an action sheet is missing.
            let key = art.key, mode = 'loop', t0 = 0, flip = dir < 0, ox = 0, oy = 0;
            const has = k2 => A && k2 && A.ready(k2);
            if (dieAt !== undefined && has(art.die)) { key = art.die; mode = 'once'; t0 = dieAt }
            else if (struck && has(art.strike) && now - m.strikeAt < A.duration(art.strike)) { key = art.strike; mode = 'once'; t0 = m.strikeAt }
            else if (wind && has(art.wind)) { key = art.wind; mode = 'hold'; t0 = m.windAt }
            else if (walking && has(art.walk)) { key = art.walk; flip = false }
            else if (struck) ox = dir * 7; // procedural lunge fallback
            if (walking && key === art.key) oy = -Math.abs(Math.sin(now / 90 + id)) * 3; // bob fallback
            if (flash) ox += Math.sin(now / 34) * 3; // hurt shake
            g.save();
            g.translate(Math.round(ex * S), Math.round(ey * S));
            g.scale(k, k);
            if (fade !== undefined) g.globalAlpha = Math.max(0, fade);
            // World-scale telegraph (sheets only hint at it): warden plant ring at the slam radius.
            if (wind && art.key === 'warden' && A) A.loop(g, 'warning', now, 0, 0, SLAM_R * S * 2 / k, SLAM_R * S / k);
            g.fillStyle = '#0006';
            g.beginPath(); g.ellipse(0, 1, art.w * .36, 6, 0, 0, Math.PI * 2); g.fill();
            const drawFrame = () => {
                if (!A) return false;
                if (mode === 'loop') return A.loop(g, key, now, ox, oy + 2, art.w, null, flip, undefined, id * 37);
                const n = A.frameCount(key), f = Math.min(n - 1, Math.floor((now - t0) / A.SHEETS[key][4]));
                return A.frame(g, key, f, ox, oy + 2, art.w, null, flip);
            };
            const drawn = drawFrame();
            if (!drawn) R.drawSprite(g, 0, 0, '#000', true, '', now, { facing: dir, hurt: flash ? 6 : 0, flash: flash ? 1 : 0 }); // V19 fallback while loading
            if (drawn && flash) { // V19 hurt flash: 45% #FFF1C5, only on the sprite's own pixels
                g.globalCompositeOperation = 'lighter';
                g.globalAlpha *= .45;
                drawFrame();
                g.globalCompositeOperation = 'source-over';
            }
            g.globalAlpha = fade !== undefined ? Math.max(0, fade) : 1;
            const top = art.key === 'warden' ? -88 : -68;
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
                view.heroes[local.index] = Object.assign({}, view.heroes[local.index], { x: local.x, y: local.y, facing: local.facing, aim: local.aim ?? view.heroes[local.index].aim, moving: local.moving });
            }
            expire(now);
            const k = uiScale();
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.fillStyle = '#111025'; g.fillRect(0, 0, canvas.width, canvas.height); // edge strip during shake
            const sh = shakeOffset(now);
            g.setTransform(1, 0, 0, 1, sh.x, sh.y); // world layers shake; the HUD below does not
            g.imageSmoothingEnabled = false;
            R.drawArena(g, now, view.zone || 0);
            // Layering (combat-vfx.md): floor rings -> units -> slashes/projectiles -> sparks -> numbers -> HUD/combo.
            drawFloorFx(now);
            drawDestinyAura(view, now);
            drawPickups(view, now, k);
            const units = view.heroes.map((h, i) => ({ y: h.y, h, i }));
            for (const e of view.enemies || []) units.push({ y: e[3], e });
            for (const gh of ghosts) { const el = now - gh.start; units.push({ y: gh.e[3], e: gh.e, dieAt: gh.start, fade: el < gh.life - 160 ? 1 : (gh.life - el) / 160 }) } // die frames, then fade
            units.sort((a, b) => a.y - b.y).forEach(u => u.e ? drawEnemy(u.e, now, k, u.fade, u.dieAt) : drawHero(u.h, u.i, now, room, myId, k));
            if (enemyMotion.size > 64) { const live = new Set((view.enemies || []).map(e => e[0])); for (const id of enemyMotion.keys()) if (!live.has(id)) enemyMotion.delete(id) }
            drawBuffs(view, now, k);
            drawActionFx(view, now, k);
            drawParticles(now);
            drawNumbers(now);
            drawChains(view, now, k);
            g.setTransform(1, 0, 0, 1, 0, 0);
            drawHud(view, room, myId, k, now);
            drawBanners(now, k);
            drawGameOver(now, view.hud);
            stats.frames++;
        }

        function start() { if (!running) { running = true; requestAnimationFrame(frame) } }
        function stop() { running = false }

        return { push, reset, start, stop, sample, stats, interpolating: interpEnabled, fxCounts: () => ({ fx: fx.length, parts: parts.length, texts: texts.length, banners: banners.length, art: A ? A.loadedCount() : 0, shakes: shake.count, reducedMotion: reducedMotion() }), pickupsShown: () => { const v = sample(performance.now()); return v ? (v.pk || []).length : 0 }, chainOf: i => chains[i] ? chains[i].n : 0, lastAttackFx: () => { const f = [...fx].reverse().find(v => v.kind === 'attack'); return f ? { name: f.name, aim: f.aim, stage: f.stage } : null } };
    }

    root.WCHArena = { createArena, TICK_MS, INTERP_DELAY_MS };
})(window);
