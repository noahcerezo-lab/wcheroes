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
            s.atk = { name: h.name, stage: Math.max(0, Math.min(2, stage | 0)), start: now, theta, m, facing, holdAt: 0, holdMs: 0, shockDone: false, contactDone: false };
            s.shardAcc = 0;
            return s.atk;
        }
        function timing(a) { return a.name === 'NOAH' ? NOAH_T[a.stage] : null }
        // Absolute time at which this swing's weapon connects (impacts are shown then, not when the packet lands).
        function contactAt(i) {
            const s = st[i], a = s && s.atk; if (!a) return 0;
            const T = timing(a); if (!T) return a.start;
            return a.start + T.a + T.s * T.contact;
        }
        function hitStop(i, ms) {
            const s = st[i], a = s && s.atk; if (!a || a.holdMs) return;
            const T = timing(a); if (!T) return;
            a.holdAt = T.a + T.s * T.contact; a.holdMs = ms || T.stop;
        }
        function elapsed(a, now) {
            let e = now - a.start;
            if (a.holdMs && e > a.holdAt) e = Math.max(a.holdAt, e - a.holdMs);
            return e;
        }
        function attackLife(a) { const T = timing(a); return T ? T.a + T.s + Math.max(T.r, T.rel) : 300 }
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
            const f = h.facing === -1 ? -1 : 1;
            out.lean = 0; out.twist = 0; out.crouch = 0; out.fdx = 0; out.bdx = 0; out.flift = 0; out.blift = 0; out.glow = 0;
            if (h.moving) { // run cycle: legs alternate and lift, torso bobs and leans into the run
                const ph = now / 85;
                out.fdx = Math.sin(ph) * 3.2; out.bdx = -out.fdx;
                out.flift = Math.max(0, Math.cos(ph)) * -1.8; out.blift = Math.max(0, -Math.cos(ph)) * -1.8;
                out.bob = -Math.abs(Math.sin(ph)) * 1.4; out.lean = .07;
                out.armA = toWorld(1.9, f); out.bladeA = toWorld(-2.35, f); out.reach = 10; // sword trails back while running
            } else { // combat stance: feet apart, small breathing on the torso only
                out.fdx = 1.5; out.bdx = -1;
                out.bob = Math.sin(now / 450) * .6;
                out.armA = toWorld(1.25, f); out.bladeA = toWorld(-1.0 + Math.sin(now / 700) * .04, f); out.reach = 11;
            }
            const hurt = now - s.hurtAt;
            if (hurt < 260) { const u = 1 - hurt / 260; out.lean -= .2 * u * u; out.bdx -= 2 * u }
            return out;
        }
        function noahPose(h, a, el, out) {
            const T = NOAH_T[a.stage], A = noahAngles(a), f = a.facing;
            const restA = toWorld(-1.0, f), heavy = a.stage === 2, rev = a.stage === 1;
            out.flift = out.blift = 0; out.bob = 0; out.glow = 0;
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
                    g.drawImage(img, 0, 0, 96, legSrcY, -W / 2, -legSrcY * PX, W, legSrcY * PX);
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

        function drawArmAndSword(g, P, sh, look) {
            const hand = pt(sh.x, sh.y, P.armA, P.reach, P1);
            // elbow: bend outward a little so the arm reads as an arm, not a stick
            const ex = (sh.x + hand.x) / 2 + Math.cos(P.armA + PI / 2) * 2, ey = (sh.y + hand.y) / 2 + Math.sin(P.armA + PI / 2) * 2 * SQ;
            g.lineCap = 'round';
            g.strokeStyle = '#1b1530'; g.lineWidth = 6.5; // ink outline
            g.beginPath(); g.moveTo(sh.x, sh.y); g.lineTo(ex, ey); g.lineTo(hand.x, hand.y); g.stroke();
            g.strokeStyle = '#4b3aa8'; g.lineWidth = 4.5; // sleeve
            g.beginPath(); g.moveTo(sh.x, sh.y); g.lineTo(ex, ey); g.stroke();
            g.strokeStyle = '#6a52d0'; g.beginPath(); g.moveTo(ex, ey); g.lineTo(hand.x, hand.y); g.stroke();
            // blade
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
            g.fillStyle = '#e8aa7f'; g.fillRect(hand.x - 1.8, hand.y - 1.8, 3.6, 3.6); // hand
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
        // Body + weapon. look: {fx: effect alpha (dims AI), outline: color|null}
        function drawHero(g, h, i, now, k, look) {
            const s = heroState(i);
            const a = s.atk && s.atk.name === h.name && now - s.atk.start < attackLife(s.atk) + (s.atk.holdMs || 0) ? s.atk : null;
            if (!a && s.atk && s.atk.name === h.name && now - s.atk.start >= attackLife(s.atk) + (s.atk.holdMs || 0)) s.atk = null;
            const P = a && h.name === 'NOAH' ? noahPose(h, a, elapsed(a, now), pose) : restPose(h, now, s, pose);
            const f = h.facing === -1 ? -1 : 1;
            const sh = shoulderOf(f, P, SH);
            const swordBehind = h.name === 'NOAH' && Math.sin(P.bladeA) < -0.55 && !a; // idle sword raised behind the head reads better behind
            g.fillStyle = '#0b0914aa'; // stronger ground shadow under the feet
            g.beginPath(); g.ellipse(0, 2, 19, 5.5, 0, 0, PI * 2); g.fill();
            if (swordBehind) drawArmAndSword(g, P, sh, look);
            drawBody(g, h, i, now, look, P);
            if (!swordBehind) drawArmAndSword(g, P, sh, look);
            // level-up glow on the body for 1.2 s
            const lv = now - s.lvAt;
            if (lv < 1200) {
                const u = lv / 1200;
                g.globalCompositeOperation = 'lighter'; g.globalAlpha = .55 * (1 - u);
                g.drawImage(silhouette(R.makePoseArt(h.name, 0, theme), look.color || '#ffd36d'), -W / 2 * f, -H, W * f, H);
                g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
            }
            return P;
        }

        // Attack effects in front of units (crescent, afterimages, shards). Same transform as drawHero.
        function drawFx(g, h, i, now, dt, k, look, hx, hy) {
            const s = st[i], a = s && s.atk;
            if (!a || a.name !== 'NOAH' || h.name !== 'NOAH') return;
            const T = NOAH_T[a.stage], el = elapsed(a, now);
            if (el < T.a - 20) { // anticipation: arcane charge gathering at the blade (tiny, not a ring)
                return;
            }
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
                // motion blur: blade afterimages along the path
                g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
                for (let j = 1; j <= 3; j++) {
                    const pa = lerp(A.from, A.to, Math.max(0, e - .07 * j));
                    const hp = pt(sh.x, sh.y, pa, NOAH_REACH, P1), tp = pt(sh.x, sh.y, pa, NOAH_TIP, P2);
                    g.globalAlpha = (.34 - j * .09) * fx; g.strokeStyle = j === 1 ? NOAH_PAL.core : NOAH_PAL.body; g.lineWidth = 3.5 - j * .6;
                    g.beginPath(); g.moveTo(hp.x, hp.y); g.lineTo(tp.x, tp.y); g.stroke();
                }
                g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
                emitShards(s, dt, T, sh, cur, NOAH_TIP + T.thick * .5, a.m * (A.to > A.from ? 1 : -1), hx, hy, k, fx);
            }
            const rel = el - T.a - T.s;
            if (rel >= 0 && rel < T.rel) { // 3. arcane release: the crescent leaves the blade and expands outward
                const u = rel / T.rel, eo = easeOut3(u);
                const rIn = lerp(NOAH_TIP - 3, rRange, eo);
                const tail = lerp(A.from, A.to, Math.min(1, u * .85));
                drawCrescent(g, sh.x, sh.y, tail, A.to, rIn, T.thick * (1 + .35 * u) * (1 - u * .55), fx * (1 - Math.pow(u, 1.6)), NOAH_PAL);
                // residual trail left on the blade path
                drawCrescent(g, sh.x, sh.y, lerp(A.from, A.to, Math.min(1, u * 1.4)), A.to, NOAH_TIP - 2, T.thick * .35 * (1 - u), fx * .45 * (1 - u), NOAH_PAL);
                if (u < .4) emitShards(s, dt, T, sh, A.to, rIn + T.thick * .6, a.m * (A.to > A.from ? 1 : -1), hx, hy, k, fx * .8);
            }
        }
        function emitShards(s, dt, T, sh, ang, r, dir, hx, hy, k, fx) {
            s.shardAcc += dt * T.shards;
            if (s.shardAcc < 1) return;
            const n = Math.floor(s.shardAcc); s.shardAcc -= n;
            const lx = sh.x + Math.cos(ang) * r, ly = sh.y + Math.sin(ang) * r * SQ;
            const tx = -Math.sin(ang) * dir, ty = Math.cos(ang) * dir * SQ; // tangent along the swing
            pool.emit(n, (p, j) => {
                p.x = hx + lx * k; p.y = hy + ly * k;
                const sp = (.05 + Math.random() * .1) * k;
                p.vx = (tx * .6 + Math.cos(ang) * .5) * sp + (Math.random() - .5) * .03; p.vy = (ty * .6 + Math.sin(ang) * .5 * SQ) * sp + (Math.random() - .5) * .03;
                p.kind = 1; p.size = (2.5 + Math.random() * 3) * Math.min(k, 1.3); p.life = 260 + Math.random() * 220;
                p.color = NOAH_PAL.spark[(Math.random() * 4) | 0]; p.add = true; p.drag = .002; p.alpha = fx;
                p.rot = ang + PI / 2; p.vr = (Math.random() - .5) * .02;
            });
        }
        function hasPose(name) { return name === 'NOAH' }
        return { onAttack, contactAt, hitStop, onHurt, onLevelUp, drawHero, drawFx, hasPose, stateOf: i => st[i], NOAH_T, attackLife };
    }
    root.WCHHeroAnim = { create, SQ };
})(window);
