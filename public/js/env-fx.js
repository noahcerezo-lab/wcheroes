/*
 * West Coast Heroes — battlefield environment for the multiplayer arena (client only, cosmetic). Milestone 4/5.
 *
 * Draper's Moonlit Temple pack (m-overhaul group 7): wrapping parallax layers (sky + moon, temple silhouettes,
 * near pillars), a seamless 64 px stone floor, mist / ember sprites and soft shadows.
 *
 * - Each zone is composited ONCE into a cached 1440x810 canvas (sky, temples, stone floor with depth shading,
 *   moonlight pool, pillars, vignette) and colour-graded per zone, so a frame costs one drawImage.
 *   Zone palettes: 0 Moonlit Temple (as painted), 1 Ember Fortress (warm red), 2 Verdant Ruins (teal-green),
 *   3 Celestial Void (violet).
 * - Ambient mist and embers live in a fixed array (no allocation), move with real elapsed time, and their
 *   count follows the arena's adaptive density.
 * - Until the PNGs load (or if they fail) the arena keeps the V19 procedural arena.
 */
(function (root) {
    'use strict';
    const W = 1440, H = 810, HORIZON = 402;
    const GRADE = [null, { tint: '#ff7a4a', a: .5, light: '#ffae68' }, { tint: '#3fd6b0', a: .42, light: '#a4fff2' }, { tint: '#9a7bff', a: .5, light: '#dbbbff' }];
    const MIST_TINT = ['#c6ece0', '#ffb08a', '#a4fff2', '#dbbbff'];
    const EMBER_N = [10, 26, 12, 16], MIST_N = [9, 5, 10, 8];
    const cache = [];
    const tints = {};
    function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c }
    function ready(OV) { return !!(OV.sky && OV.temple && OV.pillars && OV.floor) }
    function tinted(im, color, key) { // sprite recoloured once (alpha kept)
        if (tints[key]) return tints[key];
        const c = canvas(im.width, im.height), g = c.getContext('2d');
        g.drawImage(im, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
        g.globalCompositeOperation = 'lighter'; g.globalAlpha = .35; g.drawImage(im, 0, 0);
        return (tints[key] = c);
    }
    function compose(OV, zone) {
        const c = canvas(W, H), g = c.getContext('2d');
        g.imageSmoothingEnabled = false;
        g.drawImage(OV.sky, 0, 0);
        // stone floor (64 px tiles), darker toward the horizon for depth
        for (let y = HORIZON; y < H; y += 64) for (let x = 0; x < W; x += 64) g.drawImage(OV.floor, x, y);
        let gr = g.createLinearGradient(0, HORIZON, 0, H);
        gr.addColorStop(0, 'rgba(6,10,22,.62)'); gr.addColorStop(.35, 'rgba(6,10,22,.25)'); gr.addColorStop(1, 'rgba(6,10,22,.05)');
        g.fillStyle = gr; g.fillRect(0, HORIZON, W, H - HORIZON);
        g.drawImage(OV.temple, 0, 0);
        // moonlight: a cool pool of light on the floor below the moon + a soft beam
        g.globalCompositeOperation = 'lighter';
        gr = g.createRadialGradient(980, 600, 20, 980, 600, 520);
        gr.addColorStop(0, 'rgba(198,236,224,.16)'); gr.addColorStop(1, 'rgba(198,236,224,0)');
        g.fillStyle = gr; g.fillRect(0, HORIZON, W, H - HORIZON);
        g.globalCompositeOperation = 'source-over';
        g.drawImage(OV.pillars, 0, 0);
        const G = GRADE[zone];
        if (G) { // colour grade: keep luminance, take the zone hue; then a little warm/cool light
            g.globalCompositeOperation = 'color'; g.globalAlpha = G.a; g.fillStyle = G.tint; g.fillRect(0, 0, W, H);
            g.globalCompositeOperation = 'soft-light'; g.globalAlpha = .25; g.fillStyle = G.light; g.fillRect(0, 0, W, H);
            g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
        }
        // vignette keeps the eye in the middle and the HUD corners readable
        gr = g.createRadialGradient(W / 2, H * .58, H * .35, W / 2, H * .58, W * .72);
        gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(4,4,12,.55)');
        g.fillStyle = gr; g.fillRect(0, 0, W, H);
        return c;
    }
    function create(opts) {
        const OV = opts.OV;
        // ambient particles: fixed slots [x, y, vx, vy, age, life, kind(0 mist / 1 ember), frame offset]
        const N = 40, P = new Float32Array(N * 8);
        let live = 0, lastZone = -1;
        function seed(i, zone, anywhere) {
            const o = i * 8, ember = i % 3 !== 0 ? 1 : 0;
            P[o + 6] = ember;
            P[o] = Math.random() * W;
            P[o + 1] = anywhere ? HORIZON + Math.random() * (H - HORIZON) : (ember ? H + 10 : HORIZON + 20 + Math.random() * (H - HORIZON - 40));
            P[o + 2] = ember ? (Math.random() - .5) * .02 : (.008 + Math.random() * .012) * (Math.random() < .5 ? -1 : 1);
            P[o + 3] = ember ? -(.025 + Math.random() * .035) : 0;
            P[o + 4] = anywhere ? Math.random() * 4000 : 0; P[o + 5] = ember ? 5000 + Math.random() * 5000 : 9000 + Math.random() * 6000;
            P[o + 7] = Math.random() * 6;
        }
        function draw(g, now, dt, zone, density) {
            if (!ready(OV)) return false;
            zone = ((zone | 0) % 4 + 4) % 4;
            const bg = cache[zone] || (cache[zone] = compose(OV, zone));
            g.drawImage(bg, 0, 0);
            const want = Math.round((EMBER_N[zone] + MIST_N[zone]) * Math.max(.35, density || 1));
            if (zone !== lastZone) { lastZone = zone; live = 0 }
            while (live < Math.min(N, want)) seed(live++, zone, true);
            if (live > want) live = want;
            const mist = OV.mist && tinted(OV.mist, MIST_TINT[zone], 'mist' + zone), ember = OV.ember;
            g.imageSmoothingEnabled = false;
            for (let i = 0; i < live; i++) {
                const o = i * 8;
                P[o + 4] += dt; P[o] += P[o + 2] * dt; P[o + 1] += P[o + 3] * dt;
                if (P[o + 4] > P[o + 5] || P[o] < -60 || P[o] > W + 60 || P[o + 1] < HORIZON - 120) { seed(i, zone, false); continue }
                const u = P[o + 4] / P[o + 5], a = Math.min(1, u * 5, (1 - u) * 4);
                if (P[o + 6] === 0 && mist) { // mist puff: slow drift, 3x scale
                    g.globalAlpha = .32 * a; const f = Math.floor(now / 260 + P[o + 7]) % 4;
                    g.drawImage(mist, f * 24, 0, 24, 16, Math.round(P[o]), Math.round(P[o + 1]), 72, 48);
                } else if (ember) { // rising ember, flickers
                    g.globalAlpha = .85 * a; const f = Math.floor(now / 110 + P[o + 7]) % 6;
                    g.drawImage(ember, f * 8, 0, 8, 8, Math.round(P[o + 1] > 0 ? P[o] + Math.sin(now / 600 + i) * 6 : P[o]), Math.round(P[o + 1]), zone === 1 ? 12 : 9, zone === 1 ? 12 : 9);
                }
            }
            g.globalAlpha = 1;
            return true;
        }
        // Soft pixel shadow under a unit (never flipped). size: 0 sm, 1 md (heroes), 2 lg, 3 xl
        const SH = ['shadowSm', 'shadowMd', 'shadowLg', 'shadowXl'];
        function shadow(g, size, w) {
            const im = OV[SH[size]]; if (!im) return false;
            const s = (w || im.width) / im.width;
            g.drawImage(im, Math.round(-im.width * s / 2), Math.round(-im.height * s / 2 + 1), im.width * s, im.height * s);
            return true;
        }
        return { draw, shadow, ready: () => ready(OV), cached: () => cache.filter(Boolean).length };
    }
    root.WCHEnv = { create };
})(typeof window !== 'undefined' ? window : globalThis);
