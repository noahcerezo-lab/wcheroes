/*
 * West Coast Heroes — hero pose layer, weapon animation and attack VFX (multiplayer client only).
 *
 * Cosmetic only: driven by what the server already sends (attackN / cs combo stage / aim / hit events).
 * Nothing here decides damage; it only decides how a swing *looks*.
 *
 * Pose layer: each hero is drawn from weapon-less HD art (WCHRender.makePoseArt) cut into three slices
 * (torso+head, back leg, front leg). The torso leans and twists around the waist, the legs step and plant,
 * and the weapon arm + weapon are drawn procedurally, so the arm and weapon move on their own and the body
 * never shakes as a whole.
 *
 * Noah (milestone 1): 5-phase sword attack (anticipation -> swing -> arcane release -> impact -> recovery).
 * The crescent is generated along the blade tip's real path (same angles, same pivot) and then released
 * outward, so it always starts at the sword. 3 distinct combo stages from the server's `cs`:
 *   0 Crescent Slash (fast sweep), 1 Reverse Arc (counter-direction, stronger twist), 2 Arcane Breaker (heavy).
 *
 * Milestone 2 — the same pose layer for the rest of the squad, each with its own weight and rhythm:
 *   Markie: heavy two-handed axe — long coiled wind-up + crouch, short brutal swing, axe lingers low after the
 *           hit (follow-through), finisher = overhead slam; orange ember crescent that stays close to the head.
 *   Destiny: captain's longsword — precise: 0 fast thrust, 1 clean sweep, 2 rising cross-cut with a gold guard flare.
 *   Espirit: real archery — raise the bow, draw the string to the anchor, arrow nocked, short hold, release (string
 *           snaps forward and vibrates, bow recoils), recover. Back-to-back shots skip the raise. The arrow itself
 *           is drawn by the arena (it travels in world space, from the bow, launched at the release moment).
 *
 * Draper's sheets (m-overhaul groups 1-5, hero-sheets.js) replace the procedural bodies once they load:
 *   Noah: 8-way attack sheets per combo hit (0-1 anticipation, 2-3 swing, 4-5 follow-through, 6-7 recovery) +
 *         the tapered crescent FX sheet for hits 1-2 (mirrored across the aim line for the Reverse Arc), and
 *         shards + shockwave on the Arcane Breaker's impact frame. The procedural crescent is kept only as a
 *         faint additive glow on top.
 *   Espirit: 8-way bow sheets (0-2 raise, 3-4 draw, 5-6 nock/hold, 7-8 release, 9-11 recoil); chained shots
 *         start at the draw. The arena spawns the glowing arrow on frame 7.
 *   Markie / Destiny: E-only attack sheets (mirrored for W). For up/down/diagonal aims the procedural crescent
 *         is drawn as a rotated effect layer so the hit still reads in the aim direction.
 *   Everyone: idle / run / hurt sheets when not attacking.
 *   The procedural pose layer remains as the fallback while sheets load (and for the deterministic lab).
 *
 * Coordinates: drawHero/drawFx run with the canvas already translated to the hero's feet and scaled by k
 * (the arena's small-screen sprite scale), i.e. "local" units = sprite pixels at k = 1. Swing planes are
 * squashed by SQ vertically for the floor perspective. World angles: 0 = right, PI/2 = down (screen).
 */
