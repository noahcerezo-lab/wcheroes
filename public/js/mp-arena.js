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
        ESPIRIT: { atk: 'espiritArrow', atkW: 60, spc: 'espiritStorm', range: 546 }, // 2x V19 reach (server RULES.espiritRangeMul)
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
    // Draper's overhaul art (public/assets/overhaul, see wcheroes-design/m-overhaul READMEs).
    const OV = {};
    (function loadOverhaul() {
        const files = { levelup: 'fx_levelup_64x128_10f', sky: 'bg_sky_moon_1440x810', temple: 'bg_temple_silhouettes_1440x810', pillars: 'bg_near_pillars_1440x810', floor: 'floor_tile_64x64', mist: 'fx_mist_24x16_4f', ember: 'fx_ember_8x8_6f', shadowSm: 'shadow_sm_24x10', shadowMd: 'shadow_md_40x16', shadowLg: 'shadow_lg_56x20', shadowXl: 'shadow_xl_80x24', hitNOAH: 'fx_noah_hitflash_32x32_5f', hitDESTINY: 'fx_destiny_hitflash_32x32_5f', hitMARKIE: 'fx_markie_hitflash_32x32_5f', hitESPIRIT: 'fx_espirit_hitflash_32x32_5f' };
        if (typeof Image === 'undefined') return;
        for (const k in files) { const im = new Image(); im.onload = () => { OV[k] = im }; im.src = 'assets/overhaul/' + files[k] + '.png' }
    })();
    // Level-up sheet pre-tinted per hero once (multiply by the hero's primary, alpha kept; hot core stays white).
    const LEVELUP_TINT = { NOAH: ['#7A5FE0', '#83B8FF'], DESTINY: ['#F5C65D', '#D8434F'], MARKIE: ['#FF9657', '#C98A4B'], ESPIRIT: ['#5CCE8A', '#F5D477'] };
    const tinted = {};
    function tintedLevelup(name) {
        if (tinted[name]) return tinted[name];
        if (!OV.levelup) return null;
        const im = OV.levelup, c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
        const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
        g.drawImage(im, 0, 0);
        g.globalCompositeOperation = 'multiply'; g.fillStyle = (LEVELUP_TINT[name] || ['#FFD36D'])[0]; g.fillRect(0, 0, c.width, c.height);
        g.globalCompositeOperation = 'destination-in'; g.drawImage(im, 0, 0); // restore the sheet's alpha
        g.globalCompositeOperation = 'lighter'; g.globalAlpha = .45; g.drawImage(im, 0, 0); // keep the hot core bright
        return (tinted[name] = c);
    }
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
        const texts = [], banners = [];
        // Pooled particles (fx-pool.js) and the hero pose/attack animator (hero-anim.js).
        const pool = root.WCHFxPool.createPool(520);
        const anim = root.WCHHeroAnim ? root.WCHHeroAnim.create({ R, pool, S, theme: ART_THEME, procedural: !!opts.procedural }) : null;
        const SH = root.WCHSheets || null;
        const env = root.WCHEnv ? root.WCHEnv.create({ OV }) : null; // Draper's environment (cached per zone)
        // Oracle's fx.js (impact presets, cosmetic hit-stop time scale) once its module has loaded.
        let ofx = null; const OC = {};
        function oracle() {
            if (ofx || !root.WCHOracleFX) return ofx;
            ofx = root.WCHOracleFX.createFX({ capacity: 2048, budgetMs: 18 });
            OC.NOAH = ofx.particles.color('#79E4FF'); OC.MARKIE = ofx.particles.color('#FF9657'); OC.DESTINY = ofx.particles.color('#F5C65D'); OC.ESPIRIT = ofx.particles.color('#FFE17B'); OC.GOLD = ofx.particles.color('#FFD36D');
            return ofx;
        }
        function emitO(preset, x, y, ang, scale, col) { const o = oracle(); if (o) o.particles.emit(preset, x, y, ang || 0, scale || 1, col === undefined ? -1 : col) }
        // WebAudio cues (sfx.js). iOS only allows audio after a user gesture: unlock on the first tap/key.
        function sfx(name, i, o) {
            const X = root.WCHSfx; if (!X) return;
            const mine = i === undefined || isMine(i);
            const h = i !== undefined && latestHero(i);
            X.play(name, Object.assign({ gain: mine ? 1 : .3, pan: h ? Math.max(-.6, Math.min(.6, (h.x * S / canvas.width - .5) * 1.2)) : 0 }, o));
            stats.sfx = (stats.sfx || 0) + 1;
        }
        if (typeof document !== 'undefined') {
            const unlock = () => { if (root.WCHSfx) { root.WCHSfx.unlock(); if (root.WCHSfx.isUnlocked()) for (const ev of ['pointerdown', 'touchend', 'keydown']) document.removeEventListener(ev, unlock, true) } };
            for (const ev of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(ev, unlock, true);
        }
        const pendingHits = []; // hit visuals waiting for the weapon to connect: {at, e}
        const recoils = new Map(); // enemy id -> {at, dx, dy, holdUntil, x, y}
        let lastFrame = 0;
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
            snaps.length = 0; clockOffset = null; lastActs.length = 0; fx.length = 0; pool.clear(); pendingHits.length = 0; recoils.clear(); texts.length = 0;
            banners.length = 0; chains.length = 0; flashes.clear(); ghosts.length = 0; enemyMotion.clear(); overInfo = null;
        }

        // Particle cap keeps phones smooth: 260 squares at most, each one fillRect (no blur/shadows).
        function burst(x, y, color, n, speed = 4, o) { return pool.burst(x, y, color, n, speed, o) }
        function floatText(x, y, str, color, size, life = 870, key) {
            const now = performance.now();
            if (key !== undefined) { // damage numbers on the same target within 260 ms combine into one total
                for (let j = texts.length - 1; j >= 0; j--) {
                    const t = texts[j];
                    if (t.key === key && now - t.born < 260 && t.color === color) { t.sum += +str || 0; t.str = String(t.sum) + (t.bang || ''); t.born = now; t.size = Math.max(t.size, size); return }
                }
            }
            if (texts.length >= 40) texts.shift(); // cap: never a wall of numbers
            const n = parseInt(str, 10);
            texts.push({ x, y, str, color, size, born: now, life, dx: (Math.random() - .5) * 14, key, sum: isNaN(n) ? 0 : n, bang: /!$/.test(str) ? '!' : '' });
        }
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
                        const hits = ev.filter(e => e.t === 'hit' && e.h === i);
                        const hit = hits[0];
                        f.mastery = Math.min(2, h.mastery || 0);
                        f.volley = hits.slice(0, 1 + f.mastery).map(e => ({ x: e.x, y: e.y }));
                        f.tx = hit ? hit.x : h.x + f.aim.x * KIT.ESPIRIT.range;
                        f.ty = hit ? hit.y : h.y + f.aim.y * KIT.ESPIRIT.range;
                        f.life = Math.max(120, Math.hypot(f.tx - h.x, f.ty - h.y) * S / 3.2);
                    }
                    if (anim && anim.hasPose(h.name)) {
                        anim.onAttack(i, h, f.stage, f.aim, now); f.pose = true;
                        if (h.name === 'ESPIRIT') { // arrow leaves the string on the release frame and flies at bow speed
                            f.rel = anim.releaseAt(i);
                            f.flight = Math.max(60, Math.hypot(f.tx - h.x, f.ty - h.y) * S / anim.BOW.speed);
                            f.life = f.rel - now + f.flight + 20;
                            sfx('bowDraw', i);
                            pendingHits.push({ at: f.rel, e: { t: 'sfx', name: 'bowRelease', i } });
                        } else {
                            sfx(h.name === 'MARKIE' ? 'axeSwing' : 'swing', i, { variant: f.stage + 1 });
                            if (h.name === 'MARKIE') pendingHits.push({ at: anim.contactAt(i), e: { t: 'sfx', name: 'axeImpact', i, gain: f.stage === 2 ? 1.2 : .8 } });
                        }
                    }
                    fx.push(f);
                    if (!f.pose) attackBurst(f, h, now);
                }
                if (h.specialN > prev.s) fx.push({ kind: 'cast', i, start: now, life: 560 });
            });
        }

        // One-off particles/floor marks when a swing starts (capped by burst()).
        function attackBurst(f, h, now) {
            const fin = f.stage === 2, x = h.x * S, y = h.y * S;
            if (h.name === 'NOAH') { // arcane sparks at the tip of the swing
                const tip = KIT.NOAH.atkW * .55;
                const tx = x + f.aim.x * tip, ty = y - 34 + f.aim.y * tip;
                burst(tx, ty, '#79E4FF', fin ? 10 : 6, 4, { life: 320, size: 4, grav: .01 });
                burst(tx, ty, '#D8FFFF', fin ? 5 : 3, 5, { life: 260, size: 3, grav: 0 });
                burst(x + f.aim.x * tip * .5, ty, '#7A5FE0', fin ? 6 : 3, 3, { life: 360, size: 4, grav: 0 });
            } else if (h.name === 'MARKIE') { // ground impact + dust burst; finisher hits harder
                const gx = x + f.aim.x * 34, gy = y + f.aim.y * 14 + 4;
                const cracks = []; for (let j = 0; j < (fin ? 7 : 5); j++) { const an = j / (fin ? 7 : 5) * Math.PI * 2 + Math.random() * .6; const c = []; let r = 0; for (let q = 0; q < 3; q++) { r += .25 + Math.random() * .15; c.push([Math.cos(an + (Math.random() - .5) * .5) * r, Math.sin(an + (Math.random() - .5) * .5) * r]) } cracks.push(c) }
                fx.push({ kind: 'crack', x: gx, y: gy, r: fin ? 90 : 62, cracks, fin, start: now, life: fin ? 520 : 400 });
                if (fin) fx.push({ kind: 'ring', x: gx, y: gy, r0: 16, r1: 110, color: '#FFC277', width: 5, start: now, life: 360 });
                burst(gx, gy - 6, '#A7855F', fin ? 16 : 9, fin ? 5 : 3.5, { flat: .35, lift: 1.4, grav: .03, life: 520, size: 6 }); // dust
                burst(gx, gy - 6, '#8C7A66', fin ? 10 : 5, 3, { flat: .35, lift: 1, grav: .02, life: 600, size: 7 });
                burst(gx, gy - 10, '#FFC277', fin ? 8 : 4, 4, { life: 300, size: 4 });
                addShake(fin ? 5.5 : 1.5, fin ? 170 : 90, now); // extra weight on the combo finisher (capped, off with reduced motion)
            } else if (h.name === 'ESPIRIT') {
                burst(x + f.facing * 20, y - 38, '#FFE17B', 4, 2, { life: 260, size: 4, grav: 0 });
            } else if (h.name === 'DESTINY') {
                burst(x + f.aim.x * 30, y - 34 + f.aim.y * 20, fin ? '#FFE1A2' : '#9EFFC9', fin ? 8 : 4, 3, { life: 340, size: 4, grav: 0 });
            }
        }

        // Freeze a struck enemy where it was hit until the blade connects (it would otherwise slide away first).
        function recoilHold(e, at) {
            const prev = snaps[snaps.length - 2];
            const last = prev && prev.enemies.find(v => v[0] === e.id);
            recoils.set(e.id, { at: 0, dx: 0, dy: 0, holdUntil: at, x: last ? last[2] : e.x, y: last ? last[3] : e.y });
        }
        // Impact on a struck enemy: hit-stop hold, then a short recoil away from the attacker.
        function impactRecoil(e, now, strength) {
            const h = latestHero(e.h); if (!h) return;
            const dx = e.x - h.x, dy = e.y - h.y, d = Math.hypot(dx, dy) || 1;
            const r = recoils.get(e.id) || {};
            Object.assign(r, { at: now, dx: dx / d * strength, dy: dy / d * strength * .6, holdUntil: now + (e.f ? 70 : 40), x: r.x ?? e.x, y: r.y ?? e.y });
            recoils.set(e.id, r);
        }
        // Noah's impact: blue sparks + crystal shards at the collision point, flash, recoil, hit-stop; the
        // Arcane Breaker (finisher) adds a bright impact flash and an expanding magical shockwave.
        // Per-hero impact at the collision point (everyone but Noah): hitflash sheet, preset particles, recoil,
        // hit-stop on the attacker's sheet, sound, smaller number. Crits turn the impact gold.
        const IMPACT = {
            MARKIE: { preset: 'spark', dust: true, recoil: [11, 15, 20], stop: [60, 60, 95], cue: null, flash: '#FFC277' },
            DESTINY: { preset: 'slash', dust: false, recoil: [7, 9, 13], stop: [40, 45, 70], cue: 'goldStrike', flash: '#FFF1C5' },
            ESPIRIT: { preset: 'spark', dust: false, recoil: [6, 8, 11], stop: [0, 0, 0], cue: 'arrowHit', flash: '#FFF9D4' },
        };
        function heroImpact(e, now, h) {
            const C = IMPACT[h.name]; if (!C) return false;
            const px = e.x * S, py = e.y * S - 36;
            const dx = e.x - h.x, dy = e.y - h.y, d = Math.hypot(dx, dy) || 1, ang = Math.atan2(dy, dx);
            const cx = px - dx / d * 12, cy = py - dy / d * 7, fin = !!e.f, mine = isMine(e.h), st = fin ? 2 : e.c ? 1 : 0;
            if (C.stop[st]) anim.hitStop(e.h, C.stop[st]);
            impactRecoil(e, now, C.recoil[st]);
            fx.push({ kind: 'ov', key: 'hit' + h.name, n: 5, fd: 45, x: cx, y: cy, sc: fin || e.c ? 1.6 : 1.2, start: now, life: 225 });
            emitO(e.c ? 'gold' : C.preset, cx, cy, ang, fin ? 1.3 : e.c ? 1.1 : .8, e.c ? OC.GOLD : OC[h.name]);
            if (C.dust && (fin || e.c)) emitO('dust', e.x * S, e.y * S - 4, -Math.PI / 2, fin ? 1.2 : .7);
            if (h.name === 'DESTINY' && fin) emitO('glint', cx, cy - 6, 0, 1);
            if (e.c) { emitO('glint', cx, cy, 0, 1); fx.push({ kind: 'flash', x: cx, y: cy, r: fin ? 34 : 26, color: '#FFE9A8', start: now, life: 120 }) }
            if (C.cue) sfx(C.cue, e.h, { gain: fin ? 1.1 : .8 });
            if (e.c) sfx('crit', e.h);
            if (fin || e.c) addShake(mine ? (h.name === 'MARKIE' ? (fin ? 4.5 : 2.5) : fin ? 2.5 : 1.5) : .8, fin ? 150 : 100, now);
            if (mine && (fin || e.c)) { const o = oracle(); if (o) o.hitStop(fin ? 55 : 35) } // cosmetic particle freeze only
            hitNumber(e, cx, cy - 22, now);
            if (e.c) { stats.crits = (stats.crits || 0) + 1; if (e.cc >= 2) { chains[e.h] = { n: e.cc, at: now }; stats.maxChain = Math.max(stats.maxChain || 0, e.cc) } }
            stats.impacts = (stats.impacts || 0) + 1;
            return true;
        }
        function noahImpact(e, now) {
            const h = latestHero(e.h);
            const px = e.x * S, py = e.y * S - 36;
            const dx = h ? e.x - h.x : 1, dy = h ? e.y - h.y : 0, d = Math.hypot(dx, dy) || 1;
            const cx = px - dx / d * 14, cy = py - dy / d * 8; // collision point: the near side of the enemy
            const fin = !!e.f, mine = isMine(e.h);
            anim.hitStop(e.h, fin ? 85 : 45);
            impactRecoil(e, now, fin ? 16 : e.c ? 11 : 8);
            pool.emit(fin ? 16 : e.c ? 11 : 7, p => { // blue sparks spraying along the cut
                const a = Math.atan2(dy, dx) + (Math.random() - .5) * 1.8, sp = .12 + Math.random() * .25;
                p.x = cx; p.y = cy; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp * .8 - .05; p.grav = .0006; p.drag = .003;
                p.kind = 2; p.size = 3 + Math.random() * 2; p.life = 180 + Math.random() * 160; p.color = Math.random() < .4 ? '#FFFFFF' : Math.random() < .5 ? '#79E4FF' : '#53BAFF'; p.add = true;
            });
            pool.emit(fin ? 8 : 4, p => {
                const a = Math.random() * 6.28, sp = .04 + Math.random() * .08;
                p.x = cx; p.y = cy; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp; p.kind = 1; p.size = 3 + Math.random() * 3; p.life = 300 + Math.random() * 200;
                p.color = Math.random() < .5 ? '#D8FFFF' : '#83B8FF'; p.add = true; p.rot = a; p.vr = .01;
            });
            fx.push({ kind: 'flash', x: cx, y: cy, r: fin ? 32 : e.c ? 24 : 16, color: e.c ? '#FFE9A8' : '#D8FFFF', start: now, life: fin ? 160 : 110 });
            if (fin) { // Arcane Breaker: shockwave rings (a dark refractive inner ring sells the "distortion")
                fx.push({ kind: 'shock', x: e.x * S, y: e.y * S - 10, r0: 12, r1: 120, start: now, life: 420 });
                addShake(mine ? 3.5 : 1.5, 140, now);
            } else if (e.c) addShake(mine ? 2.5 : 1, 100, now);
            fx.push({ kind: 'ov', key: 'hitNOAH', n: 5, fd: 45, x: cx, y: cy, sc: fin ? 1.7 : 1.25, start: now, life: 225 });
            if (fin && SH) fx.push({ kind: 'ov', sheet: 'noahShards', n: 6, fd: 50, x: cx, y: cy, sc: 1.4 * uiScale(), start: now, life: 300 });
            emitO(e.c ? 'gold' : 'arcane', cx, cy, Math.atan2(dy, dx), fin ? 1.1 : .6, e.c ? OC.GOLD : -1);
            sfx(fin ? 'arcaneBreaker' : 'arcaneHit', e.h, { gain: fin ? 1.1 : .8 });
            if (e.c) sfx('crit', e.h);
            if (mine && (fin || e.c)) { const o = oracle(); if (o) o.hitStop(fin ? 60 : 35) }
            hitNumber(e, cx, cy - 22, now);
            if (e.c) { stats.crits = (stats.crits || 0) + 1; if (e.cc >= 2) { chains[e.h] = { n: e.cc, at: now }; stats.maxChain = Math.max(stats.maxChain || 0, e.cc) } }
            stats.impacts = (stats.impacts || 0) + 1;
            stats.noahImpacts = (stats.noahImpacts || 0) + 1;
        }
        function isMine(i) { const h = latestHero(i), id = opts.getMyId && opts.getMyId(); return !!(h && id && h.controller === id) }
        function hitNumber(e, x, y, now) { floatText(x, y, String(e.d) + (e.c ? '!' : ''), e.c ? NUM.crit : NUM.normal, e.f ? 17 : e.c ? 18 : 13, e.c ? 760 : 620, e.id) } // small + merged per target
        function processPending(now) {
            for (let j = pendingHits.length - 1; j >= 0; j--) {
                const p = pendingHits[j];
                if (p.at > now) continue;
                pendingHits.splice(j, 1);
                p.e.late = true;
                onEvent(p.e, now, null);
            }
        }
        function onEvent(e, now, prevSnap) {
            if (e.t === 'sfx') { sfx(e.name, e.i, { gain: e.gain }); return }
            if (e.t === 'hit' && !e.late && anim) { // pose heroes: show the impact when the weapon connects
                const h = latestHero(e.h);
                if (h && anim.hasPose(h.name)) {
                    const dist = h.name === 'ESPIRIT' ? Math.hypot(e.x - h.x, e.y - h.y) * S : 0; // arrow flight
                    const at = anim.contactAt(e.h, dist);
                    if (at > now) { pendingHits.push({ at, e }); recoilHold(e, at); return }
                }
            }
            if (e.t === 'kill' && !e.late) { // the death waits for the blow that caused it
                const p = pendingHits.find(q => q.e.t === 'hit' && q.e.id === e.id);
                if (p) { e.prev = prevSnap && prevSnap.enemies.find(v => v[0] === e.id); pendingHits.push({ at: p.at + 1, e }); return }
            }
            switch (e.t) {
                case 'hit': {
                    flashes.set(e.id, now + 200);
                    const hh = latestHero(e.h);
                    // Combat 2.0: directional, character-colored impact flashes are applied
                    // before legacy early returns, so premium animation hits get them too.
                    // Keep all embellishments on the target, never on hero faces.
                    if (hh && (e.f || e.c)) {
                        const palette = {
                            NOAH: '#b59aff', DESTINY: '#ffe3a0',
                            MARKIE: '#ffad6e', ESPIRIT: '#a2ffd1'
                        };
                        const col = palette[hh.name] || '#fff2b5';
                        const px = e.x * S, py = e.y * S - 38;
                        const dx = e.x - hh.x, dy = e.y - hh.y;
                        const angle = Math.atan2(dy, dx);
                        fx.push({ kind: 'combatImpact', x: px, y: py, angle,
                            color: col, strong: !!e.f, start: now, life: e.f ? 310 : 230 });
                        fx.push({ kind: 'ring', x: e.x * S, y: e.y * S,
                            r0: 7, r1: e.f ? 56 : 39, color: col,
                            width: e.f ? 4 : 2, start: now, life: 270 });
                    }
                    if (anim && hh && hh.name === 'NOAH') { noahImpact(e, now); break }
                    if (anim && hh && heroImpact(e, now, hh)) break;
                    const px = e.x * S, py = e.y * S - 40;
                    const big = e.c || e.f; // crit or 3rd-hit finisher
                    const sheet = e.c ? (e.h === 3 ? 'espiritCrit' : 'critFlash') : e.f ? 'critFlash' : 'hitSpark';
                    fx.push({ kind: 'sheet', key: sheet, x: px + (Math.random() - .5) * 10, y: py + (Math.random() - .5) * 10, w: big ? 64 : 34, start: now, life: A ? A.duration(sheet) : 220 });
                    // Expanding impact ring on the floor under the target.
                    fx.push({ kind: 'ring', x: e.x * S, y: e.y * S, r0: 8, r1: e.f ? 62 : big ? 44 : 30, color: e.c ? '#FFD36D' : e.f ? '#FFF1C5' : '#FFF2B5', width: e.f ? 5 : 3, start: now, life: e.f ? 320 : 230 });
                    burst(px, py, e.c ? '#FFD36D' : '#FFF2B5', e.f ? 16 : e.c ? 12 : 5, e.f ? 6 : e.c ? 5 : 4);
                    if (e.f) burst(px, py, heroCfg(latestHero(e.h)?.name).color, 8, 6);
                    if (e.h === 3) burst(px, py, '#FFE17B', 6, 4, { life: 320, size: 4 }); // Espirit: gold arrow sparks
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
                    burst(e.x * S, e.y * S - 30, '#FF6C78', 7, 4); // enemies.md death burst (smaller; the die frames carry it)
                    const last = e.prev || (prevSnap && prevSnap.enemies.find(v => v[0] === e.id));
                    if (last) { // die frames + a short knockback slide away from the killer
                        const art = A && A.ENEMY_ART[last[1]], kh = latestHero(e.h);
                        const ddx = kh ? last[2] - kh.x : 0, ddy = kh ? last[3] - kh.y : 0, dd = Math.hypot(ddx, ddy) || 1;
                        ghosts.push({ e: last.slice(), start: now, life: art && A.ready(art.die) ? A.duration(art.die) + 120 : 380, kx: ddx / dd * 16, ky: ddy / dd * 8 });
                        recoils.delete(e.id);
                    }
                    emitO('dust', e.x * S, e.y * S - 6, -Math.PI / 2, .6);
                    sfx('stagger', e.h, { gain: .5 });
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
                    // Each ultimate gets a distinct ground-level signature burst.
                    const ultimatePalette = {
                        NOAH: '#aa88ff', DESTINY: '#ffe1a0',
                        MARKIE: '#ff9355', ESPIRIT: '#80efaf'
                    };
                    const uc = ultimatePalette[h.name] || '#fff4b5';
                    fx.push({ kind: 'ring', x: h.x * S, y: h.y * S,
                        r0: 12, r1: r * .7, color: uc, width: 5,
                        start: now, life: 560 });
                    burst(h.x * S, h.y * S - 14, uc, 12, 4,
                        { life: 520, size: 4, lift: 1.8 });
                    if (h.name === 'DESTINY' && SH) fx.push({ kind: 'ov', sheet: 'destinyGuard', n: 8, fd: 70, follow: e.h, sc: 2.2 * uiScale(), start: now, life: 560 }); // gold shield + mint heal ring
                    if (h.name === 'DESTINY') sfx('healChime', e.h);
                    addShake(3, 150, now);
                    floatText(h.x * S, h.y * S - 112, e.k, heroCfg(h.name).color, isMine(e.h) ? 14 : 11, 1100); // small tag at the hero, not a banner
                    break;
                }
                case 'awaken': {
                    const h = latestHero(e.h);
                    if (!h) break;
                    const col = HERO_FINISH[h.name]?.primary || heroCfg(h.name).color;
                    fx.push({ kind: 'ring', x: h.x * S, y: h.y * S, r0: 8, r1: 100, color: col, width: 5, start: now, life: 720 });
                    burst(h.x * S, h.y * S - 45, col, 18, 5);
                    floatText(h.x * S, h.y * S - 135, 'AWAKENED', col, 19, 1200);
                    if (isMine(e.h)) addShake(4, 220, now);
                    break;
                }
                case 'boss:enter': {
                    banners.push({ str: 'THE VOID EMPEROR AWAKENS', color: '#e6a8ff', born: now, life: 2300 });
                    fx.push({ kind: 'ring', x: e.x * S, y: e.y * S, r0: 8, r1: 170, color: '#bd71ef', width: 7, start: now, life: 1200 });
                    burst(e.x * S, e.y * S - 75, '#d89aff', 24, 5);
                    addShake(5, 380, now);
                    break;
                }
                case 'boss:target': {
                    fx.push({ kind: 'bossTarget', x: e.x * S, y: e.y * S, r: e.r * S, start: now, life: e.ms });
                    break;
                }
                case 'slam': addShake(5, 170, now); fx.push({ kind: 'floor', key: 'impact', x: e.x * S, y: e.y * S, r: (e.r || SLAM_R) * S, start: now, life: A ? A.duration('impact') : 420 }); break;
                case 'down': { const h = latestHero(e.h); if (h) banners.push({ str: h.name + ' DOWN • STAND CLOSE TO REVIVE', color: '#ff8a8a', born: now, life: 2200, small: true }); break }
                case 'revive': {
                    const h = latestHero(e.h);
                    if (!h) break;
                    fx.push({ kind: 'floor', key: 'reviveRing', x: h.x * S, y: h.y * S, r: 60, start: now, life: A ? A.duration('reviveRing') : 640 });
                    burst(h.x * S, h.y * S - 40, '#A5FFBF', 16, 5);
                    banners.push({ str: h.name + ' REVIVED', color: '#A5FFBF', born: now, life: 1300, small: true });
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
                    sfx('pickup', e.h);
                    fx.push({ kind: 'ring', x: e.x * S, y: e.y * S, r0: 10, r1: 80, color: P.color, width: 4, start: now, life: 380 });
                    burst(e.x * S, e.y * S - 30, P.color, 14, 5); burst(e.x * S, e.y * S - 30, P.core, 8, 3);
                    if (h) floatText(h.x * S, h.y * S - 118, P.label + (P.key === 'heal' ? '' : '!'), P.core, 22, 1000);
                    if (h && isMine(e.h)) banners.push({ str: P.label + (P.key === 'heal' ? ' +32% HP' : P.key === 'fury' ? ' • CRIT UP' : P.key === 'haste' ? ' • SPEED UP' : ' • DMG DOWN'), color: P.core, born: now, life: 1200, small: true });
                    break;
                }
                case 'syn': { // SQUAD SYNERGY: gold particles on every boosted hero + a short banner
                    stats.synergy = (stats.synergy || 0) + 1;
                    for (const j of e.all || []) { const u = latestHero(j); if (u) { burst(u.x * S, u.y * S - 50, '#FFD36D', 10, 4, { life: 600 }); burst(u.x * S, u.y * S - 50, '#E6AD57', 6, 2, { lift: 2.2, grav: 0, life: 700 }) } }
                    banners.push({ str: 'SYNERGY • CRIT UP', color: '#FFD36D', born: now, life: 1500, small: true });
                    break;
                }
                case 'lvl': {
                    for (const j of e.all || []) {
                        const u = latestHero(j); if (!u) continue;
                        const color = heroCfg(u.name).color;
                        fx.push({ kind: 'levelup', i: j, color, start: now + j * 90, life: 1700 });
                        if (anim) anim.onLevelUp(j, now + j * 90);
                        floatText(u.x * S, u.y * S - 130, 'Lv ' + (u.lv || e.lv), '#FFE9A8', 20, 1400);
                    }
                    banners.push({ str: 'LEVEL UP • Lv ' + e.lv, color: '#FFD36D', born: now, life: 2200 });
                    if (e.mastery) {
                        const rank = e.mastery === 1 ? 'I' : 'II';
                        banners.push({ str: 'MASTERY ' + rank + ' UNLOCKED', color: '#a7f3d0', born: now + 450, life: 2600 });
                    }
                    stats.levelUps = (stats.levelUps || 0) + 1;
                    sfx('levelUp');
                    break;
                }
                case 'wave': banners.push({ str: 'WAVE ' + e.n + (e.boss ? ' • BOSS' : ''), color: '#FFD36D', born: now, life: 1600 }); break;
                case 'clear': sfx('waveCleared'); banners.push({ str: 'WAVE ' + e.n + ' CLEARED • +25 HP', color: '#9ef0c0', born: now, life: 1800 }); break;
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
            if (k > 1.15) return drawHudCompact(view, room, myId, k, now);
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

        // Banners live in one slim band under the top HUD (sky area, above the floor where units walk), so they
        // never cover characters: one main line (newest) + at most one small line, short text, quick fade.
        // Phones (canvas shown small): a slim, low-clutter HUD. Squad = 4 compact rows (colour chip, name, HP bar)
        // in the top-left; wave/score/KOs centred at the top (the RETURN/LEAVE buttons own the top-right corner);
        // special status + buff timers as small pills. The canvas itself sits inside the safe area (CSS).
        function drawHudCompact(view, room, myId, k, now) {
            const W = canvas.width, ks = Math.min(k, 1.5), hud = view.hud || {};
            const mine = view.heroes.findIndex((h, i) => { const p = controllerOf(room, i); return p && p.id === myId });
            g.save();
            g.scale(ks, ks);
            const x0 = 10, y0 = 10, rowH = 15, pw = 150;
            g.fillStyle = 'rgba(14,12,28,.62)'; g.fillRect(x0, y0, pw, 8 + view.heroes.length * rowH);
            g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = 'bold 10px monospace';
            view.heroes.forEach((h, i) => {
                const y = y0 + 4 + i * rowH + rowH / 2, human = controllerOf(room, i), me = human && human.id === myId;
                g.fillStyle = heroCfg(h.name).color; g.fillRect(x0 + 6, y - 4, 7, 7);
                g.fillStyle = me ? '#ffd279' : human ? '#fff2c9' : '#a8f0c6';
                g.fillText(h.name + ' ' + (h.lv || 1) + (me ? '★' : human ? '' : ' AI'), x0 + 17, y);
                g.fillStyle = '#292035'; g.fillRect(x0 + 92, y - 3, 50, 6);
                g.fillStyle = h.state ? '#8a3a4a' : (h.hp / (h.maxHp || 100) < .3 ? '#f0a05a' : '#72dba3');
                g.fillRect(x0 + 92, y - 3, 50 * Math.max(0, (h.hp || 0) / (h.maxHp || 100)), 6);
            });
            // centre top: wave • score • KOs (+ enemies left / next wave)
            const cx = W / ks / 2;
            g.textAlign = 'center'; g.font = 'bold 13px monospace';
            const line = 'WAVE ' + (hud.wave || 0) + '  •  ' + (hud.score || 0) + '  •  ' + (hud.kills || 0) + ' KO';
            g.fillStyle = 'rgba(14,12,28,.55)'; const tw = g.measureText(line).width + 18; g.fillRect(cx - tw / 2, 8, tw, 20);
            g.fillStyle = '#ffe4ac'; g.fillText(line, cx, 18);
            g.font = '10px monospace'; g.fillStyle = '#cfc3e8';
            g.fillText(hud.ws ? (hud.left || 0) + ' LEFT' : 'NEXT WAVE ' + Math.ceil((hud.next || 0) / 1000) + 's', cx, 36);
            if (mine >= 0) { // special pill + buff pills under the squad
                const h = view.heroes[mine], cd = h.cd || 0;
                let px = x0, py = y0 + 14 + view.heroes.length * rowH;
                g.textAlign = 'left'; g.font = 'bold 10px monospace';
                const pill = (str, col, frac) => { const w = g.measureText(str).width + 12; g.fillStyle = 'rgba(14,12,28,.62)'; g.fillRect(px, py, w, 15); if (frac !== undefined) { g.fillStyle = col; g.fillRect(px, py + 13, w * frac, 2) } g.fillStyle = col; g.fillText(str, px + 6, py + 8); px += w + 4 };
                pill(cd ? 'SPECIAL ' + (cd / 10).toFixed(1) + 's' : 'SPECIAL READY', cd ? '#c9b8e8' : '#9ef0c0');
                const pu = h.pu || [];
                for (let j = 0; j < 4; j++) if (pu[j]) pill(BUFF[j].label + ' ' + (pu[j] / 10).toFixed(0) + 's', BUFF[j].core, Math.min(1, pu[j] / BUFF_MAX[j]));
            }
            if (hud.combo >= 2) {
                g.textAlign = 'center'; g.font = 'bold 12px monospace'; g.lineWidth = 3; g.strokeStyle = '#0B0A18';
                const str = 'COMBO x' + Math.min(5, 1 + Math.floor(hud.combo / 4)) + ' • ' + hud.combo;
                g.strokeText(str, cx, 52); g.fillStyle = '#FFCB83'; g.fillText(str, cx, 52);
            }
            g.textBaseline = 'alphabetic';
            g.restore();
        }

        // A persistent boss bar, sourced entirely from the authoritative snapshot.
        function drawBossBar(view, k) {
            const boss = view.hud && view.hud.boss;
            if (!boss) return;
            const compact = k > 1.15, width = compact ? 300 : 460;
            const x = (canvas.width - width) / 2, y = compact ? 104 : 126;
            const hp = Math.max(0, Math.min(1, boss.hp / (boss.max || 1)));
            g.save();
            g.fillStyle = 'rgba(12,8,26,.85)';
            g.fillRect(x - 10, y - 27, width + 20, 55);
            g.font = 'bold 16px monospace';
            g.textAlign = 'center';
            g.fillStyle = '#f1c5ff';
            g.fillText(boss.name, canvas.width / 2, y - 8);
            g.fillStyle = '#382744';
            g.fillRect(x, y, width, 14);
            g.fillStyle = '#ba60e8';
            g.fillRect(x, y, width * hp, 14);
            g.strokeStyle = '#e7b7ff';
            g.lineWidth = 2;
            g.strokeRect(x, y, width, 14);
            g.restore();
        }

        function drawBanners(now, k) {
            const W = canvas.width, compact = k > 1.15;
            for (let j = banners.length - 1; j >= 0; j--) if (now - banners[j].born > banners[j].life) banners.splice(j, 1);
            const big = banners.filter(b => !b.small).slice(-1), small = banners.filter(b => b.small).slice(-1);
            if (!big.length && !small.length) return;
            const ks = Math.min(k, 1.4), bandY = (compact ? 64 : 104) * ks, bigPx = Math.round((compact ? 22 : 28) * ks), smPx = Math.round((compact ? 14 : 16) * ks);
            const bandH = (big.length ? bigPx + 10 : 0) + (small.length ? smPx + 8 : 0) + 6;
            let alpha = 0;
            for (const b of big.concat(small)) alpha = Math.max(alpha, Math.min(1, (1 - (now - b.born) / b.life) * 4, (now - b.born) / 120));
            g.save();
            g.globalAlpha = .55 * alpha; // translucent strip behind the text, fades with it
            const gr = g.createLinearGradient(W * .2, 0, W * .8, 0);
            gr.addColorStop(0, 'rgba(11,10,24,0)'); gr.addColorStop(.25, 'rgba(11,10,24,1)'); gr.addColorStop(.75, 'rgba(11,10,24,1)'); gr.addColorStop(1, 'rgba(11,10,24,0)');
            g.fillStyle = gr; g.fillRect(W * .2, bandY, W * .6, bandH);
            g.textAlign = 'center'; g.textBaseline = 'top';
            let y = bandY + 5;
            for (const b of big) {
                const t = (now - b.born) / b.life, pop = Math.min(1, (now - b.born) / 120);
                g.globalAlpha = Math.min(1, (1 - t) * 4) * pop;
                g.font = 'bold ' + bigPx + 'px monospace';
                g.lineWidth = 5; g.strokeStyle = '#0B0A18'; g.strokeText(b.str, W / 2, y + (1 - pop) * 6);
                g.fillStyle = b.color; g.fillText(b.str, W / 2, y + (1 - pop) * 6);
                y += bigPx + 8;
            }
            for (const b of small) {
                const t = (now - b.born) / b.life;
                g.globalAlpha = Math.min(1, (1 - t) * 4);
                g.font = 'bold ' + smPx + 'px monospace';
                g.lineWidth = 4; g.strokeStyle = '#0B0A18'; g.strokeText(b.str, W / 2, y);
                g.fillStyle = b.color; g.fillText(b.str, W / 2, y);
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
                if (el < 0) continue; // delayed effect (e.g. the crit's second ring) not started yet
                if (f.kind === 'bossTarget') {
                    const p = Math.max(0, Math.min(1, el / f.life));
                    g.save();
                    g.globalAlpha = 0.35 + p * 0.5;
                    g.fillStyle = 'rgba(180,66,230,.18)';
                    g.strokeStyle = p > .72 ? '#ffe5ff' : '#d278fa';
                    g.lineWidth = 3 + p * 3;
                    g.beginPath(); g.ellipse(f.x, f.y, f.r, f.r * .55, 0, 0, Math.PI * 2); g.fill(); g.stroke();
                    g.beginPath(); g.moveTo(f.x - 13, f.y); g.lineTo(f.x + 13, f.y);
                    g.moveTo(f.x, f.y - 13); g.lineTo(f.x, f.y + 13); g.stroke();
                    g.restore();
                } else if (f.kind === 'special') {
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
                } else if (f.kind === 'crack') { // Markie ground impact: stone cracks + hot glow + ring
                    const t = el / f.life, fade = 1 - t;
                    g.save(); g.translate(f.x, f.y);
                    g.globalAlpha = .55 * fade; g.fillStyle = '#FFC277'; g.globalCompositeOperation = 'lighter';
                    g.beginPath(); g.ellipse(0, 0, f.r * (.5 + .5 * t), f.r * .36 * (.5 + .5 * t), 0, 0, Math.PI * 2); g.fill();
                    g.globalCompositeOperation = 'source-over';
                    g.globalAlpha = Math.min(1, fade * 1.6); g.strokeStyle = '#55616A'; g.lineWidth = f.fin ? 4 : 3;
                    for (const c of f.cracks) { g.beginPath(); g.moveTo(0, 0); for (const [cx, cy] of c) g.lineTo(cx * f.r, cy * f.r * .42); g.stroke() }
                    g.strokeStyle = '#FF9657'; g.lineWidth = 1.5; g.globalAlpha = fade;
                    for (const c of f.cracks) { g.beginPath(); g.moveTo(0, 0); for (const [cx, cy] of c) g.lineTo(cx * f.r, cy * f.r * .42); g.stroke() }
                    g.restore();
                } else if (f.kind === 'floor' && A) {
                    A.play(g, f.key, el, f.x, f.y, f.r * 2, f.r * 2 * .5);
                }
            }
        }
        // Over-unit layer: attack trails, Espirit arrows, sparks, auras that follow a hero.
        // Noah: arcane energy on every basic attack -- a glowing violet/cyan sweep arc with runes riding it.
        // Drawn in the swing's rotated frame (+x = aim). Palette #7A5FE0 #637BFF #79E4FF #D8FFFF.
        function arcaneArc(t, size, fin, now) {
            const r = size * .42, sweep = 1.1, a0 = -sweep, a1 = -sweep + 2 * sweep * Math.min(1, t * 1.6), fade = 1 - t;
            g.save();
            g.globalCompositeOperation = 'lighter';
            g.lineCap = 'round';
            g.globalAlpha = .38 * fade; g.strokeStyle = '#7A5FE0'; g.lineWidth = (fin ? 20 : 14);
            g.beginPath(); g.arc(0, 0, r, a0, a1); g.stroke();
            g.globalAlpha = .7 * fade; g.strokeStyle = '#53BAFF'; g.lineWidth = fin ? 8 : 5;
            g.beginPath(); g.arc(0, 0, r, a0, a1); g.stroke();
            g.globalAlpha = .95 * fade; g.strokeStyle = '#D8FFFF'; g.lineWidth = 2;
            g.beginPath(); g.arc(0, 0, r, Math.max(a0, a1 - .7), a1); g.stroke();
            // runes: small rotating diamonds and squares along the arc
            const n = fin ? 5 : 3;
            for (let j = 0; j < n; j++) {
                const an = a0 + (a1 - a0) * (j + .5) / n, rr = r + Math.sin(now / 90 + j) * 6;
                g.save(); g.translate(Math.cos(an) * rr, Math.sin(an) * rr); g.rotate(now / 160 + j);
                g.globalAlpha = .9 * fade; g.strokeStyle = j % 2 ? '#79E4FF' : '#A48BFF'; g.lineWidth = 2;
                const q = fin ? 7 : 5;
                if (j % 2) g.strokeRect(-q, -q, 2 * q, 2 * q); else { g.beginPath(); g.moveTo(0, -q * 1.3); g.lineTo(q, 0); g.lineTo(0, q * 1.3); g.lineTo(-q, 0); g.closePath(); g.stroke() }
                g.restore();
            }
            g.restore();
        }
        // Markie: heavy bronze cleave arc (wide, thick, hot core) -- weight before the sprite slash.
        function mightyArc(t, size, fin) {
            const r = size * .36, fade = 1 - t, a1 = -Math.PI * .85 + Math.PI * 1.7 * Math.min(1, t * 2.2);
            g.save();
            g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
            g.globalAlpha = .45 * fade; g.strokeStyle = '#C98A4B'; g.lineWidth = fin ? 26 : 18;
            g.beginPath(); g.arc(0, 0, r, -Math.PI * .85, a1); g.stroke();
            g.globalAlpha = .75 * fade; g.strokeStyle = '#FF9657'; g.lineWidth = fin ? 10 : 7;
            g.beginPath(); g.arc(0, 0, r, -Math.PI * .85, a1); g.stroke();
            g.globalAlpha = fade; g.strokeStyle = '#FFF0A4'; g.lineWidth = 3;
            g.beginPath(); g.arc(0, 0, r, Math.max(-Math.PI * .85, a1 - .9), a1); g.stroke();
            g.restore();
        }
        // Cached soft-glow sprites (radial gradients are built once per color, then drawn as images).
        const glowCache = new Map();
        function glowSprite(color) {
            let c = glowCache.get(color);
            if (c) return c;
            c = document.createElement('canvas'); c.width = c.height = 64;
            const gg = c.getContext('2d'), gr = gg.createRadialGradient(32, 32, 0, 32, 32, 32);
            gr.addColorStop(0, color); gr.addColorStop(.35, color + 'aa'); gr.addColorStop(1, color + '00');
            gg.fillStyle = gr; gg.fillRect(0, 0, 64, 64);
            glowCache.set(color, c); return c;
        }
        const pillarCache = new Map();
        function pillarSprite(color) { // vertical light column for LEVEL UP
            let c = pillarCache.get(color);
            if (c) return c;
            c = document.createElement('canvas'); c.width = 32; c.height = 256;
            const gg = c.getContext('2d');
            const v = gg.createLinearGradient(0, 0, 0, 256); v.addColorStop(0, color + '00'); v.addColorStop(.55, color + 'aa'); v.addColorStop(1, color + 'ff');
            gg.fillStyle = v; gg.fillRect(0, 0, 32, 256);
            gg.globalCompositeOperation = 'destination-in';
            const hgr = gg.createLinearGradient(0, 0, 32, 0); hgr.addColorStop(0, '#0000'); hgr.addColorStop(.5, '#000f'); hgr.addColorStop(1, '#0000');
            gg.fillStyle = hgr; gg.fillRect(0, 0, 32, 256);
            pillarCache.set(color, c); return c;
        }
        function drawCombatImpact(f, now) {
            const p = (now - f.start) / f.life;
            if (p < 0 || p > 1) return;
            const fade = (1 - p) * (1 - p);
            const length = (f.strong ? 78 : 52) * (0.4 + p * .8);
            g.save();
            g.translate(f.x, f.y);
            g.rotate(f.angle);
            g.globalCompositeOperation = 'lighter';
            g.globalAlpha = fade * .9;
            g.strokeStyle = f.color;
            g.lineCap = 'round';
            g.lineWidth = f.strong ? 8 : 5;
            g.beginPath(); g.moveTo(-length * .45, 0); g.lineTo(length * .55, 0); g.stroke();
            g.strokeStyle = '#fffaf0'; g.lineWidth = 2.5;
            g.beginPath(); g.moveTo(-length * .28, 0); g.lineTo(length * .42, 0); g.stroke();
            // Four outward sparks emphasize force without obstructing the heroes.
            for (let j = 0; j < 4; j++) {
                const theta = j * Math.PI / 2 + .4;
                const radius = 10 + p * (f.strong ? 42 : 27);
                const x = Math.cos(theta) * radius, y = Math.sin(theta) * radius;
                g.beginPath(); g.moveTo(x, y);
                g.lineTo(x + Math.cos(theta) * 10 * fade, y + Math.sin(theta) * 10 * fade);
                g.stroke();
            }
            g.restore();
        }

        function drawFlashFx(f, now, view) {
            const el = now - f.start; if (el < 0) return;
            const t = el / f.life;
            if (f.kind === 'flash') { // bright impact flash at the collision point: glow + 4-point star
                const r = f.r * (1 + t * .6);
                g.globalCompositeOperation = 'lighter';
                g.globalAlpha = (1 - t);
                g.drawImage(glowSprite(f.color), f.x - r, f.y - r, r * 2, r * 2);
                g.fillStyle = '#FFFFFF'; g.globalAlpha = (1 - t) * .9;
                const a = r * 1.3 * (1 - t * .5), b = r * .12;
                g.beginPath(); g.moveTo(f.x - a, f.y); g.lineTo(f.x, f.y - b); g.lineTo(f.x + a, f.y); g.lineTo(f.x, f.y + b); g.closePath(); g.fill();
                g.beginPath(); g.moveTo(f.x, f.y - a * .7); g.lineTo(f.x + b, f.y); g.lineTo(f.x, f.y + a * .7); g.lineTo(f.x - b, f.y); g.closePath(); g.fill();
                g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
            } else if (f.kind === 'shock') { // expanding magical shockwave (bright rim + dark refractive inner ring)
                const e = 1 - (1 - t) * (1 - t), r = f.r0 + (f.r1 - f.r0) * e;
                g.globalAlpha = .28 * (1 - t); g.strokeStyle = '#06122e'; g.lineWidth = 9 * (1 - t) + 2;
                g.beginPath(); g.ellipse(f.x, f.y, r * .9, r * .9 * .42, 0, 0, Math.PI * 2); g.stroke();
                g.globalCompositeOperation = 'lighter';
                g.globalAlpha = .8 * (1 - t); g.strokeStyle = '#53BAFF'; g.lineWidth = 5 * (1 - t) + 1;
                g.beginPath(); g.ellipse(f.x, f.y, r, r * .42, 0, 0, Math.PI * 2); g.stroke();
                g.globalAlpha = .9 * (1 - t); g.strokeStyle = '#E8FFFF'; g.lineWidth = 1.5;
                g.beginPath(); g.ellipse(f.x, f.y, r * 1.02, r * 1.02 * .42, 0, 0, Math.PI * 2); g.stroke();
                g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
            } else if (f.kind === 'levelup') { // light pillar + rising rune circle in the hero's color
                const h = view.heroes[f.i]; if (!h) return;
                const x = h.x * S, y = h.y * S, k = uiScale();
                const sheet = tintedLevelup(h.name);
                if (sheet && el < 700) { // Draper's tinted pillar + rune sheet (10 frames x 70 ms), feet anchored
                    const fr = Math.min(9, Math.floor(el / 70)), sc = 1.6 * Math.min(k, 1.3);
                    g.imageSmoothingEnabled = false;
                    g.drawImage(sheet, fr * 64, 0, 64, 128, Math.round(x - 32 * sc), Math.round(y - 118 * sc), 64 * sc, 128 * sc);
                }
                const inA = Math.min(1, el / 180), out = t > .6 ? 1 - (t - .6) / .4 : 1, a = inA * out;
                g.globalCompositeOperation = 'lighter';
                const pw = (34 + 14 * Math.sin(el / 90)) * Math.min(k, 1.3) * (1 - t * .4), ph = 300 * Math.min(k, 1.2);
                g.globalAlpha = .7 * a; g.drawImage(pillarSprite(f.color), x - pw / 2, y - ph, pw, ph);
                g.globalAlpha = .9 * a; g.drawImage(pillarSprite('#ffffff'), x - pw / 6, y - ph * .8, pw / 3, ph * .8);
                for (let j = 0; j < 2; j++) { // two rune rings rising up the pillar
                    const u = ((el / 900) + j * .5) % 1, ry = y - u * 110 * Math.min(k, 1.3), rr = (38 - u * 10) * Math.min(k, 1.3);
                    g.globalAlpha = a * (1 - u); g.strokeStyle = f.color; g.lineWidth = 2;
                    g.beginPath(); g.ellipse(x, ry, rr, rr * .38, 0, 0, Math.PI * 2); g.stroke();
                    g.fillStyle = '#FFFFFF';
                    for (let q = 0; q < 8; q++) { const an = q * Math.PI / 4 + el / 400 * (j ? -1 : 1); g.fillRect(Math.round(x + Math.cos(an) * rr - 1.5), Math.round(ry + Math.sin(an) * rr * .38 - 1.5), 3, 3) }
                }
                g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
                if (Math.random() < .5 * a) pool.emit(1, p => { p.x = x + (Math.random() - .5) * 40; p.y = y - Math.random() * 30; p.vy = -.08 - Math.random() * .08; p.vx = (Math.random() - .5) * .02; p.kind = 3; p.size = 2 + Math.random() * 2; p.life = 700; p.color = Math.random() < .5 ? f.color : '#FFFFFF'; p.add = true });
            }
        }
        // One-shot overhaul FX sheet: a per-hero hitflash (OV.hit*), or a hero-sheets FX (f.sheet), nearest-neighbor.
        function drawOv(f, now, view, k) {
            const el = now - f.start; if (el < 0) return;
            const fr = Math.floor(el / f.fd); if (fr >= f.n) return;
            let x = f.x, y = f.y;
            if (f.follow !== undefined) { const h = view.heroes[f.follow]; if (!h) return; x = h.x * S; y = h.y * S - 30 * k }
            if (f.sheet) { g.save(); g.translate(Math.round(x), Math.round(y)); SH.draw(g, f.sheet, fr, false, f.sc); g.restore(); return }
            const im = OV[f.key]; if (!im) return;
            const sz = 32 * f.sc * Math.min(k, 1.3);
            g.imageSmoothingEnabled = false;
            g.drawImage(im, fr * 32, 0, 32, 32, Math.round(x - sz / 2), Math.round(y - sz / 2), sz, sz);
        }
        // Espirit's arrow: launched on the bow's release frame from the bow hand, Draper's glowing arrow loop
        // (arrowhead points right, rotated to the flight angle) with a short gold trail.
        function drawArrow(f, now, k) {
            const el = now - f.rel; if (el < 0 || el > f.flight) return;
            const t = el / f.flight, fin = f.stage === 2;
            const sx = f.x * S + f.aim.x * 18 * k, sy = f.y * S - 38 * k + f.aim.y * 10 * k, ex = f.tx * S, ey = f.ty * S - 38 * k;
            const hx = lerp(sx, ex, t), hy = lerp(sy, ey, t), ang = Math.atan2(ey - sy, ex - sx);
            const t0 = Math.max(0, t - .22), tx0 = lerp(sx, ex, t0), ty0 = lerp(sy, ey, t0);
            g.save();
            g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
            g.globalAlpha = .55; g.strokeStyle = '#FFB948'; g.lineWidth = (fin ? 4 : 2.5) * Math.min(k, 1.3);
            g.beginPath(); g.moveTo(tx0, ty0); g.lineTo(hx, hy); g.stroke();
            g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
            g.translate(Math.round(hx), Math.round(hy)); g.rotate(ang);
            const sc = (fin ? 1.25 : 1) * Math.min(k, 1.3);
            if (!(SH && SH.draw(g, 'arrowGlow', Math.floor(now / 50) % 6, false, sc)) && A) A.loop(g, 'espiritArrow', now, 0, 0, KIT.ESPIRIT.atkW * k);
            g.restore();
            if (Math.random() < .4) emitO('arrowTrail', hx, hy, ang + Math.PI, 1, OC.ESPIRIT);
            // Additional visible arrows correspond to additional server-authoritative targets.
            // If no secondary enemy exists, show a harmless parallel arrow (never fake a hit).
            const n = 1 + (f.mastery || 0);
            for (let j = 1; j < n; j++) {
                const dest = f.volley && f.volley[j];
                const offset = (j % 2 ? 1 : -1) * Math.ceil(j / 2) * 13 * Math.min(k, 1.3);
                const tx = dest ? dest.x * S : ex, ty = dest ? dest.y * S - 38 * k : ey + offset;
                const x = lerp(sx, tx, t), y = lerp(sy + offset * .5, ty, t);
                const px = lerp(sx, tx, t0), py = lerp(sy + offset * .5, ty, t0);
                const a = Math.atan2(ty - (sy + offset * .5), tx - sx);
                g.save(); g.globalCompositeOperation = 'lighter';
                g.strokeStyle = '#b9ffd6'; g.globalAlpha = .7; g.lineWidth = 2.5;
                g.beginPath(); g.moveTo(px, py); g.lineTo(x, y); g.stroke();
                g.translate(Math.round(x), Math.round(y)); g.rotate(a);
                g.fillStyle = '#eaffee'; g.fillRect(-10, -2, 18, 4);
                g.beginPath(); g.moveTo(12, 0); g.lineTo(3, -5); g.lineTo(3, 5); g.closePath(); g.fill();
                g.restore();
            }
        }
        function drawActionFx(view, now, k, dt) {
            if (anim) {
                const room = opts.getRoom(), myId = opts.getMyId();
                view.heroes.forEach((h, i) => {
                    if (h.state || !anim.hasPose(h.name)) return;
                    const p = controllerOf(room, i), role = p ? (p.id === myId ? 'me' : 'human') : 'ai';
                    g.save(); g.translate(Math.round(h.x * S), Math.round(h.y * S)); g.scale(k, k);
                    anim.drawFx(g, h, i, now, dt, k, lookFor(role, heroCfg(h.name).color), h.x * S, h.y * S);
                    g.restore();
                });
            }
            for (const f of fx) {
                const el = now - f.start;
                if (f.kind === 'combatImpact') { drawCombatImpact(f, now); continue }
                if (f.kind === 'flash' || f.kind === 'shock' || f.kind === 'levelup') { drawFlashFx(f, now, view); continue }
                if (f.kind === 'ov') { drawOv(f, now, view, k); continue }
                if (f.kind === 'attack' && f.pose && f.name === 'ESPIRIT') { drawArrow(f, now, k); continue }
                if (f.kind === 'attack' && f.pose) continue; // drawn by hero-anim (blade-path crescent / sheets)
                if (f.kind === 'attack' && A) {
                    const h = view.heroes[f.i] || f, kit = KIT[f.name];
                    if (!kit) continue;
                    if (f.name === 'ESPIRIT') { // projectile from the bow to the target
                        const t = Math.min(1, el / f.life), t0 = Math.max(0, t - .38);
                        const sx = f.x * S + f.facing * 20, sy = f.y * S - 38, ex = f.tx * S, ey = f.ty * S - 38;
                        const hx = lerp(sx, ex, t), hy = lerp(sy, ey, t), tx0 = lerp(sx, ex, t0), ty0 = lerp(sy, ey, t0);
                        // Gold trail + glow (Espirit palette #D3A14B #FFE17B #FFF9D4 #FFB948), additive, no blur.
                        g.save();
                        g.globalCompositeOperation = 'lighter';
                        const grad = g.createLinearGradient(tx0, ty0, hx, hy);
                        grad.addColorStop(0, 'rgba(211,161,75,0)'); grad.addColorStop(1, 'rgba(255,185,72,.85)');
                        g.strokeStyle = grad; g.lineCap = 'round';
                        g.lineWidth = 9 * Math.min(k, 1.3); g.beginPath(); g.moveTo(tx0, ty0); g.lineTo(hx, hy); g.stroke();
                        g.strokeStyle = '#FFF4AD'; g.globalAlpha = .9; g.lineWidth = 2.5;
                        g.beginPath(); g.moveTo(lerp(tx0, hx, .45), lerp(ty0, hy, .45)); g.lineTo(hx, hy); g.stroke();
                        g.globalAlpha = .45 + .15 * Math.sin(now / 40); g.fillStyle = '#FFE17B';
                        g.beginPath(); g.arc(hx, hy, 13 * Math.min(k, 1.3), 0, Math.PI * 2); g.fill();
                        g.globalAlpha = .9; g.fillStyle = '#FFF9D4'; g.beginPath(); g.arc(hx, hy, 4.5, 0, Math.PI * 2); g.fill();
                        g.restore();
                        g.save();
                        g.translate(hx, hy);
                        g.rotate(Math.atan2(ey - sy, ex - sx));
                        A.loop(g, 'espiritArrow', now, 0, 0, kit.atkW * k);
                        g.globalCompositeOperation = 'lighter'; g.globalAlpha = .55; A.loop(g, 'espiritArrow', now, 0, 0, kit.atkW * k); // gold-hot redraw
                        g.restore();
                        if (t < 1 && Math.random() < .5) burst(hx, hy, Math.random() < .5 ? '#FFE17B' : '#FFB948', 1, 1.2, { life: 260, size: 4, grav: .02 });
                    } else {
                        // Directional swing: the sheet faces right; mirror for leftward aims, then rotate to
                        // the 8-way aim (up/down/diagonals). Markie's cleave is 360° so it only mirrors.
                        const a = f.aim, fin = f.stage === 2, size = kit.atkW * Math.min(k, 1.15) * (fin ? 1.35 : 1); // world-scale reach: barely grows on phones
                        g.save();
                        g.translate(h.x * S, h.y * S - 34 * k);
                        if (a.x < -0.01) g.scale(-1, 1);
                        if (f.name !== 'MARKIE') g.rotate(Math.atan2(a.y, Math.abs(a.x) < 0.01 ? 0.0001 : Math.abs(a.x)));
                        const ox = f.name === 'MARKIE' ? 0 : kit.atkW * .28 * Math.min(k, 1.15);
                        const t = Math.min(1, el / f.life);
                        if (f.name === 'NOAH') arcaneArc(t, size, fin, now);
                        else if (f.name === 'MARKIE') mightyArc(t, size, fin, a);
                        A.play(g, kit.atk, el, ox, 0, size);
                        if (fin || f.name === 'MARKIE') { g.globalAlpha = fin ? .55 : .35; g.globalCompositeOperation = 'lighter'; A.play(g, kit.atk, el, ox, 0, size * (fin ? 1.15 : 1.05)); }
                        if (f.name === 'DESTINY') { g.globalCompositeOperation = 'lighter'; g.globalAlpha = .35 * (1 - t); g.strokeStyle = '#FFE1A2'; g.lineWidth = 6; g.beginPath(); g.arc(ox * .4, 0, size * .42, -1, 1); g.stroke() }
                        g.restore();
                    }
                } else if (f.kind === 'sheet' && A) {
                    let x = f.x, y = f.y;
                    if (f.follow !== undefined) { const h = view.heroes[f.follow]; if (!h) continue; x = h.x * S; y = h.y * S }
                    A.play(g, f.key, el, x, y, f.w * k);
                }
            }
        }
        function drawParticles(now) { pool.draw(g) }
        // M5 adaptive density: track an EMA of frame time and of the frame's own work time; when frames run
        // slow, spawn fewer cosmetic particles / ambient motes (down to 35%), and recover slowly when smooth.
        // Phones (small canvas) start at 75%. Never affects gameplay, the sim, or prediction.
        let lastWork = 0, emaDt = 16.7, emaWork = 4, densityAt = 0, densityInit = false;
        function adaptDensity(now, dt) {
            if (!densityInit) { densityInit = true; pool.density = uiScale() > 1.15 ? .75 : 1 }
            emaDt += (dt - emaDt) * .08; emaWork += (lastWork - emaWork) * .08;
            stats.frameMs = Math.round(emaDt * 10) / 10; stats.workMs = Math.round(emaWork * 10) / 10;
            if (now - densityAt < 250) return;
            densityAt = now;
            if (emaDt > 20 || emaWork > 12) pool.density = Math.max(.35, pool.density - .08);
            else if (emaDt < 17.6 && emaWork < 7) pool.density = Math.min(1, pool.density + .03);
            stats.density = pool.density;
        }
        // Attack lighting: a brief additive pool of the hero's colour on the floor while they swing / shoot.
        function drawAttackLight(view, now) {
            if (!anim) return;
            g.globalCompositeOperation = 'lighter';
            view.heroes.forEach((h, i) => {
                const s = anim.stateOf(i), a = s && s.atk; if (!a || h.state) return;
                const t = (now - a.start) / 320; if (t < 0 || t >= 1) return;
                const r = (a.stage === 2 ? 120 : 84) * uiScale(), al = Math.sin(t * Math.PI) * (a.stage === 2 ? .5 : .32);
                g.globalAlpha = al; g.drawImage(glowSprite(heroCfg(h.name).color), h.x * S - r, h.y * S - r * .4, r * 2, r * .8);
            });
            g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
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
        // Readability: your hero gets a gold outline and full-strength effects; others are outlined dark and
        // their effects are dimmed (other players 80%, AI 60%) so a clumped squad doesn't turn into soup.
        const LOOKS = { me: { fx: 1, outline: '#ffd279' }, human: { fx: .8, outline: '#0b0914' }, ai: { fx: .6, outline: '#0b0914' } };
        function lookFor(role, color) { const l = LOOKS[role]; l.color = color; return l }
        // Signature looks: each hero has a readable silhouette accent and distinct energy language.
        // All effects are cosmetic, deterministic and capped to a handful of canvas paths per hero.
        const HERO_FINISH = {
            NOAH: { primary: '#a58bff', light: '#e7ddff', shape: 'runes' },
            DESTINY: { primary: '#ffd47c', light: '#fff5ce', shape: 'crown' },
            MARKIE: { primary: '#ff9c58', light: '#ffe2a1', shape: 'embers' },
            ESPIRIT: { primary: '#74e6a8', light: '#dcffe8', shape: 'leaves' },
        };
        // Anime-fantasy power silhouettes sit BEHIND the existing character artwork.
        // Their strength responds to real buffs and special-attack animation, never to random gameplay state.
        function drawAnimeMantle(h, i, now) {
            if (h.state) return;
            const skin = HERO_FINISH[h.name];
            if (!skin) return;
            const action = anim && anim.stateOf(i);
            const sp = action && action.spc;
            const specialAge = sp ? now - sp.start : Infinity;
            const surge = specialAge >= 0 && specialAge < 750 ? Math.sin(Math.PI * specialAge / 750) : 0;
            const empowered = !!(h.awake || h.buff || h.shield || (h.pu && h.pu.some(Boolean)));
            const intensity = h.awake ? .9 : empowered ? .72 : .30;
            const wave = Math.sin(now / 280 + i);
            g.save();
            g.globalCompositeOperation = 'lighter';
            g.globalAlpha = Math.min(.88, intensity + surge * .40);
            const grad = g.createLinearGradient(0, -105, 0, 12);
            grad.addColorStop(0, skin.primary + '00');
            grad.addColorStop(.52, skin.primary + '77');
            grad.addColorStop(1, skin.primary + '00');
            g.fillStyle = grad;
            // Flowing energy cloak / twin anime aura flames, anchored behind the sprite.
            for (const side of [-1, 1]) {
                g.beginPath();
                g.moveTo(side * 11, -68);
                g.bezierCurveTo(side * (37 + surge * 18), -105 - wave * 8, side * (51 + surge * 20), -54, side * (27 + surge * 14), -15);
                g.quadraticCurveTo(side * 34, -55, side * 11, -68);
                g.fill();
            }
            g.strokeStyle = skin.light;
            g.lineWidth = 1.8 + surge * 2;
            g.globalAlpha = .35 + surge * .48;
            for (const side of [-1, 1]) {
                g.beginPath();
                g.moveTo(side * 17, -76);
                g.quadraticCurveTo(side * (40 + surge * 12), -99 - wave * 8, side * (37 + surge * 15), -34);
                g.stroke();
            }
            // Special attacks briefly bloom into a circular power-up halo.
            if (surge > .03) {
                g.globalAlpha = surge * .65;
                g.strokeStyle = skin.light; g.lineWidth = 3;
                g.beginPath(); g.ellipse(0, -44, 35 + surge * 16, 51 + surge * 14, 0, 0, Math.PI * 2); g.stroke();
            }
            g.restore();
        }

        function drawHeroFinish(h, i, now, role, k) {
            if (h.state) return;
            const skin = HERO_FINISH[h.name];
            if (!skin) return;
            const phase = now / 950 + i * 1.7, pulse = (Math.sin(phase * 2) + 1) / 2;
            const active = h.awake || h.buff || h.shield || (h.pu && h.pu.some(Boolean));
            g.save();
            // A soft colored floor aura, kept beneath the combat silhouette.
            g.globalAlpha = (active ? .22 : .10) + pulse * .055;
            g.fillStyle = skin.primary;
            g.beginPath(); g.ellipse(0, 2, 28 + pulse * 4, 9 + pulse * 2, 0, 0, Math.PI * 2); g.fill();
            g.globalAlpha = active ? .92 : .66;
            g.strokeStyle = skin.primary;
            g.lineWidth = role === 'me' ? 2.5 : 1.7;
            // No floating symbols near faces: the character sprite, HP and name must remain clear.
            // Identity is conveyed by floor aura, weapon animation and brief attack effects.
            // Enhanced finishers: a brief personal energy flare after the third combo strike.
            // Uses snapshot combo stage, never modifies hit detection or authoritative combat.
            if (h.cs === 2 && h.attackN && !h.state) {
                const action = anim && anim.stateOf(i);
                const atk = action && action.atk;
                const age = atk ? now - atk.start : Infinity;
                if (age >= 0 && age < 300) {
                    const p = age / 300;
                    g.globalAlpha = (1 - p) * .8;
                    g.strokeStyle = skin.light; g.lineWidth = 3 * (1 - p) + 1;
                    g.beginPath(); g.ellipse(0, -41, 25 + p * 30, 35 + p * 20, 0, 0, Math.PI * 2); g.stroke();

                }
            }
            // A bright, restrained shoulder glint while empowered.
            if (active) {
                g.globalAlpha = .65 + pulse * .3; g.strokeStyle = skin.light; g.lineWidth = 2;
                g.beginPath(); g.moveTo(-27, -65); g.lineTo(-20, -72);
                g.moveTo(27, -65); g.lineTo(20, -72); g.stroke();
            }
            g.restore();
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
            drawAnimeMantle(h, i, now);
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
            } else if (anim && anim.hasPose(h.name)) { if (env) env.shadow(g, 1, 46); anim.drawHero(g, h, i, now, k, lookFor(role, color)) }
            else R.drawSprite(g, 0, 0, color, false, h.name, now, entity);
            if (!h.state && (h.buff || h.shield) && A) A.loop(g, 'buffAura', now, 0, -34, 58, null, false, .85, i * 90);
            drawHeroFinish(h, i, now, role, k); // rally buff / Markie shield
            // Name + controller label and HP bar above the head (V19 ally style).
            g.fillStyle = '#292035';
            g.fillRect(-22, -86, 44, 5);
            g.fillStyle = '#72dba3';
            g.fillRect(-22, -86, 44 * Math.max(0, (h.hp || 0) / (h.maxHp || 100)), 5);
            g.textAlign = 'center';
            g.font = 'bold ' + (k > 1.15 && role !== 'me' ? 10 : 12) + 'px monospace';
            if (k > 1.15 && role === 'ai') g.globalAlpha = .75; // phones: AI labels recede so clumps stay readable
            g.fillStyle = role === 'me' ? '#ffd279' : role === 'ai' ? '#a8f0c6' : '#fff2c9';
            g.fillText(h.name + ' Lv' + (h.lv || 1) + (role === 'ai' ? ' AI' : role === 'me' ? ' (YOU)' : ''), 0, -92);
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
            let [id, type, ex, ey, hpPct, facing, flags] = e;
            let tilt = 0;
            const rc = dieAt === undefined && recoils.get(id);
            if (rc) { // hit-stop hold, then a quick recoil jolt + tilt away from the hit (stagger)
                if (now < rc.holdUntil) { ex = rc.x; ey = rc.y }
                else {
                    const t = (now - Math.max(rc.at, rc.holdUntil)) / 200;
                    if (t >= 1) recoils.delete(id);
                    else { const amt = (1 - t) * (1 - t); ex += rc.dx * amt; ey += rc.dy * amt; tilt = Math.sign(rc.dx || 1) * .22 * amt }
                }
            }
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
            else if (wind && art.key === 'voidEmperor' && snaps[snaps.length - 1]?.hud?.boss?.mode === 'target' && has('bossTargetWind')) { key = 'bossTargetWind'; mode = 'hold'; t0 = m.windAt }
            else if (wind && has(art.wind)) { key = art.wind; mode = 'hold'; t0 = m.windAt }
            else if (walking && has(art.walk)) { key = art.walk; flip = false }
            else if (struck) ox = dir * 7; // procedural lunge fallback
            if (walking && key === art.key) oy = -Math.abs(Math.sin(now / 90 + id)) * 3; // bob fallback
            if (flash) ox += Math.sin(now / 34) * 3; // hurt shake
            g.save();
            g.translate(Math.round(ex * S), Math.round(ey * S));
            g.scale(k, k);
            if (tilt) { g.translate(0, -4); g.rotate(tilt); g.translate(0, 4) }
            if (fade !== undefined) g.globalAlpha = Math.max(0, fade);
            // World-scale telegraph (sheets only hint at it): warden plant ring at the slam radius.
            if (wind && (art.key === 'warden' || (art.key === 'voidEmperor' && ((snaps[snaps.length - 1]?.hud?.boss?.mode !== 'target')))) && A) {
                const radius = art.key === 'voidEmperor' ? 90 : SLAM_R;
                A.loop(g, 'warning', now, 0, 0, radius * S * 2 / k, radius * S / k);
            }
            if (!(env && env.shadow(g, art.key === 'warden' ? 2 : art.w > 90 ? 3 : 1, art.w * .8))) { g.fillStyle = '#0006'; g.beginPath(); g.ellipse(0, 1, art.w * .36, 6, 0, 0, Math.PI * 2); g.fill() }
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
            const top = art.key === 'voidEmperor' ? -156 : art.key === 'warden' ? -88 : -68;
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
            const dt = lastFrame ? Math.min(50, now - lastFrame) : 16.7;
            lastFrame = now;
            const view = sample(now);
            if (!view) return;
            processPending(now);
            adaptDensity(now, dt);
            const o = oracle();
            const ts = o ? o.update(dt) : 1; // cosmetic hit-stop: scales particle time only (never the sim or prediction)
            pool.update(dt * ts);
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
            if (!(env && env.draw(g, now, dt, view.zone || 0, pool.density))) R.drawArena(g, now, view.zone || 0);
            drawAttackLight(view, now);
            // Layering (combat-vfx.md): floor rings -> units -> slashes/projectiles -> sparks -> numbers -> HUD/combo.
            drawFloorFx(now);
            drawDestinyAura(view, now);
            drawPickups(view, now, k);
            const units = view.heroes.map((h, i) => ({ y: h.y, h, i }));
            for (const e of view.enemies || []) units.push({ y: e[3], e });
            for (const gh of ghosts) { // die frames + knockback slide, then fade
                const el = now - gh.start, u = Math.min(1, el / 240), ease = 1 - (1 - u) * (1 - u);
                const e2 = gh.kx ? (gh.e2 || (gh.e2 = gh.e.slice())) : gh.e;
                if (gh.kx) { e2[2] = gh.e[2] + gh.kx * ease; e2[3] = gh.e[3] + gh.ky * ease }
                units.push({ y: e2[3], e: e2, dieAt: gh.start, fade: el < gh.life - 160 ? 1 : (gh.life - el) / 160 });
            }
            units.sort((a, b) => a.y - b.y).forEach(u => u.e ? drawEnemy(u.e, now, k, u.fade, u.dieAt) : drawHero(u.h, u.i, now, room, myId, k));
            if (enemyMotion.size > 64) { const live = new Set((view.enemies || []).map(e => e[0])); for (const id of enemyMotion.keys()) if (!live.has(id)) enemyMotion.delete(id) }
            drawBuffs(view, now, k);
            drawActionFx(view, now, k, dt);
            drawParticles(now);
            if (o) { o.draw(g); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over' }
            drawNumbers(now);
            drawChains(view, now, k);
            g.setTransform(1, 0, 0, 1, 0, 0);
            drawHud(view, room, myId, k, now);
            drawBossBar(view, k);
            drawBanners(now, k);
            drawGameOver(now, view.hud);
            stats.frames++;
            lastWork = performance.now() - now; // CPU time this frame took (drives adaptive density)
        }

        function start() { if (!running) { running = true; requestAnimationFrame(frame) } }
        function stop() { running = false }

        return { push, reset, start, stop, sample, stats, interpolating: interpEnabled, fxCounts: () => ({ fx: fx.length, parts: pool.count, oparts: ofx ? ofx.particles.count : 0, sheets: SH ? SH.progress().loaded : 0, density: pool.density, texts: texts.length, banners: banners.length, art: A ? A.loadedCount() : 0, shakes: shake.count, reducedMotion: reducedMotion() }), pickupsShown: () => { const v = sample(performance.now()); return v ? (v.pk || []).length : 0 }, chainOf: i => chains[i] ? chains[i].n : 0, lastAttackFx: name => { const f = [...fx].reverse().find(v => v.kind === 'attack' && (!name || v.name === name)); return f ? { name: f.name, aim: f.aim, stage: f.stage } : null } };
    }

    root.WCHArena = { createArena, TICK_MS, INTERP_DELAY_MS };
})(window);