(function (root) {
    'use strict';
    const SQ = 0.8;
    const PI = Math.PI;
    const W = 50.4, H = 67.2, PX = 0.525; // sprite size (local) and HD-pixel -> local scale (V19 sprite at 1.05)
    const WAIST = -H + 92 * PX; // -18.9: torso pivot
    const SHOULDER = { x: 7.5, y: -38.5 }; // weapon-arm shoulder (facing right)
    const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
    const easeOut3 = t => 1 - (1 - t) * (1 - t) * (1 - t);
    const easeInOut3 = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const easeIn2 = t => t * t;
    const lerp = (a, b, t) => a + (b - a) * t;
    const toWorld = (a, f) => f < 0 ? PI - a : a; // facing-frame angle -> world angle

    // Noah palette (combat-vfx.md): deep -> bright.
    const NOAH_PAL = { glow: '#1762C8', body: '#53BAFF', core: '#E8FFFF', deep: '#7A5FE0', spark: ['#D8FFFF', '#79E4FF', '#83B8FF', '#FFFFFF'] };
    // Per-stage timing (ms) and shape. arc: [start offset, end offset] around the aim angle (m = mirror sign).
    const NOAH_T = [
        { a: 60, s: 105, r: 150, rel: 210, from: -1.75, to: 1.3, thick: 19, contact: .5, stop: 45, shards: .045, name: 'CRESCENT SLASH' },
        { a: 75, s: 115, r: 175, rel: 230, from: 1.6, to: -1.45, thick: 23, contact: .5, stop: 50, shards: .055, name: 'REVERSE ARC' },
        { a: 125, s: 125, r: 270, rel: 340, from: -2.55, to: 1.55, thick: 34, contact: .55, stop: 85, shards: .11, name: 'ARCANE BREAKER' },
    ];
    const NOAH_REACH = 13, NOAH_BLADE = 37, NOAH_TIP = NOAH_REACH + NOAH_BLADE;

    // scratch buffers (no per-frame allocation)
    const PTS = new Float32Array(160);
    const pose = { lean: 0, twist: 0, crouch: 0, fdx: 0, bdx: 0, flift: 0, blift: 0, bob: 0, armA: 0, bladeA: 0, reach: 0, glow: 0 };

    function create(opts) {
        const R = opts.R, pool = opts.pool, S = opts.S || 1.5;
        const theme = opts.theme || null;
        const st = []; // per hero index: animation state
        const sil = new Map(); // silhouette cache: art canvas + color -> canvas

        function heroState(i) {
            return st[i] || (st[i] = { atk: null, hurtAt: -1e9, cloth: 0, clothV: 0, lastX: null, shardAcc: 0, lvAt: -1e9 });
        }
        function silhouette(art, color) {
            let m = sil.get(art); if (!m) { m = {}; sil.set(art, m) }
            if (m[color]) return m[color];
            const c = document.createElement('canvas'); c.width = art.width; c.height = art.height;
            const g = c.getContext('2d'); g.drawImage(art, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
            return (m[color] = c);
        }

        // ---------- attack lifecycle ----------
        function onAttack(i, h, stage, aim, now) {
            const s = heroState(i);
            const theta = Math.atan2(aim.y, aim.x);
            const facing = h.facing === -1 ? -1 : 1;
            const m = aim.x < -0.01 || (Math.abs(aim.x) <= 0.01 && facing < 0) ? -1 : 1;
            const prev = s.atk;
            // Espirit: a shot right after the previous one skips the raise (bow is already up), so rapid fire stays readable.
            const skipRaise = h.name === 'ESPIRIT' && prev && prev.name === 'ESPIRIT' && now - prev.start < bowEnd(prev) + 120;
            const st0 = Math.max(0, Math.min(2, stage | 0)), dir = SHEETS ? SHEETS.dirOf(h.aim, facing) : 'E';
            // Espirit uses the direction-correct procedural draw so the bow faces the target.
            const sheet = h.name !== 'ESPIRIT' && h.name !== 'SMITESH' && h.name !== 'DAVE' && h.name !== 'DONNA' && !!(SHEETS && !opts.procedural && SHEETS.ready(sheetKeyFor(h.name, st0, dir)));
            s.atk = { name: h.name, stage: st0, start: now, theta, m, facing, holdAt: 0, holdMs: 0, shockDone: false, contactDone: false, skipRaise, sfxRel: false, sheet, dir };
            s.shardAcc = 0;
            return s.atk;
        }
        function timing(a) { if (a.sheet && SH_T[a.name]) return sheetT(a.name, a.stage); const d = DEFS[a.name]; return d ? d[a.stage] : null }
        // Espirit's bow timeline (ms from the shot): release and end.
        function bowRel(a) { return a.sheet ? (7 - (a.skipRaise ? 3 : 0)) * SH_BOW.draw : (a.skipRaise ? 0 : BOW.raise) + BOW.draw + BOW.hold }
        function bowEnd(a) { return a.sheet ? bowRel(a) + 5 * SH_BOW.recoil : bowRel(a) + BOW.recoil + BOW.recover }
        function bowFrame(a, el) {
            const rel = bowRel(a);
            if (el < rel) return Math.min(6, (a.skipRaise ? 3 : 0) + Math.floor(el / SH_BOW.draw));
            return Math.min(11, 7 + Math.floor((el - rel) / SH_BOW.recoil));
        }
        // Body length of an attack (the sheet/pose plays this long) vs. its effects (may outlast the body).
        function bodyEnd(a) { if (a.name === 'ESPIRIT') return bowEnd(a); const T = timing(a); return T ? T.a + T.s + T.r : 300 }
        const CRES_FD = 34, SHOCK_FD = 70, SHARD_FD = 50, SPARK_FD = 45, CRACK_FD = 70;
        function fxEnd(a) {
            if (!a.sheet) return 0;
            const T = timing(a); if (!T) return 0;
            if (a.name === 'NOAH') return a.stage === 2 ? T.a + 8 * SHOCK_FD : T.fd + 8 * CRES_FD;
            if (a.name === 'MARKIE') return T.a + 8 * CRACK_FD;
            return bodyEnd(a);
        }
        // Absolute time at which this swing's weapon connects (impacts are shown then, not when the packet lands).
        // Espirit: release + arrow flight over `dist` screen px (the arena passes the bow -> target distance).
        function contactAt(i, dist) {
            const s = st[i], a = s && s.atk; if (!a) return 0;
            if (a.name === 'ESPIRIT') return a.start + bowRel(a) + (dist || 0) / BOW.speed;
            const T = timing(a); if (!T) return a.start;
            return a.start + T.a + T.s * T.contact;
        }
        // When Espirit's arrow leaves the string (absolute ms), or 0.
        function releaseAt(i) { const s = st[i], a = s && s.atk; return a && a.name === 'ESPIRIT' ? a.start + bowRel(a) : 0 }
        function hitStop(i, ms) {
            const s = st[i], a = s && s.atk; if (!a || a.holdMs || a.name === 'ESPIRIT') return;
            const T = timing(a); if (!T) return;
            a.holdAt = T.a + T.s * T.contact; a.holdMs = ms || T.stop;
        }
        function elapsed(a, now) {
            let e = now - a.start;
            if (a.holdMs && e > a.holdAt) e = Math.max(a.holdAt, e - a.holdMs);
            return e;
        }
        function attackLife(a) { if (a.name === 'ESPIRIT') return bowEnd(a); const T = timing(a); return T ? Math.max(T.a + T.s + Math.max(T.r, T.rel), fxEnd(a)) : 300 }
        function onHurt(i, now) { heroState(i).hurtAt = now }
        function onLevelUp(i, now) { heroState(i).lvAt = now }

        // ---------- Noah pose ----------
        const ANG = { from: 0, to: 0 };
        function noahAngles(a) { // world angles of the swing, unwrapped next to the rest angle so lerps take the short way
            const T = NOAH_T[a.stage];
            let from = a.theta + a.m * T.from;
            const rest = toWorld(-1.0, a.facing);
            from += Math.round((rest - from) / (2 * PI)) * 2 * PI;
            ANG.from = from; ANG.to = from + a.m * (T.to - T.from);
            return ANG;
        }
        function restPose(h, now, s, out) {
            const f = h.facing === -1 ? -1 : 1, R0 = REST[h.name] || REST.NOAH;
            out.draw = 0; out.nocked = false; out.recoil = 0;
            out.lean = 0; out.twist = 0; out.crouch = 0; out.fdx = 0; out.bdx = 0; out.flift = 0; out.blift = 0; out.glow = 0;
            if (h.moving) { // run cycle: legs alternate and lift, torso bobs and leans into the run
                const ph = now / 85;
                out.fdx = Math.sin(ph) * 3.2; out.bdx = -out.fdx;
                out.flift = Math.max(0, Math.cos(ph)) * -1.8; out.blift = Math.max(0, -Math.cos(ph)) * -1.8;
                out.bob = -Math.abs(Math.sin(ph)) * 1.4; out.lean = .07;
                if (h.name === 'ESPIRIT') { out.armA = toWorld(.9, f); out.bladeA = out.armA; out.reach = 10 } // bow carried low
                else { out.armA = toWorld(1.9, f); out.bladeA = toWorld(h.name === 'MARKIE' ? -2.6 : -2.35, f); out.reach = 10 } // weapon trails back
            } else { // combat stance: feet apart, small breathing on the torso only
                out.fdx = 1.5; out.bdx = -1;
                out.bob = Math.sin(now / 450) * .6;
                out.armA = toWorld(R0[0], f); out.bladeA = toWorld(R0[1] + Math.sin(now / 700) * .04, f); out.reach = R0[2];
                if (h.name === 'ESPIRIT') out.bladeA = out.armA;
                // Noah rests his sword low at his side instead of holding both arms overhead.
                if (h.name === 'NOAH') { out.armA = toWorld(.95, f); out.bladeA = toWorld(1.25, f); out.reach = 12; }
                if (h.name === 'MARKIE') out.crouch = 1; // heavy stance
            }
            const hurt = now - s.hurtAt;
            if (hurt < 260) { const u = 1 - hurt / 260; out.lean -= .2 * u * u; out.bdx -= 2 * u }
            // The canonical Noah silhouette is used in movement too, so the
            // baked-in raised arms never reappear when he starts running.
            out.relaxedIdle = h.name === 'NOAH';
            if (h.name === 'NOAH' && !h.moving) {
                out.fdx = 2.5; out.bdx = -2.5;
                out.crouch = .5;
                out.bladeA = toWorld(1.32, f);
                out.armA = toWorld(1.05, f);
            }
            out.axeSide = f;
            return out;
        }
        function noahPose(h, a, el, out) {
            const T = NOAH_T[a.stage], A = noahAngles(a), f = a.facing;
            const restA = toWorld(-1.0, f), heavy = a.stage === 2, rev = a.stage === 1;
            out.flift = out.blift = 0; out.bob = 0; out.glow = 0; out.draw = 0; out.nocked = false; out.recoil = 0;
            if (el < T.a) { // 1. anticipation: plant the lead foot, draw the sword back, lean back
                const p = easeOut3(el / T.a);
                out.bladeA = lerp(restA, A.from, p); out.armA = lerp(toWorld(1.25, f), A.from + a.m * .35, p); out.reach = lerp(11, 8, p);
                out.lean = -(heavy ? .16 : .09) * p; out.twist = -(rev ? .7 : heavy ? .55 : .35) * p;
                out.crouch = (heavy ? 3 : 1.5) * p; out.fdx = 1.5 + (heavy ? 3.5 : 2.5) * p; out.bdx = -1 - 1.5 * p; out.glow = p * .5;
            } else if (el < T.a + T.s) { // 2. swing: torso rotates through, arm extends, blade travels the arc
                const q = (el - T.a) / T.s, e = easeInOut3(q);
                out.bladeA = lerp(A.from, A.to, e); out.armA = out.bladeA; out.reach = lerp(8, NOAH_REACH, easeOut3(Math.min(1, q * 1.6)));
                out.lean = lerp(-(heavy ? .16 : .09), heavy ? .2 : .12, e);
                out.twist = lerp(-(rev ? .7 : heavy ? .55 : .35), rev ? 1 : heavy ? .8 : .55, e);
                out.crouch = (heavy ? 3 : 1.5) + (heavy ? 1.5 : .5) * e; out.fdx = 1.5 + (heavy ? 4.5 : 3); out.bdx = -2.5 - (heavy ? 1 : .5) * e; out.glow = 1;
            } else { // 5. recovery: follow-through past the end, then settle back into stance
                const q = clamp01((el - T.a - T.s) / T.r);
                const over = Math.sin(Math.min(1, q * 2.4) * PI / 2) * (heavy ? .38 : .24) * (1 - easeIn2(q));
                const back = easeInOut3(clamp01((q - .25) / .75));
                const endA = A.to + (A.to > A.from ? over : -over);
                out.bladeA = lerp(endA, restA, back); out.armA = lerp(endA, toWorld(1.25, f), back); out.reach = lerp(NOAH_REACH, 11, back);
                out.lean = lerp(heavy ? .2 : .12, 0, back); out.twist = lerp(rev ? 1 : heavy ? .8 : .55, 0, back);
                out.crouch = lerp(heavy ? 4.5 : 2, 0, back); out.fdx = lerp(1.5 + (heavy ? 4.5 : 3), 1.5, back); out.bdx = lerp(-3, -1, back); out.glow = 1 - back;
            }
            return out;
        }


        // ---------- Markie: heavy two-handed axe ----------
        // Long wind-up (axe hauled back, torso coiled, low crouch), a short brutal swing, a ground impact at the end of
        // the arc, and a slow follow-through where the axe head drags low. Finisher = overhead slam into the floor.
        const MARKIE_T = [
            { a: 150, s: 105, r: 230, rel: 170, from: -2.3, to: 1.05, thick: 20, contact: .78, stop: 60 },
            { a: 150, s: 105, r: 230, rel: 170, from: 2.0, to: -1.1, thick: 20, contact: .75, stop: 60 },
            { a: 215, s: 100, r: 320, rel: 220, from: -2.95, to: 0.95, thick: 28, contact: .88, stop: 95 },
        ];
        // ---------- Destiny: captain's longsword, precise ----------
        // 0 thrust (straight, fast), 1 elegant horizontal sweep, 2 rising cross-cut with a golden guard flare.
        const DESTINY_T = [
            { a: 70, s: 80, r: 170, rel: 160, from: 0, to: 0, thick: 0, contact: .65, stop: 40, thrust: true },
            { a: 80, s: 100, r: 180, rel: 180, from: 1.25, to: -1.15, thick: 11, contact: .5, stop: 45 },
            { a: 120, s: 115, r: 260, rel: 260, from: 2.0, to: -1.5, thick: 16, contact: .5, stop: 70 },
        ];
        // ---------- Espirit: archery (raise, draw, nock + hold, release, string recoil, recover) ----------
        // Espirit fires every ~180 ms while held, so the full read (raise/draw/hold) is ~105 ms; chained shots ~75 ms.
        const BOW = { raise: 30, draw: 60, hold: 15, recoil: 110, recover: 140, speed: 2.1 /* screen px per ms */ };
        const DEFS = { NOAH: NOAH_T, MARKIE: MARKIE_T, DESTINY: DESTINY_T, DAVE: MARKIE_T, DONNA: MARKIE_T };
        // Sheet timelines: ms per frame per combo stage, the contact frame (impact is shown at its start; the
        // Arcane Breaker connects on frame 3 so it can lead the server's hit by about a frame) and hit-stop.
        const SH_T = {
            NOAH: { fd: [36, 38, 46], n: 8, contact: [3, 3, 3], stop: [45, 50, 85] },
            MARKIE: { fd: [50, 50, 58], n: 10, contact: [6, 6, 6], stop: [60, 60, 95] },
            DESTINY: { fd: [42, 46, 54], n: 8, contact: [3, 3, 3], stop: [40, 45, 70] },
        };
        const SH_BOW = { draw: 25, recoil: 35 }; // Espirit: frames 0-6 at 25 ms (release = frame 7), 7-11 at 35 ms
        const SHT = {}; // cached T-like objects for sheet mode
        function sheetT(name, stage) {
            const key = name + stage; if (SHT[key]) return SHT[key];
            const d = SH_T[name], fd = d.fd[stage], c = d.contact[stage] * fd;
            return (SHT[key] = { a: c, s: 0, contact: 0, r: d.n * fd - c, rel: 0, stop: d.stop[stage], fd, n: d.n });
        }
        const SHEETS = root.WCHSheets || null;
        if (SHEETS) SHEETS.load();
        const sheetKeyFor = (name, stage, dir) => name === 'NOAH' ? 'noah' + stage + dir : name === 'ESPIRIT' ? 'bow' + dir : name === 'MARKIE' ? 'markieSmash' : 'destinySweep';
        const MARKIE_PAL = { glow: '#C98A4B', body: '#FF9657', core: '#FFF0A4' };
        const DESTINY_PAL = { glow: '#E6AD57', body: '#F5C65D', core: '#FFF7DA' };
        const MARKIE_REACH = 10, MARKIE_HAFT = 30, MARKIE_TIP = MARKIE_REACH + MARKIE_HAFT;
        const DESTINY_REACH = 12, DESTINY_BLADE = 40, DESTINY_TIP = DESTINY_REACH + DESTINY_BLADE;
        const REST = { // facing-frame rest angles: [arm, weapon, reach]
            NOAH: [1.0, 1.15, 12], MARKIE: [1.1, -1.35, 9], DESTINY: [1.3, -1.45, 11], ESPIRIT: [1.15, -1.2, 10], SMITESH: [.85, -1.3, 10], DONNA: [.85, -1.3, 10], DAVE: [.9, -1.6, 13],
        };
        function swingAngles(a, T) {
            let from = a.theta + a.m * T.from;
            const rest = toWorld(REST[a.name][1], a.facing);
            from += Math.round((rest - from) / (2 * PI)) * 2 * PI;
            ANG.from = from; ANG.to = from + a.m * (T.to - T.from);
            return ANG;
        }
        // Generic melee pose with per-hero weight. w = {lean, twist, crouch, step, reachA, reachS}
        const WEIGHT = {
            // Dave's fourfold attacks share a tested melee timing structure but use
            // lighter body movement; the four separate weapon arms animate in drawDaveArms.
            DONNA: [
                { lean:.04, twist:.12, crouch:1, step:1.4, reachA:5, reachS:10 },
                { lean:.05, twist:.18, crouch:1, step:1.8, reachA:5, reachS:10 },
                { lean:.06, twist:.24, crouch:1.5, step:2, reachA:6, reachS:11 }
            ],
            DAVE: [
                { lean:.08, twist:.35, crouch:1.5, step:2.2, reachA:7, reachS:13 },
                { lean:.1, twist:.48, crouch:2, step:2.8, reachA:7, reachS:13 },
                { lean:.12, twist:.6, crouch:2.5, step:3.2, reachA:8, reachS:14 }
            ],
            MARKIE: [{ lean: .2, twist: .85, crouch: 4, step: 3, reachA: 6, reachS: MARKIE_REACH }, { lean: .2, twist: .95, crouch: 4, step: 3, reachA: 6, reachS: MARKIE_REACH }, { lean: .26, twist: .6, crouch: 6, step: 4, reachA: 5, reachS: MARKIE_REACH }],
            DESTINY: [{ lean: .08, twist: .3, crouch: 1.5, step: 4, reachA: 6, reachS: DESTINY_REACH + 6 }, { lean: .08, twist: .5, crouch: 1.5, step: 2.5, reachA: 8, reachS: DESTINY_REACH }, { lean: .12, twist: .7, crouch: 2.5, step: 3, reachA: 7, reachS: DESTINY_REACH }],
        };
        function meleePose(h, a, el, out) {
            const T = DEFS[a.name][a.stage], A = swingAngles(a, T), f = a.facing, Wt = WEIGHT[a.name][a.stage];
            const rest = REST[a.name], restA = toWorld(rest[1], f), restArm = toWorld(rest[0], f);
            out.flift = out.blift = 0; out.bob = 0; out.glow = 0; out.draw = 0; out.nocked = false; out.recoil = 0;
            if (T.thrust) { // Destiny's thrust: weapon stays on the aim line, the arm pulls back then drives forward
                const aimA = a.theta;
                if (el < T.a) { const p = easeOut3(el / T.a); out.bladeA = lerp(restA, aimA, p); out.armA = lerp(restArm, aimA + a.m * .5, p); out.reach = lerp(rest[2], 5, p); out.lean = -.06 * p; out.twist = -.4 * p; out.crouch = 1.2 * p; out.fdx = 1.5 + 2 * p; out.bdx = -1 - p }
                else if (el < T.a + T.s) { const e = easeOut3((el - T.a) / T.s); out.bladeA = aimA; out.armA = lerp(aimA + a.m * .5, aimA, e); out.reach = lerp(5, Wt.reachS, e); out.lean = lerp(-.06, Wt.lean, e); out.twist = lerp(-.4, .5, e); out.crouch = 1.5; out.fdx = 3.5 + Wt.step * e; out.bdx = -2; out.glow = 1 }
                else { const q = clamp01((el - T.a - T.s) / T.r), back = easeInOut3(clamp01((q - .2) / .8)); out.bladeA = lerp(aimA, restA, back); out.armA = lerp(aimA, restArm, back); out.reach = lerp(Wt.reachS, rest[2], back); out.lean = lerp(Wt.lean, 0, back); out.twist = lerp(.5, 0, back); out.crouch = lerp(1.5, 0, back); out.fdx = lerp(3.5 + Wt.step, 1.5, back); out.bdx = lerp(-2, -1, back); out.glow = 1 - back }
                return out;
            }
            if (el < T.a) { // anticipation (Markie: big coil + crouch)
                const p = a.name === 'MARKIE' ? easeInOut3(el / T.a) : easeOut3(el / T.a);
                out.bladeA = lerp(restA, A.from, p); out.armA = lerp(restArm, A.from + a.m * .3, p); out.reach = lerp(rest[2], Wt.reachA, p);
                out.lean = -Wt.lean * .7 * p; out.twist = -Wt.twist * p; out.crouch = Wt.crouch * .6 * p; out.fdx = 1.5 + Wt.step * .6 * p; out.bdx = -1 - Wt.step * .4 * p; out.glow = p * .4;
                if (heavyStomp(a)) out.flift = -2.5 * Math.sin(p * PI); // weight shift: lead foot lifts during the coil
            } else if (el < T.a + T.s) {
                const q = (el - T.a) / T.s, e = a.name === 'MARKIE' ? easeIn2(q) * .35 + easeInOut3(q) * .65 : easeInOut3(q);
                out.bladeA = lerp(A.from, A.to, e); out.armA = out.bladeA; out.reach = lerp(Wt.reachA, Wt.reachS, easeOut3(Math.min(1, q * 1.5)));
                out.lean = lerp(-Wt.lean * .7, Wt.lean, e); out.twist = lerp(-Wt.twist, Wt.twist, e); out.crouch = Wt.crouch * (.6 + .4 * e);
                out.fdx = 1.5 + Wt.step; out.bdx = -1 - Wt.step * .5; out.glow = 1;
                if (heavyStomp(a) && q > .8) out.flift = 0; // Markie's lead foot slams down with the axe
            } else { // follow-through: Markie's axe lingers low before he hauls it back up
                const q = clamp01((el - T.a - T.s) / T.r), heavy = a.name === 'MARKIE';
                const hold = heavy ? .35 : .15;
                const over = Math.sin(Math.min(1, q * 2.2) * PI / 2) * (heavy ? .18 : .28) * (1 - easeIn2(q));
                const back = easeInOut3(clamp01((q - hold) / (1 - hold)));
                const endA = A.to + (A.to > A.from ? over : -over);
                out.bladeA = lerp(endA, restA, back); out.armA = lerp(endA, restArm, back); out.reach = lerp(Wt.reachS, rest[2], back);
                out.lean = lerp(Wt.lean, 0, back); out.twist = lerp(Wt.twist, 0, back); out.crouch = lerp(Wt.crouch, 0, back);
                out.fdx = lerp(1.5 + Wt.step, 1.5, back); out.bdx = lerp(-1 - Wt.step * .5, -1, back); out.glow = 1 - back;
            }
            out.axeSide = A.to > A.from ? 1 : -1;
            return out;
        }
        const heavyStomp = a => a.name === 'MARKIE';
        // Espirit: bow arm extends to the target, string hand draws back to the anchor, arrow nocked, release, recoil.
        function bowPose(h, a, el, out) {
            const f = a.facing, aimA = a.theta, rest = REST.ESPIRIT;
            const raise = a.skipRaise ? 0 : BOW.raise;
            if (a.skipRaise && el < BOW.draw) { out.armA = aimA; out.bladeA = aimA; out.reach = 14; out.draw = easeInOut3(el / BOW.draw); out.nocked = true; out.twist = -.5 - .2 * out.draw; out.lean = -.05; out.crouch = .8; out.fdx = 3; out.bdx = -2; out.flift = out.blift = 0; out.bob = 0; out.glow = 0; out.recoil = 0; return out }
            out.flift = out.blift = 0; out.bob = 0; out.glow = 0;
            out.draw = 0; out.nocked = false; out.recoil = 0;
            const tDraw = raise, tHold = raise + BOW.draw, tRel = tHold + BOW.hold, tRec = tRel + BOW.recoil, tEnd = tRec + BOW.recover;
            if (el < tDraw) { const p = easeOut3(el / Math.max(1, raise)); out.armA = lerp(toWorld(rest[0], f), aimA, p); out.bladeA = out.armA; out.reach = lerp(rest[2], 14, p); out.nocked = p > .5; out.twist = -.5 * p; out.lean = -.03 * p }
            else if (el < tHold) { const p = easeInOut3((el - tDraw) / BOW.draw); out.armA = aimA; out.bladeA = aimA; out.reach = 14; out.draw = p; out.nocked = true; out.twist = -.5 - .2 * p; out.lean = -.03 - .04 * p }
            else if (el < tRel) { out.armA = aimA; out.bladeA = aimA; out.reach = 14; out.draw = 1; out.nocked = true; out.twist = -.7; out.lean = -.07 }
            else if (el < tRec) { const q = (el - tRel) / BOW.recoil; out.armA = aimA + a.m * .06 * Math.sin(q * PI) * (1 - q); out.bladeA = out.armA; out.reach = 14 - 2.5 * Math.sin(Math.min(1, q * 3) * PI) * (1 - q); out.draw = 0; out.recoil = 1 - q; out.twist = lerp(-.7, -.4, q); out.lean = lerp(-.07, .02, q) }
            else { const q = clamp01((el - tRec) / BOW.recover), back = easeInOut3(q); out.armA = lerp(aimA, toWorld(rest[0], f), back * .6); out.bladeA = out.armA; out.reach = lerp(14, 11, back); out.twist = lerp(-.4, 0, back); out.lean = lerp(.02, 0, back) }
            out.crouch = .8; out.fdx = 3; out.bdx = -2;
            out.relAt = tRel; out.endAt = tEnd;
            return out;
        }

        // ---------- body ----------
        function drawBody(g, h, i, now, look, P) {
            const f = h.facing === -1 ? -1 : 1;
            const art = R.makePoseArt(h.name, 0, theme);
            const legSrcY = 92, legH = 36;
            g.save();
            g.scale(f, 1);
            const outline = look.outline;
            for (let pass = outline ? 0 : 1; pass < 2; pass++) {
                const img = pass === 0 ? silhouette(art, outline) : art;
                const offs = pass === 0 ? OUTLINE_OFFS : ZERO_OFF;
                for (let o = 0; o < offs.length; o += 2) {
                    const ox = offs[o], oy = offs[o + 1];
                    // back leg (left half of the leg strip), front leg (right half): step / plant independently
                    g.drawImage(img, 0, legSrcY, 48, legH, -W / 2 + P.bdx + ox, -H + legSrcY * PX + P.blift + oy, 48 * PX, legH * PX);
                    g.drawImage(img, 48, legSrcY, 48, legH, P.fdx + ox, -H + legSrcY * PX + P.flift + oy, 48 * PX, legH * PX);
                    // torso + head: lean and twist around the waist (no whole-body shake)
                    g.save();
                    g.translate(ox + P.twist * 1.2, WAIST + P.crouch + P.bob + oy);
                    g.rotate(P.lean);
                    g.scale(1 - Math.abs(P.twist) * .1, 1);
                    if (h.name === 'DESTINY') {
                        // Canonical Destiny silhouette for EVERY animation state.
                        // Keep her existing face, hair, gold-and-crimson palette and boots,
                        // but remove the wide, rectangular baked-in torso/shoulder art.
                        const headH = 47, bodyTop = 47;
                        g.drawImage(img, 0, 0, 96, headH,
                            -W / 2, -legSrcY * PX, W, headH * PX);
                        // Slim fitted cuirass with a defined waist and flared armored skirt.
                        const skin = pass === 0 ? outline : '#e8b08a';
                        const edge = pass === 0 ? outline : '#4d1c35';
                        const gold = pass === 0 ? outline : '#e8c66b';
                        const red = pass === 0 ? outline : '#a92d4a';
                        const cream = pass === 0 ? outline : '#fff0cb';
                        const top = -(legSrcY - bodyTop) * PX;
                        g.fillStyle = edge;
                        g.beginPath();
                        g.moveTo(-12, top); g.lineTo(12, top);
                        g.lineTo(9, top + 17); g.lineTo(11, top + 26);
                        g.lineTo(17, 0); g.lineTo(-17, 0);
                        g.lineTo(-11, top + 26); g.lineTo(-9, top + 17);
                        g.closePath(); g.fill();
                        g.fillStyle = red;
                        g.beginPath();
                        g.moveTo(-9, top + 3); g.lineTo(9, top + 3);
                        g.lineTo(6, top + 17); g.lineTo(9, top + 26);
                        g.lineTo(12, -2); g.lineTo(-12, -2);
                        g.lineTo(-9, top + 26); g.lineTo(-6, top + 17);
                        g.closePath(); g.fill();
                        g.fillStyle = gold;
                        g.fillRect(-8, top + 4, 16, 3);
                        g.fillRect(-7, top + 17, 14, 3);
                        g.fillRect(-3, top + 7, 6, 8);
                        g.fillStyle = cream; g.fillRect(-2, top + 8, 4, 5);
                        // Tapered shoulder plates and arms resting below her face.
                        g.fillStyle = edge;
                        g.fillRect(-15, top + 2, 6, 13);
                        g.fillRect(9, top + 2, 6, 13);
                        g.fillStyle = gold;
                        g.fillRect(-13, top + 3, 4, 5);
                        g.fillRect(9, top + 3, 4, 5);
                        g.fillStyle = skin;
                        g.fillRect(-12, top + 14, 3, 4);
                    } else if (h.name === 'NOAH' && P.relaxedIdle) {
                        // The original pose art has BOTH arms baked into its torso pixels.
                        // Changing the separate weapon arm cannot remove those raised arms.
                        // Keep the head/hair, but crop the upper-body sprite to the central
                        // robe and paint new, lowered sleeves instead.
                        const headH = 45, bodyTop = 45, bodyW = 40, bodyX = 28;
                        g.drawImage(img, 0, 0, 96, headH,
                            -W / 2, -legSrcY * PX, W, headH * PX);
                        g.drawImage(img, bodyX, bodyTop, bodyW, legSrcY - bodyTop,
                            -bodyW * PX / 2, -(legSrcY - bodyTop) * PX,
                            bodyW * PX, (legSrcY - bodyTop) * PX);
                        // Narrow shoulder guards and a relaxed non-weapon arm, below head level.
                        g.fillStyle = pass === 0 ? outline : '#30246c';
                        g.fillRect(-15, -22, 7, 15);
                        g.fillRect(9, -22, 6, 15);
                        g.fillStyle = pass === 0 ? outline : '#6553bc';
                        g.fillRect(-13, -20, 4, 12);
                        g.fillRect(10, -20, 3, 11);
                        g.fillStyle = pass === 0 ? outline : '#d6a17d';
                        g.fillRect(-12, -8, 3, 4);
                    } else {
                        g.drawImage(img, 0, 0, 96, legSrcY, -W / 2, -legSrcY * PX, W, legSrcY * PX);
                    }
                    g.restore();
                }
            }
            g.restore();
        }
        const OUTLINE_OFFS = [-1.2, 0, 1.2, 0, 0, -1.2, 0, 1.2], ZERO_OFF = [0, 0];
        // Shoulder after the torso lean (world/unflipped local coordinates).
        function shoulderOf(f, P, out) {
            const lx = SHOULDER.x + P.twist * 1.2, ly = SHOULDER.y - WAIST; // relative to the waist pivot
            const c = Math.cos(P.lean), s = Math.sin(P.lean);
            out.x = f * (lx * c - ly * s); out.y = WAIST + P.crouch + P.bob + (lx * s + ly * c);
            return out;
        }
        const SH = { x: 0, y: 0 };
        const pt = (cx, cy, a, r, o) => { o.x = cx + Math.cos(a) * r; o.y = cy + Math.sin(a) * r * SQ; return o };
        const P1 = { x: 0, y: 0 }, P2 = { x: 0, y: 0 }, P3 = { x: 0, y: 0 };

        const ARM = { // [ink, upper sleeve, forearm, hand]
            NOAH: ['#1b1530', '#4b3aa8', '#6a52d0', '#e8aa7f'], MARKIE: ['#1a120d', '#5a3a26', '#7a5236', '#c98d68'],
            DESTINY: ['#1c0d12', '#8f1d2c', '#b8283a', '#e8b08a'], ESPIRIT: ['#0f1a13', '#2f6b45', '#3f8a5a', '#e0a882'],
            SMITESH: ['#142d38', '#267c78', '#57afa2', '#d5a27d'],
            DONNA: ['#25462e', '#447c4b', '#9bc76c', '#dfad83'],
            DAVE: ['#211a29', '#4b2c39', '#ae343c', '#c9875f'],
        };
        function drawArm(g, sh, hand, armA, col) {
            const ex = (sh.x + hand.x) / 2 + Math.cos(armA + PI / 2) * 2, ey = (sh.y + hand.y) / 2 + Math.sin(armA + PI / 2) * 2 * SQ;
            g.lineCap = 'round';
            g.strokeStyle = col[0]; g.lineWidth = 6.5; // ink outline
            g.beginPath(); g.moveTo(sh.x, sh.y); g.lineTo(ex, ey); g.lineTo(hand.x, hand.y); g.stroke();
            g.strokeStyle = col[1]; g.lineWidth = 4.5;
            g.beginPath(); g.moveTo(sh.x, sh.y); g.lineTo(ex, ey); g.stroke();
            g.strokeStyle = col[2]; g.beginPath(); g.moveTo(ex, ey); g.lineTo(hand.x, hand.y); g.stroke();
        }
        function drawDaveArms(g, P, look, facing, layer) {
            // Arms attach to fixed torso shoulders, not the single-weapon shoulder.
            // Draw the far pair behind the torso and near pair in front, so the
            // four limbs cannot float over the face or disappear behind the body.
            const attacking = P.glow > 0;
            const sweep = attacking ? Math.sin((1 - P.glow) * Math.PI * 3) * .55 : 0;
            const sway = P.bob * .15;
            const arms = [
                { x:-17, y:-36+sway, a:2.1+sweep, stick:true, far:true },
                { x: 17, y:-36+sway, a:1.0-sweep, stick:true, far:false },
                { x:-18, y:-22+sway, a:2.4-sweep*.75, stick:false, far:true },
                { x: 18, y:-22+sway, a:.75+sweep*.75, stick:false, far:false }
            ];
            g.save();
            g.lineCap = 'round'; g.lineJoin = 'round';
            for (const arm of arms) {
                if ((layer === 'back') !== arm.far) continue;
                const x = arm.x * facing, y = arm.y;
                const angle = facing === -1 ? Math.PI - arm.a : arm.a;
                const ex = x + Math.cos(angle) * 16;
                const ey = y + Math.sin(angle) * 16 * SQ;
                const tx = ex + Math.cos(angle) * (arm.stick ? 26 : 20);
                const ty = ey + Math.sin(angle) * (arm.stick ? 26 : 20) * SQ;
                g.strokeStyle='#1d1827';g.lineWidth=10;
                g.beginPath();g.moveTo(x,y);g.lineTo(ex,ey);g.stroke();
                g.strokeStyle=arm.far?'#86583f':'#c38b62';g.lineWidth=6;g.stroke();
                g.strokeStyle='#211823';g.lineWidth=arm.stick?8:7;
                g.beginPath();g.moveTo(ex,ey);g.lineTo(tx,ty);g.stroke();
                g.strokeStyle=arm.stick?'#d9a660':'#dce7ec';g.lineWidth=arm.stick?5:4;g.stroke();
                g.fillStyle='#d5a37b';g.beginPath();g.arc(ex,ey,4,0,PI*2);g.fill();
            }
            g.restore();
        }
        function drawArmAndSword(g, P, sh, look, name) {
            name = name || 'NOAH';
            const col = ARM[name] || ARM.NOAH;
            const hand = pt(sh.x, sh.y, P.armA, P.reach, P1);
            if (name === 'DAVE') return drawDaveArms(g, P, look, P.facingSign || 1, 'front');
            if (name === 'ESPIRIT') return drawBow(g, P, sh, hand, look, col);
            if (name === 'SMITESH' || name === 'DONNA') {
                drawArm(g, sh, hand, P.armA, col);
                g.strokeStyle = '#203f47'; g.lineWidth = 5;
                g.beginPath(); g.moveTo(hand.x, hand.y + 25); g.lineTo(hand.x + 2, hand.y - 34); g.stroke();
                g.strokeStyle = '#b9a2ed'; g.lineWidth = 2;
                g.beginPath(); g.moveTo(hand.x + 2, hand.y + 24); g.lineTo(hand.x + 2, hand.y - 34); g.stroke();
                g.fillStyle = '#8fffea'; g.beginPath(); g.arc(hand.x + 2, hand.y - 37, 7 + P.glow * 2, 0, PI * 2); g.fill();
                return;
            }
            drawArm(g, sh, hand, P.armA, col);
            if (name === 'MARKIE') drawAxe(g, P, hand, look);
            else if (name === 'DESTINY') drawLongsword(g, P, hand, look);
            else drawNoahBlade(g, P, hand, look);
            g.fillStyle = col[3]; g.fillRect(hand.x - 1.8, hand.y - 1.8, 3.6, 3.6); // hand
        }
        function drawNoahBlade(g, P, hand, look) {
            const tip = pt(hand.x, hand.y, P.bladeA, NOAH_BLADE, P2);
            const nx = -Math.sin(P.bladeA), ny = Math.cos(P.bladeA) * SQ; // blade normal
            if (P.glow > 0) { // arcane charge along the blade
                g.globalCompositeOperation = 'lighter';
                g.globalAlpha = .35 * P.glow * look.fx; g.strokeStyle = NOAH_PAL.body; g.lineWidth = 7;
                g.beginPath(); g.moveTo(hand.x, hand.y); g.lineTo(tip.x, tip.y); g.stroke();
                g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
            }
            g.fillStyle = '#1b1530';
            g.beginPath(); g.moveTo(hand.x + nx * 3.3, hand.y + ny * 3.3); g.lineTo(tip.x, tip.y); g.lineTo(hand.x - nx * 3.3, hand.y - ny * 3.3); g.closePath(); g.fill();
            g.fillStyle = '#a6eaff';
            g.beginPath(); g.moveTo(hand.x + nx * 2.3, hand.y + ny * 2.3); g.lineTo(tip.x, tip.y); g.lineTo(hand.x - nx * 2.3, hand.y - ny * 2.3); g.closePath(); g.fill();
            g.strokeStyle = '#ecf9ff'; g.lineWidth = 1; g.beginPath(); g.moveTo(hand.x, hand.y); g.lineTo(tip.x, tip.y); g.stroke();
            // cross-guard + grip + pommel
            g.strokeStyle = '#d8ba68'; g.lineWidth = 2.4;
            g.beginPath(); g.moveTo(hand.x + nx * 4.5, hand.y + ny * 4.5); g.lineTo(hand.x - nx * 4.5, hand.y - ny * 4.5); g.stroke();
            const pom = pt(hand.x, hand.y, P.bladeA + PI, 4, P3);
            g.strokeStyle = '#3a2a4a'; g.lineWidth = 2.4; g.beginPath(); g.moveTo(hand.x, hand.y); g.lineTo(pom.x, pom.y); g.stroke();
        }
        // Markie's great-axe: long haft gripped low, a broad crescent head with a dark back spike.
        function drawAxe(g, P, hand, look) {
            const a = P.bladeA, nx = -Math.sin(a), ny = Math.cos(a) * SQ;
            const butt = pt(hand.x, hand.y, a + PI, 7, P3), top = pt(hand.x, hand.y, a, MARKIE_HAFT, P2);
            g.lineCap = 'round';
            g.strokeStyle = '#1a120d'; g.lineWidth = 5; g.beginPath(); g.moveTo(butt.x, butt.y); g.lineTo(top.x, top.y); g.stroke();
            g.strokeStyle = '#7a4f2c'; g.lineWidth = 3; g.beginPath(); g.moveTo(butt.x, butt.y); g.lineTo(top.x, top.y); g.stroke();
            // head: blade on the leading side (+normal toward the swing), spike behind
            const hx = top.x - Math.cos(a) * 5, hy = top.y - Math.sin(a) * 5 * SQ, sgn = P.axeSide || 1;
            const bx = nx * sgn, by = ny * sgn, ax = Math.cos(a), ay = Math.sin(a) * SQ;
            if (P.glow > 0) {
                g.globalCompositeOperation = 'lighter'; g.globalAlpha = .45 * P.glow * look.fx; g.fillStyle = MARKIE_PAL.body;
                g.beginPath(); g.arc(hx + bx * 9, hy + by * 9, 12, 0, PI * 2); g.fill();
                g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
            }
            g.fillStyle = '#1a120d';
            g.beginPath(); g.moveTo(hx - ax * 6, hy - ay * 6); g.quadraticCurveTo(hx + bx * 19 - ax * 11, hy + by * 19 - ay * 11, hx + bx * 17, hy + by * 17);
            g.quadraticCurveTo(hx + bx * 19 + ax * 11, hy + by * 19 + ay * 11, hx + ax * 7, hy + ay * 7); g.closePath(); g.fill();
            g.fillStyle = '#b9c2c9';
            g.beginPath(); g.moveTo(hx - ax * 4.5, hy - ay * 4.5); g.quadraticCurveTo(hx + bx * 16 - ax * 9, hy + by * 16 - ay * 9, hx + bx * 15, hy + by * 15);
            g.quadraticCurveTo(hx + bx * 16 + ax * 9, hy + by * 16 + ay * 9, hx + ax * 5.5, hy + ay * 5.5); g.closePath(); g.fill();
            g.strokeStyle = '#f2f6f8'; g.lineWidth = 1.2; g.beginPath(); // bright cutting edge
            g.moveTo(hx + bx * 15 - ax * 7, hy + by * 15 - ay * 7); g.quadraticCurveTo(hx + bx * 17, hy + by * 17, hx + bx * 15 + ax * 7, hy + by * 15 + ay * 7); g.stroke();
            g.fillStyle = '#4a4f55'; g.beginPath(); g.moveTo(hx - ax * 3, hy - ay * 3); g.lineTo(hx - bx * 8, hy - by * 8); g.lineTo(hx + ax * 3, hy + ay * 3); g.closePath(); g.fill();
        }
        // Destiny's longsword: steel blade, gold guard and pommel, red grip.
        function drawLongsword(g, P, hand, look) {
            const a = P.bladeA, tip = pt(hand.x, hand.y, a, DESTINY_BLADE, P2);
            const nx = -Math.sin(a), ny = Math.cos(a) * SQ;
            if (P.glow > 0) {
                g.globalCompositeOperation = 'lighter'; g.globalAlpha = .3 * P.glow * look.fx; g.strokeStyle = DESTINY_PAL.body; g.lineWidth = 5;
                g.beginPath(); g.moveTo(hand.x, hand.y); g.lineTo(tip.x, tip.y); g.stroke();
                g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
            }
            g.fillStyle = '#1c0d12';
            g.beginPath(); g.moveTo(hand.x + nx * 2.6, hand.y + ny * 2.6); g.lineTo(tip.x, tip.y); g.lineTo(hand.x - nx * 2.6, hand.y - ny * 2.6); g.closePath(); g.fill();
            g.fillStyle = '#dfe6ec';
            g.beginPath(); g.moveTo(hand.x + nx * 1.7, hand.y + ny * 1.7); g.lineTo(tip.x, tip.y); g.lineTo(hand.x - nx * 1.7, hand.y - ny * 1.7); g.closePath(); g.fill();
            g.strokeStyle = '#ffffff'; g.lineWidth = .8; g.beginPath(); g.moveTo(hand.x, hand.y); g.lineTo(tip.x, tip.y); g.stroke();
            g.strokeStyle = '#1c0d12'; g.lineWidth = 3.6; g.beginPath(); g.moveTo(hand.x + nx * 5.5, hand.y + ny * 5.5); g.lineTo(hand.x - nx * 5.5, hand.y - ny * 5.5); g.stroke();
            g.strokeStyle = '#F5C65D'; g.lineWidth = 2.2; g.beginPath(); g.moveTo(hand.x + nx * 5, hand.y + ny * 5); g.lineTo(hand.x - nx * 5, hand.y - ny * 5); g.stroke();
            const pom = pt(hand.x, hand.y, a + PI, 5, P3);
            g.strokeStyle = '#7a1622'; g.lineWidth = 2.4; g.beginPath(); g.moveTo(hand.x, hand.y); g.lineTo(pom.x, pom.y); g.stroke();
            g.fillStyle = '#F5C65D'; g.fillRect(pom.x - 1.5, pom.y - 1.5, 3, 3);
        }
        // Espirit's recurve bow, held perpendicular to the aim; the string hand pulls back to the anchor (draw 0..1),
        // the arrow is nocked while drawing/holding, and after release the string snaps and vibrates (recoil 1..0).
        const SH2 = { x: 0, y: 0 }, BW = { x: 0, y: 0 }, BT = { x: 0, y: 0 }, BB = { x: 0, y: 0 };
        function drawBow(g, P, sh, hand, look, col) {
            const a = P.armA, ax = Math.cos(a), ay = Math.sin(a) * SQ, nx = -Math.sin(a), ny = Math.cos(a) * SQ;
            const L = 15; // half bow length
            // limb tips curve back toward the archer (recurve)
            // Recurve tips face the target; the string and draw hand remain behind the grip.
            BT.x = hand.x + nx * L + ax * 4; BT.y = hand.y + ny * L + ay * 4;
            BB.x = hand.x - nx * L + ax * 4; BB.y = hand.y - ny * L + ay * 4;
            const pull = P.draw * 15; // string pull distance
            const vib = P.recoil > 0 ? Math.sin(P.recoil * 40) * 2.2 * P.recoil : 0;
            const sx = hand.x - ax * (3 + pull) + ax * vib, sy = hand.y - ay * (3 + pull) + ay * vib; // string nock point
            // rear (draw) arm: from the back shoulder to the nock point while drawing, else resting
            SH2.x = sh.x - (P.facingSign || 1) * 6; SH2.y = sh.y + 1.5;
            if (P.nocked || P.draw > 0) { BW.x = sx; BW.y = sy; drawArm(g, SH2, BW, Math.atan2(sy - SH2.y, sx - SH2.x), col) }
            drawArm(g, sh, hand, a, col);
            // bow limbs
            g.lineCap = 'round';
            g.strokeStyle = '#0f1a13'; g.lineWidth = 4;
            g.beginPath(); g.moveTo(BT.x, BT.y); g.quadraticCurveTo(hand.x + nx * 9 - ax * 5, hand.y + ny * 9 - ay * 5, hand.x, hand.y); g.quadraticCurveTo(hand.x - nx * 9 - ax * 5, hand.y - ny * 9 - ay * 5, BB.x, BB.y); g.stroke();
            g.strokeStyle = '#8a5a2b'; g.lineWidth = 2.4; g.stroke();
            g.strokeStyle = '#F5D477'; g.lineWidth = 1; g.beginPath(); g.moveTo(hand.x + nx * 3, hand.y + ny * 3); g.lineTo(hand.x - nx * 3, hand.y - ny * 3); g.stroke(); // gold grip wrap
            // string
            g.strokeStyle = '#eef6e8'; g.lineWidth = 1;
            g.beginPath(); g.moveTo(BT.x, BT.y); g.lineTo(sx, sy); g.lineTo(BB.x, BB.y); g.stroke();
            if (P.nocked) { // arrow on the string, tip past the bow; glows gold while drawn
                const tx = hand.x + ax * 9, ty = hand.y + ay * 9;
                if (P.draw > .3) {
                    g.globalCompositeOperation = 'lighter'; g.globalAlpha = .55 * P.draw * look.fx; g.fillStyle = '#F5D477';
                    g.beginPath(); g.arc(tx, ty, 2.5 + P.draw * 3, 0, PI * 2); g.fill();
                    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
                }
                g.strokeStyle = '#3a2614'; g.lineWidth = 2; g.beginPath(); g.moveTo(sx, sy); g.lineTo(tx, ty); g.stroke();
                g.strokeStyle = '#fff1b8'; g.lineWidth = 1; g.beginPath(); g.moveTo(tx - ax * 3, ty - ay * 3); g.lineTo(tx + ax * 1.5, ty + ay * 1.5); g.stroke();
                g.fillStyle = '#5CCE8A'; g.fillRect(sx - 1.5, sy - 1.5, 3, 3); // fletching
            }
            g.fillStyle = col[3]; g.fillRect(hand.x - 1.8, hand.y - 1.8, 3.6, 3.6);
        }

        // Tapered crescent between angles a0 (tail) -> a1 (head) at radius rIn with max thickness w.
        // Profile: grows from the tail, peaks at ~80%, then drops to a sharp leading point. Trailing chunks fade.
        function crescentPath(g, cx, cy, a0, a1, s0, s1, rIn, w, inner, outer) {
            const N = 10; let k = 0;
            for (let j = 0; j <= N; j++) { // outer edge, tail -> head
                const s = s0 + (s1 - s0) * j / N, wd = w * prof(s), a = a0 + (a1 - a0) * s, r = rIn + wd * outer;
                PTS[k++] = cx + Math.cos(a) * r; PTS[k++] = cy + Math.sin(a) * r * SQ;
            }
            for (let j = N; j >= 0; j--) { // inner edge, head -> tail
                const s = s0 + (s1 - s0) * j / N, wd = w * prof(s), a = a0 + (a1 - a0) * s, r = rIn - wd * inner;
                PTS[k++] = cx + Math.cos(a) * r; PTS[k++] = cy + Math.sin(a) * r * SQ;
            }
            g.beginPath(); g.moveTo(PTS[0], PTS[1]);
            for (let j = 2; j < k; j += 2) g.lineTo(PTS[j], PTS[j + 1]);
            g.closePath(); g.fill();
        }
        const prof = s => s <= 0 ? 0 : s >= 1 ? 0 : Math.pow(s, .75) * Math.pow(1 - s, .2) / .62;
        const CHUNKS = [0, .3, .55, .78, 1], CHUNK_A = [.16, .42, .75, 1];
        function drawCrescent(g, cx, cy, a0, a1, rIn, w, alpha, pal) {
            if (alpha <= 0.01 || w <= .3) return;
            g.globalCompositeOperation = 'lighter';
            for (let c = 0; c < 4; c++) {
                const s0 = CHUNKS[c], s1 = CHUNKS[c + 1], al = alpha * CHUNK_A[c];
                g.globalAlpha = al * .5; g.fillStyle = pal.glow; crescentPath(g, cx, cy, a0, a1, s0, s1, rIn, w, .55, 1.45); // deep electric outer glow
                g.globalAlpha = al * .85; g.fillStyle = pal.body; crescentPath(g, cx, cy, a0, a1, s0, s1, rIn, w, .25, 1); // body
                g.globalAlpha = al; g.fillStyle = pal.core; crescentPath(g, cx, cy, a0, a1, s0, s1, rIn, w * .55, .15, .7); // bright white-blue inner edge
            }
            g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
        }

        // ---------- per-frame draw ----------
        function poseFor(h, a, now, s) {
            if (!a) return restPose(h, now, s, pose);
            const el = elapsed(a, now);
            if (a.name === 'NOAH') return noahPose(h, a, el, pose);
            if (a.name === 'ESPIRIT') return bowPose(h, a, el, pose);
            if (a.name === 'SMITESH' || a.name === 'DONNA') { restPose(h, now, s, pose); pose.glow = Math.max(0, 1 - el / 320); return pose; }
            return meleePose(h, a, el, pose);
        }
        function liveAtk(s, h, now) {
            const a = s.atk;
            if (!a || a.name !== h.name) return null;
            if (now - a.start >= attackLife(a) + (a.holdMs || 0)) { s.atk = null; return null }
            return now >= a.start ? a : null;
        }
        // Body + weapon. look: {fx: effect alpha (dims AI), outline: color|null}
        function drawHero(g, h, i, now, k, look) {
            const s = heroState(i);
            const a = liveAtk(s, h, now);
            // Keep Noah's idle stance and Espirit's shooting pose anatomically readable.
            // Prefer consistent pose geometry for Noah's idle and Espirit's bow,
            // rather than swapping back to baked-arm or reversed-bow sheet frames.
            // One consistent character body for idle, run, hurt and attack.
            // Premium action sheets previously changed proportions and outfits mid-motion.
            // Preserve their independent combat FX, but never replace the hero body.
            // (The body and weapon below now animate from the same canonical art.)
            const P = poseFor(h, a, now, s);
            // Use the same torso silhouette in every pose, including attack recovery.
            if (h.name === 'NOAH') P.relaxedIdle = true;
            if (h.name === 'DAVE') { P.glow = a ? Math.max(.15, 1 - elapsed(a, now) / 500) : 0; P.armA = h.moving ? 1.15 : .85; }
            if (h.name === 'SMITESH' || h.name === 'DONNA') { P.armA = h.moving ? 1.05 : .85; P.reach = 10; }
            const f = h.facing === -1 ? -1 : 1;
            P.facingSign = a ? a.facing : f;
            const sh = shoulderOf(f, P, SH);
            // a weapon raised behind the head (idle, or Markie's wind-up) reads better behind the body
            const behind = h.name !== 'ESPIRIT' && Math.sin(P.bladeA) < -0.55 && (!a || (h.name === 'MARKIE' && elapsed(a, now) < timing(a).a));
            g.fillStyle = '#0b0914aa'; // stronger ground shadow under the feet
            g.beginPath(); g.ellipse(0, 2, h.name === 'MARKIE' ? 22 : 19, 5.5, 0, 0, PI * 2); g.fill();
            if (h.name === 'DAVE') drawDaveArms(g, P, look, f, 'back');
            else if (behind) drawArmAndSword(g, P, sh, look, h.name);
            drawBody(g, h, i, now, look, P);
            if (h.name === 'DAVE') drawDaveArms(g, P, look, f, 'front');
            else if (!behind) drawArmAndSword(g, P, sh, look, h.name);
            // level-up glow on the body for 1.2 s
            const lv = now - s.lvAt;
            if (lv >= 0 && lv < 1200) {
                const u = lv / 1200;
                g.globalCompositeOperation = 'lighter'; g.globalAlpha = .55 * (1 - u);
                g.save(); g.scale(f, 1);
                g.drawImage(silhouette(R.makePoseArt(h.name, 0, theme), look.color || '#ffd36d'), -W / 2, -H, W, H);
                g.restore();
                g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
            }
            return P;
        }

        // Draper's sheets: attack sheet while the body part of an attack plays, else hurt / run / idle.
        function drawSheetHero(g, h, s, a, now, look) {
            const f = h.facing === -1 ? -1 : 1, nm = h.name.toLowerCase();
            const sil = look.outline ? silhouette : null;
            let ok = false;
            if (a && a.sheet && now - a.start < bodyEnd(a) + (a.holdMs || 0)) {
                const el = elapsed(a, now);
                if (a.name === 'ESPIRIT') ok = SHEETS.draw(g, 'bow' + a.dir, bowFrame(a, el), false, 1, look.outline, sil);
                else if (a.name === 'NOAH') ok = SHEETS.draw(g, 'noah' + a.stage + a.dir, Math.floor(el / timing(a).fd), false, 1, look.outline, sil);
                else ok = SHEETS.draw(g, a.name === 'MARKIE' ? 'markieSmash' : 'destinySweep', Math.floor(el / timing(a).fd), a.m < 0, 1, look.outline, sil);
            }
            if (!ok) {
                const hurt = now - s.hurtAt;
                if (hurt >= 0 && hurt < 280 && SHEETS.ready(nm + 'Hurt')) ok = SHEETS.draw(g, nm + 'Hurt', Math.floor(hurt / 70), f < 0, 1, look.outline, sil);
                else if (h.moving && SHEETS.ready(nm + 'Run')) ok = SHEETS.draw(g, nm + 'Run', Math.floor(now / 80) % 8, f < 0, 1, look.outline, sil);
                else if (SHEETS.ready(nm + 'Idle')) ok = SHEETS.draw(g, nm + 'Idle', Math.floor((now + h.name.length * 97) / 120) % 6, f < 0, 1, look.outline, sil);
            }
            if (!ok) return false;
            const lv = now - s.lvAt; // level-up glow on the body for 1.2 s
            if (lv >= 0 && lv < 1200) {
                g.globalCompositeOperation = 'lighter'; g.globalAlpha = .5 * (1 - lv / 1200);
                g.fillStyle = look.color || '#ffd36d'; g.beginPath(); g.ellipse(0, -34, 26, 40, 0, 0, PI * 2); g.fill();
                g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
            }
            return true;
        }
        // Sheet-mode attack effects: Draper's FX sheets, plus a rotated procedural crescent where the E/W-only
        // bodies can't show the aim (Markie / Destiny up, down and diagonals).
        const CHEST = -34;
        function sheetFx(g, h, s, a, now, dt, k, look) {
            const el = elapsed(a, now), T = timing(a), fx = look.fx;
            const cx = Math.cos(a.theta), cy = Math.sin(a.theta);
            if (a.name === 'NOAH') {
                if (a.stage < 2) { // tapered crescent from the swing frame; Reverse Arc = mirrored across the aim line
                    const t = el - T.fd; if (t < 0) return;
                    const fr = Math.floor(t / CRES_FD); if (fr >= 8) return;
                    g.save(); g.translate(0, CHEST);
                    if (a.stage === 1) { g.rotate(a.theta); g.scale(1, -1); g.rotate(-a.theta) }
                    g.globalAlpha = fx; SHEETS.draw(g, 'cres' + a.dir, fr, false, 1.7);
                    g.globalCompositeOperation = 'lighter'; g.globalAlpha = .45 * fx * (1 - fr / 8); SHEETS.draw(g, 'cres' + a.dir, fr, false, 1.7); // faint additive glow
                    g.restore(); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
                } else { // Arcane Breaker: shockwave on the floor in front + shards at the blade on the impact frame
                    const t = el - T.a; if (t < 0) return;
                    const fr = Math.floor(t / SHOCK_FD);
                    if (fr < 8) { g.save(); g.translate(cx * 22, cy * 14); g.scale(1, .55); g.globalAlpha = fx; SHEETS.draw(g, 'noahShock', fr, false, 1.6); g.restore() }
                    const fs = Math.floor(t / SHARD_FD);
                    if (fs < 6) { g.save(); g.translate(cx * 26, CHEST + 10 + cy * 18); g.globalAlpha = fx; SHEETS.draw(g, 'noahShards', fs, false, 1.1); g.restore() }
                    g.globalAlpha = 1;
                }
                return;
            }
            if (a.name === 'MARKIE') { // frame 6: orange sparks at the axe + perspective ground crack (never flipped)
                const t = el - T.a;
                if (t >= 0) {
                    const fr = Math.floor(t / CRACK_FD);
                    if (fr < 8) { g.save(); g.translate(cx * 30, 2 + cy * 18); g.globalAlpha = fx; SHEETS.draw(g, 'markieCrack', fr, false, a.stage === 2 ? 1.5 : 1.15); g.restore() }
                    const fs = Math.floor(t / SPARK_FD);
                    if (fs < 6) { g.save(); g.translate(cx * 30, -8 + cy * 18); g.globalAlpha = fx; SHEETS.draw(g, 'markieSparks', fs, a.m < 0, a.stage === 2 ? 1.6 : 1.2); g.restore() }
                    g.globalAlpha = 1;
                }
            }
            if (Math.abs(cy) > .3) { // rotated effect layer for non-horizontal aims (procedural crescent around the chest)
                const D = DEFS[a.name][a.stage], heavy = a.name === 'MARKIE';
                const sw0 = heavy ? 4 * T.fd : 2 * T.fd, sw1 = heavy ? 6 * T.fd : 5 * T.fd;
                if (el < sw0 || el > sw1 + 160) return;
                const q = clamp01((el - sw0) / (sw1 - sw0)), e = easeInOut3(q);
                const Ang = swingAngles(a, D.thrust ? DESTINY_T[1] : D), cur = lerp(Ang.from, Ang.to, e);
                const fade = el > sw1 ? 1 - (el - sw1) / 160 : 1, pal = heavy ? MARKIE_PAL : DESTINY_PAL;
                drawCrescent(g, 0, CHEST + 4, lerp(Ang.from, cur, clamp01(e - .5) * .6), cur, heavy ? 40 : 46, (heavy ? 20 : 12) * (.5 + .5 * e), fx * .8 * fade, pal);
            }
        }

        // Attack effects in front of units (crescent, afterimages, shards). Same transform as drawHero.
        function drawFx(g, h, i, now, dt, k, look, hx, hy) {
            const s = st[i], a = s && s.atk;
            if (!a || a.name !== h.name || now < a.start) return;
            if (a.sheet) return a.name === 'ESPIRIT' ? undefined : sheetFx(g, h, s, a, now, dt, k, look);
            if (a.name === 'NOAH') return noahFx(g, h, s, a, now, dt, k, look, hx, hy);
            if (a.name === 'ESPIRIT') return bowFx(g, h, s, a, now, dt, k, look, hx, hy);
            if (a.name === 'SMITESH' || a.name === 'DONNA') return;
            return meleeFx(g, h, s, a, now, dt, k, look, hx, hy);
        }
        function noahFx(g, h, s, a, now, dt, k, look, hx, hy) {
            const T = NOAH_T[a.stage], el = elapsed(a, now);
            if (el < T.a - 20) return; // anticipation: no detached effects, only the blade charge
            const f = a.facing;
            const P = noahPose(h, a, el, pose);
            const sh = shoulderOf(f, P, SH);
            const A = noahAngles(a), range = 113 * S, rRange = Math.max(NOAH_TIP + 12, range * .8 / k);
            const fx = look.fx;
            if (el < T.a + T.s) { // attached crescent grows along the blade path
                const q = clamp01((el - T.a) / T.s), e = easeInOut3(q);
                const cur = lerp(A.from, A.to, e);
                const tail = lerp(A.from, cur, clamp01(e - .65) * .5);
                drawCrescent(g, sh.x, sh.y, tail, cur, NOAH_TIP - 3, T.thick * (.55 + .45 * e), fx, NOAH_PAL);
                afterimages(g, sh, A, e, NOAH_REACH, NOAH_TIP, NOAH_PAL, fx);
                emitShards(s, dt, T, sh, cur, NOAH_TIP + T.thick * .5, a.m * (A.to > A.from ? 1 : -1), hx, hy, k, fx, NOAH_PAL.spark, 1);
            }
            const rel = el - T.a - T.s;
            if (rel >= 0 && rel < T.rel) { // 3. arcane release: the crescent leaves the blade and expands outward
                const u = rel / T.rel, eo = easeOut3(u);
                const rIn = lerp(NOAH_TIP - 3, rRange, eo);
                const tail = lerp(A.from, A.to, Math.min(1, u * .85));
                drawCrescent(g, sh.x, sh.y, tail, A.to, rIn, T.thick * (1 + .35 * u) * (1 - u * .55), fx * (1 - Math.pow(u, 1.6)), NOAH_PAL);
                // residual trail left on the blade path
                drawCrescent(g, sh.x, sh.y, lerp(A.from, A.to, Math.min(1, u * 1.4)), A.to, NOAH_TIP - 2, T.thick * .35 * (1 - u), fx * .45 * (1 - u), NOAH_PAL);
                if (u < .4) emitShards(s, dt, T, sh, A.to, rIn + T.thick * .6, a.m * (A.to > A.from ? 1 : -1), hx, hy, k, fx * .8, NOAH_PAL.spark, 1);
            }
        }
        function afterimages(g, sh, A, e, r0, r1, pal, fx) { // motion blur: weapon afterimages along the path
            g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
            for (let j = 1; j <= 3; j++) {
                const pa = lerp(A.from, A.to, Math.max(0, e - .07 * j));
                const hp = pt(sh.x, sh.y, pa, r0, P1), tp = pt(sh.x, sh.y, pa, r1, P2);
                g.globalAlpha = (.34 - j * .09) * fx; g.strokeStyle = j === 1 ? pal.core : pal.body; g.lineWidth = 3.5 - j * .6;
                g.beginPath(); g.moveTo(hp.x, hp.y); g.lineTo(tp.x, tp.y); g.stroke();
            }
            g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
        }
        const MARKIE_SPARK = ['#FFF0A4', '#FF9657', '#FFC277', '#C98A4B'], DESTINY_SPARK = ['#FFF7DA', '#F5C65D', '#FFE1A2', '#ffffff'];
        // Markie + Destiny: crescent hugging the weapon head (Markie: heavy ember arc that barely travels; Destiny:
        // thin precise gold arc, or a straight gold glint line on the thrust).
        function meleeFx(g, h, s, a, now, dt, k, look, hx, hy) {
            const T = timing(a), el = elapsed(a, now), fx = look.fx;
            if (el < T.a - 10) return;
            const P = meleePose(h, a, el, pose), sh = shoulderOf(a.facing, P, SH);
            const heavy = a.name === 'MARKIE', pal = heavy ? MARKIE_PAL : DESTINY_PAL, tipR = heavy ? MARKIE_TIP + 4 : DESTINY_TIP;
            const sparks = heavy ? MARKIE_SPARK : DESTINY_SPARK;
            if (T.thrust) { // Destiny's thrust: a sharp gold line that extends past the tip, then a glint
                const q = clamp01((el - T.a) / T.s);
                if (el < T.a || el > T.a + T.s + 140) return;
                const fade = el < T.a + T.s ? 1 : 1 - (el - T.a - T.s) / 140;
                const hand = pt(sh.x, sh.y, P.armA, P.reach, P1), tip = pt(hand.x, hand.y, P.bladeA, DESTINY_BLADE + 16 * easeOut3(q), P2);
                g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
                g.globalAlpha = .45 * fade * fx; g.strokeStyle = pal.glow; g.lineWidth = 7; g.beginPath(); g.moveTo(hand.x, hand.y); g.lineTo(tip.x, tip.y); g.stroke();
                g.globalAlpha = .9 * fade * fx; g.strokeStyle = pal.core; g.lineWidth = 2; g.stroke();
                const gl = 6 * fade; g.globalAlpha = fade * fx; g.strokeStyle = '#ffffff'; g.lineWidth = 1.4; // four-point glint at the tip
                g.beginPath(); g.moveTo(tip.x - gl, tip.y); g.lineTo(tip.x + gl, tip.y); g.moveTo(tip.x, tip.y - gl); g.lineTo(tip.x, tip.y + gl); g.stroke();
                g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
                return;
            }
            const A = swingAngles(a, T);
            if (el < T.a + T.s) {
                const q = clamp01((el - T.a) / T.s), e = heavy ? easeIn2(q) * .35 + easeInOut3(q) * .65 : easeInOut3(q);
                const cur = lerp(A.from, A.to, e), tail = lerp(A.from, cur, clamp01(e - .55) * .6);
                if (q > 0) drawCrescent(g, sh.x, sh.y, tail, cur, tipR - (heavy ? 8 : 3), T.thick * (.5 + .5 * e), fx * (heavy ? .9 : .8), pal);
                if (q > 0) afterimages(g, sh, A, e, heavy ? MARKIE_REACH + 14 : DESTINY_REACH, tipR, pal, fx * (heavy ? 1 : .7));
                if (q > .2) emitShards(s, dt, T, sh, cur, tipR, a.m * (A.to > A.from ? 1 : -1), hx, hy, k, fx, sparks, heavy ? 2 : 1, heavy ? .07 : .03);
            }
            const rel = el - T.a - T.s, relLife = heavy ? 200 : 170;
            if (rel >= 0 && rel < relLife) { // short follow-through trail; it fades in place (Markie) or drifts a little (Destiny)
                const u = rel / relLife, rIn = tipR - (heavy ? 8 : 3) + (heavy ? 4 : 10) * easeOut3(u);
                drawCrescent(g, sh.x, sh.y, lerp(A.from, A.to, Math.min(1, .3 + u)), A.to, rIn, T.thick * (1 - u * .6), fx * (1 - u) * (heavy ? .85 : .7), pal);
                if (!heavy && a.stage === 2 && u < .6) { // Destiny's cross-cut: a gold guard flare (defensive shimmer) at the hand
                    const hand = pt(sh.x, sh.y, P.armA, P.reach, P1), r = 6 + 14 * u;
                    g.globalCompositeOperation = 'lighter'; g.globalAlpha = (1 - u / .6) * .8 * fx; g.strokeStyle = pal.body; g.lineWidth = 2;
                    g.beginPath(); g.ellipse(hand.x, hand.y, r, r * SQ, 0, 0, PI * 2); g.stroke();
                    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
                }
            }
        }
        // Espirit: gold glow gathers on the arrowhead while she draws; a release flash at the bow.
        function bowFx(g, h, s, a, now, dt, k, look, hx, hy) {
            const el = now - a.start, rel = el - bowRel(a);
            if (rel < 0 || rel > 120) return;
            const P = bowPose(h, a, el, pose), sh = shoulderOf(a.facing, P, SH), hand = pt(sh.x, sh.y, P.armA, P.reach, P1);
            const u = rel / 120, ax = Math.cos(a.theta), ay = Math.sin(a.theta) * SQ;
            g.globalCompositeOperation = 'lighter';
            g.globalAlpha = (1 - u) * .8 * look.fx; g.fillStyle = '#FFE17B';
            g.beginPath(); g.ellipse(hand.x + ax * 8, hand.y + ay * 8, 4 + 10 * u, (4 + 10 * u) * .45, a.theta, 0, PI * 2); g.fill();
            g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
        }
        function emitShards(s, dt, T, sh, ang, r, dir, hx, hy, k, fx, cols, kind, rate) {
            s.shardAcc += dt * (rate || T.shards);
            if (s.shardAcc < 1) return;
            const n = Math.floor(s.shardAcc); s.shardAcc -= n;
            const lx = sh.x + Math.cos(ang) * r, ly = sh.y + Math.sin(ang) * r * SQ;
            const tx = -Math.sin(ang) * dir, ty = Math.cos(ang) * dir * SQ; // tangent along the swing
            pool.emit(n, (p, j) => {
                p.x = hx + lx * k; p.y = hy + ly * k;
                const sp = (.05 + Math.random() * .1) * k;
                p.vx = (tx * .6 + Math.cos(ang) * .5) * sp + (Math.random() - .5) * .03; p.vy = (ty * .6 + Math.sin(ang) * .5 * SQ) * sp + (Math.random() - .5) * .03;
                p.kind = kind || 1; p.size = (kind === 2 ? 3 + Math.random() * 2 : 2.5 + Math.random() * 3) * Math.min(k, 1.3); p.life = 260 + Math.random() * 220;
                if (kind === 2) { p.grav = .0005; p.vy -= .05 } // Markie: embers arc and fall
                p.color = cols[(Math.random() * 4) | 0]; p.add = true; p.drag = .002; p.alpha = fx;
                p.rot = ang + PI / 2; p.vr = (Math.random() - .5) * .02;
            });
        }
        function hasPose(name) { return name === 'NOAH' || name === 'MARKIE' || name === 'DESTINY' || name === 'ESPIRIT' || name === 'SMITESH' || name === 'DAVE' || name === 'DONNA' }
        const usingSheets = () => !!(SHEETS && !opts.procedural);
        return { usingSheets, onAttack, contactAt, releaseAt, hitStop, onHurt, onLevelUp, drawHero, drawFx, hasPose, stateOf: i => st[i], NOAH_T, MARKIE_T, DESTINY_T, BOW, attackLife, bowRel };
    }
    root.WCHHeroAnim = { create, SQ };
})(window);
