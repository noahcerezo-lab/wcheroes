/*
 * West Coast Heroes — shared hero/arena renderer.
 *
 * Extracted from public/legacy-v19.html (V19) so the single-player game and the
 * multiplayer client draw heroes, enemies and the battlefield with the SAME code.
 * The drawing functions below are V19's originals; the only edits are:
 *   - the canvas context is passed in instead of read from V19's global `x`
 *   - sprite(): `(entity||player)` -> `(entity||{})` (no global player here)
 *   - drawArena(): the arena zone is a parameter instead of derived from V19's global `wave`
 * Exposes window.WCHRender (browser) / module.exports (Node, for tests).
 */
(function(root) {
    'use strict';
    let x = null; // active 2D context (V19 named its context `x`)
    // Multiplayer pose layer only: when true, makeArt/makeHDArt leave out the weapon and the weapon hand so
    // the client can draw them as separately animated parts. V19 never sets it, so legacy output is unchanged.
    let NO_WEAPON = false;
    function rect(a, b, w, h, c) {
        x.fillStyle = c;
        x.fillRect(Math.round(a), Math.round(b), w, h)
    }
    const HERO_NAMES = ['NOAH', 'MARKIE', 'DESTINY', 'ESPIRIT'];
    const HERO_COLORS = ['#637bff', '#e8a14b', '#e45d76', '#5cce8a']; // V19 order (NOAH, MARKIE, DESTINY, ESPIRIT)
    const ARENA_NAMES = ['MOONLIT TEMPLE', 'EMBER FORTRESS', 'SPIRIT SANCTUARY', 'CELESTIAL VOID'];
    const art = {};

    function ensureArt() {
        if (art.NOAH) return;
        for (const n of HERO_NAMES) art[n] = [makeHDArt(n, 0), makeHDArt(n, 1)]
    }

    // ---- Art themes (multiplayer only; V19 never passes entity.theme, so legacy output is unchanged) ----
    // 'sheet' matches Noah's official hero sheets: Noah purple/blue robes, Destiny gold armor + red cape,
    // Markie fur mantle + headband, Espirit unchanged (green leather + bow already match).
    // Recolors swap exact V19 palette entries; overlays add small details in HD-art pixels (96x128).
    const THEMES = {
        sheet: {
            recolor: {
                NOAH: { '#3b58ba': '#4b3aa8', '#273d91': '#35277e', '#213a8b': '#2f2373', '#597ce2': '#7a5fe0', '#5577d8': '#6a52d0' },
                DESTINY: { '#d9d5df': '#e2b54c', '#e6e4e4': '#f0cd68', '#b6aab5': '#b98a35', '#8f2c48': '#b3243a', '#e15465': '#e8404e' },
                MARKIE: { '#bcb5a8': '#8b6a48', '#e4d5bd': '#b8946a' },
                ESPIRIT: {}
            },
            overlay: {
                MARKIE(g) { // blue headband with knot tails (hero sheet 2)
                    g.fillStyle = '#3a4a9a';
                    g.fillRect(30, 30, 40, 4);
                    g.fillRect(68, 32, 8, 3);
                    g.fillRect(72, 35, 4, 7);
                    g.fillStyle = '#7d92e0';
                    g.fillRect(30, 30, 40, 1)
                }
            },
            gear: { markiePauldron: '#8b6a48', destinyBanner: true }
        }
    };
    const themedArt = {};
    const hex = (r, g, b) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

    function makeThemedArt(name, frame, themeName) {
        const theme = THEMES[themeName];
        const c = makeHDArt(name, frame);
        if (!theme) return c;
        const g = c.getContext('2d');
        const map = (theme.recolor && theme.recolor[name]) || {};
        if (Object.keys(map).length) {
            const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
            const parsed = {};
            for (const k in map) parsed[k] = [parseInt(map[k].slice(1, 3), 16), parseInt(map[k].slice(3, 5), 16), parseInt(map[k].slice(5, 7), 16)];
            for (let i = 0; i < d.length; i += 4) {
                if (!d[i + 3]) continue;
                const to = parsed[hex(d[i], d[i + 1], d[i + 2])];
                if (to) { d[i] = to[0]; d[i + 1] = to[1]; d[i + 2] = to[2] }
            }
            g.putImageData(img, 0, 0);
        }
        if (theme.overlay && theme.overlay[name]) theme.overlay[name](g);
        return c;
    }

    function artSetFor(entity) {
        const th = entity && entity.theme;
        if (!th || !THEMES[th]) return art;
        if (!themedArt[th]) {
            themedArt[th] = {};
            for (const n of HERO_NAMES) themedArt[th][n] = [makeThemedArt(n, 0, th), makeThemedArt(n, 1, th)];
        }
        return themedArt[th];
    }

    function makeArt(name, frame = 0) {
        let c = document.createElement('canvas');
        c.width = 48;
        c.height = 64;
        let g = c.getContext('2d');
        g.imageSmoothingEnabled = false;
        const r = (x, y, w, h, col) => {
                g.fillStyle = col;
                g.fillRect(x, y, w, h)
            },
            poly = (pts, col) => {
                g.fillStyle = col;
                g.beginPath();
                g.moveTo(...pts[0]);
                pts.slice(1).forEach(q => g.lineTo(...q));
                g.closePath();
                g.fill()
            };
        const ink = '#161529',
            metal = '#d9d5df',
            gold = '#f5c65d',
            skin = '#e8aa7f',
            shade = '#a9675b',
            hair = '#1c1829',
            blue = '#3b58ba',
            red = '#9f334c',
            green = '#356e4b';
        const step = frame % 2;
        // cape silhouettes and boot silhouettes
        if (name === 'NOAH') {
            poly([
                [17, 24],
                [10, 25],
                [2, 51],
                [13, 49],
                [17, 55],
                [28, 50],
                [38, 56],
                [34, 27]
            ], '#213a8b');
            poly([
                [13, 29],
                [7, 48],
                [17, 45],
                [18, 33]
            ], '#597ce2')
        }
        if (name === 'DESTINY') {
            poly([
                [12, 22],
                [4, 30],
                [1, 55],
                [18, 47],
                [33, 56],
                [41, 30]
            ], '#8f2c48');
            poly([
                [9, 30],
                [4, 51],
                [16, 43]
            ], '#e15465')
        }
        if (name === 'MARKIE') {
            poly([
                [10, 22],
                [3, 35],
                [5, 55],
                [17, 49],
                [34, 54],
                [40, 30]
            ], '#272334')
        }
        if (name === 'ESPIRIT') {
            poly([
                [12, 25],
                [4, 45],
                [10, 53],
                [19, 44],
                [36, 53],
                [37, 30]
            ], '#274c39')
        }
        r(14, 47 + step, 9, 13, ink);
        r(25, 47 - step, 9, 13, ink);
        r(13, 57 + step, 12, 5, '#484052');
        r(25, 57 - step, 12, 5, '#484052');
        // torso and shoulders
        let body = name === 'NOAH' ? blue : name === 'MARKIE' ? '#594554' : name === 'DESTINY' ? metal : green;
        r(13, 26, 22, 24, ink);
        r(15, 27, 18, 21, body);
        r(10, 27, 7, 17, ink);
        r(32, 27, 7, 17, ink);
        if (name === 'MARKIE') {
            r(9, 25, 30, 8, '#bcb5a8');
            r(7, 28, 6, 11, '#e4d5bd');
            r(36, 28, 6, 11, '#e4d5bd');
            r(17, 33, 14, 13, '#3d3444');
            r(19, 39, 10, 4, gold);
            r(16, 48, 17, 4, '#aa7d55')
        }
        if (name === 'NOAH') {
            r(12, 26, 25, 5, '#d6a64b');
            r(19, 29, 11, 16, '#273d91');
            r(22, 30, 4, 13, '#83b8ff');
            r(14, 46, 20, 4, gold);
            r(9, 31, 4, 13, '#5577d8')
        }
        if (name === 'DESTINY') {
            r(10, 27, 29, 7, gold);
            r(16, 34, 17, 12, '#e6e4e4');
            r(22, 34, 5, 11, gold);
            r(13, 46, 23, 5, '#b58b49');
            r(10, 32, 5, 12, '#b6aab5');
            r(34, 32, 5, 12, '#b6aab5')
        }
        if (name === 'ESPIRIT') {
            r(12, 26, 25, 5, '#9ca66b');
            r(18, 30, 14, 16, '#365a3c');
            r(21, 33, 7, 10, '#6c9d58');
            r(15, 46, 20, 4, '#ad8456');
            r(35, 24, 4, 23, '#7d573a');
            for (let i = 0; i < 4; i++) r(36 + i % 2, 25 + i * 4, 2, 8, gold)
        }
        // neck and distinctive head silhouettes
        r(20, 23, 9, 7, shade);
        r(16, 10, 18, 17, ink);
        r(18, 12, 14, 15, skin);
        r(17, 18, 3, 6, shade);
        r(31, 18, 3, 6, shade);
        r(20, 20, 3, 2, ink);
        r(27, 20, 3, 2, ink);
        r(23, 24, 5, 2, shade);
        if (name === 'NOAH') {
            r(16, 9, 19, 6, hair);
            r(19, 6, 5, 5, hair);
            r(25, 4, 5, 8, hair);
            r(31, 8, 5, 8, hair);
            r(15, 13, 5, 5, hair);
            r(19, 28, 11, 3, gold)
        }
        if (name === 'MARKIE') {
            r(15, 10, 20, 6, hair);
            r(14, 11, 23, 4, '#292537');
            r(13, 14, 22, 3, '#383647');
            r(30, 12, 10, 4, '#282638');
            r(36, 15, 6, 3, '#22202e');
            r(32, 21, 2, 2, metal)
        }
        if (name === 'DESTINY') {
            r(15, 8, 19, 8, hair);
            r(14, 12, 4, 15, hair);
            r(30, 12, 6, 17, hair);
            r(25, 4, 8, 7, hair);
            r(31, 5, 5, 5, hair);
            r(18, 27, 15, 4, gold)
        }
        if (name === 'ESPIRIT') {
            r(14, 9, 21, 7, '#3b2529');
            r(14, 14, 4, 22, '#3b2529');
            r(32, 14, 5, 27, '#55342c');
            r(36, 21, 5, 19, '#764533');
            r(20, 10, 13, 3, '#6c3c30')
        }
        // hands, gauntlets and weapons (large recognizable silhouettes)
        r(7, 35, 7, 11, ink);
        r(8, 36, 5, 9, body);
        if (!NO_WEAPON) {
            r(36, 35, 7, 11, ink);
            r(37, 36, 5, 9, body);
        }
        r(8, 43, 7, 6, skin);
        if (!NO_WEAPON) r(37, 43, 7, 6, skin);
        if (NO_WEAPON) return c;
        if (name === 'NOAH') {
            r(39, 17, 3, 33, '#e9efff');
            r(38, 11, 5, 8, '#8fcaff');
            r(36, 16, 9, 4, '#6cafff');
            r(37, 49, 7, 4, gold);
            r(5, 34, 4, 4, '#a9e6ff');
            r(2, 30, 4, 4, '#7bcaff');
            r(6, 26, 4, 4, '#d8f4ff')
        }
        if (name === 'MARKIE') {
            r(38, 8, 4, 42, '#87674f');
            r(33, 9, 13, 8, '#dad6cf');
            r(30, 13, 17, 9, '#a5a4ad');
            r(31, 16, 5, 4, '#f6d16e');
            r(37, 46, 7, 6, '#554254')
        }
        if (name === 'DESTINY') {
            r(40, 13, 3, 41, '#ded9c9');
            r(37, 11, 9, 4, gold);
            r(40, 7, 3, 5, gold);
            r(5, 39, 3, 20, '#e4e8f2');
            r(3, 37, 7, 4, gold);
            r(5, 58, 3, 4, '#e4e8f2')
        }
        if (name === 'ESPIRIT') {
            r(39, 16, 3, 35, gold);
            r(36, 13, 5, 5, gold);
            r(36, 48, 5, 5, gold);
            r(43, 16, 1, 35, '#f4e2ad');
            r(24, 37, 21, 2, '#f5d477');
            r(43, 34, 5, 5, gold)
        }
        return c
    }
    // High-detail 96x128 source sprites: 4x the source pixels, same on-screen height.
    // 32-bit-era-inspired lighting, cloth textures, layered armor and unique silhouettes.
    function makeHDArt(name, frame) {
        const base = makeArt(name, frame),
            c = document.createElement('canvas');
        c.width = 96;
        c.height = 128;
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = false;
        g.drawImage(base, 0, 0, 96, 128);
        const r = (a, b, w, h, col) => {
            g.fillStyle = col;
            g.fillRect(a, b, w, h)
        };
        const line = (pts, color, width = 2) => {
            g.strokeStyle = color;
            g.lineWidth = width;
            g.beginPath();
            g.moveTo(...pts[0]);
            for (const p of pts.slice(1)) g.lineTo(...p);
            g.stroke()
        };
        const gold = '#ffe39c',
            shadow = '#171b34';
        // Animated boots, belt buckles and fine metallic edges.
        r(27, 114 + frame * 2, 18, 3, '#90849e');
        r(52, 114 - frame * 2, 18, 3, '#90849e');
        r(30, 95, 12, 2, '#b4a9bd');
        r(56, 95, 12, 2, '#b4a9bd');
        r(37, 92, 23, 3, shadow);
        r(43, 91, 10, 5, gold);
        r(46, 92, 4, 3, '#fff4c6');
        // Face is now 28 pixels wide; features have room for highlights.
        r(37, 33, 5, 3, '#241e30');
        r(55, 33, 5, 3, '#241e30');
        r(39, 34, 2, 1, '#faf4ec');
        r(56, 34, 2, 1, '#faf4ec');
        r(46, 41, 4, 2, '#c07d65');
        r(44, 47, 9, 2, '#9f5c5a');
        r(39, 29, 15, 2, '#ffd2a0');
        r(33, 52, 5, 8, '#f3b48a');
        if (!NO_WEAPON) r(61, 52, 5, 8, '#f3b48a');
        if (name === 'NOAH') {
            // Royal blue mantle, luminous runes and crystalline sword.
            line([
                [22, 54],
                [14, 79],
                [8, 105]
            ], '#6d9bff', 3);
            line([
                [74, 54],
                [82, 78],
                [87, 108]
            ], '#244aaf', 4);
            r(35, 57, 27, 4, '#d6b870');
            r(44, 62, 8, 26, '#90c5ff');
            r(46, 66, 4, 20, '#d7f5ff');
            for (let i = 0; i < 4; i++) {
                r(27 + i * 10, 70 + (i % 2) * 6, 3, 5, '#9ce6ff');
                r(30 + i * 9, 86, 3, 3, '#5f8fff')
            }
            if (!NO_WEAPON) {
                line([
                    [79, 97],
                    [82, 52],
                    [84, 18]
                ], '#a6eaff', 6);
                line([
                    [84, 18],
                    [88, 9],
                    [90, 18]
                ], '#e4ffff', 3);
                r(76, 62, 16, 4, '#d8ba68');
                r(83, 58, 3, 36, '#ecf9ff');
            }
            r(32, 18, 6, 5, '#28365d');
            r(47, 8, 8, 4, '#1b1c34');
            r(61, 14, 7, 4, '#17172d');
        } else if (name === 'MARKIE') {
            // Reinforced plated shoulders, chain mail, double-headed battle axe.
            r(14, 54, 18, 10, '#8d8793');
            r(16, 55, 15, 3, '#e6d8c8');
            r(64, 54, 18, 10, '#8d8793');
            r(66, 55, 15, 3, '#e6d8c8');
            for (let j = 0; j < 4; j++) {
                r(17 + j * 4, 66, 2, 3, '#d8c7a7');
                r(66 + j * 4, 66, 2, 3, '#d8c7a7')
            }
            r(39, 66, 19, 17, '#4a3d53');
            for (let j = 0; j < 4; j++) line([
                [40, 69 + j * 4],
                [57, 69 + j * 4]
            ], '#82718d', 1);
            if (!NO_WEAPON) {
                r(73, 17, 6, 80, '#8e624a');
                r(75, 22, 2, 66, '#d6a76a');
                line([
                    [64, 20],
                    [88, 13],
                    [94, 26],
                    [83, 39],
                    [65, 36]
                ], '#e9e0d5', 5);
                line([
                    [68, 25],
                    [84, 20],
                    [89, 26],
                    [79, 32]
                ], '#7e889e', 3);
            }
            r(23, 25, 8, 3, '#33303b');
            r(29, 20, 40, 4, '#292733');
            r(65, 24, 16, 4, '#1b1b2b');
        } else if (name === 'DESTINY') {
            // Filigree on white-gold captain plate, ornate sword and red cloak.
            line([
                [18, 59],
                [9, 85],
                [4, 112]
            ], '#f26e72', 4);
            line([
                [79, 59],
                [87, 88],
                [91, 115]
            ], '#9f304e', 4);
            r(31, 58, 35, 7, '#e9c66c');
            r(36, 66, 26, 22, '#f2f0ed');
            line([
                [38, 68],
                [48, 75],
                [58, 68]
            ], '#bd904c', 3);
            r(46, 73, 5, 12, '#e6bf60');
            for (let j = 0; j < 3; j++) {
                r(32 + j * 12, 85, 6, 3, '#f1d18a');
                r(34 + j * 12, 89, 4, 2, '#fff6d4')
            }
            if (!NO_WEAPON) {
                r(75, 24, 4, 80, '#f7f2dd');
                r(74, 25, 6, 5, '#fff8e9');
                r(69, 40, 17, 4, '#ffdc81');
            }
            r(32, 19, 31, 4, '#d6b66c');
            r(46, 13, 6, 7, '#ffedac');
            r(37, 24, 5, 3, '#fff0b9');
        } else {
            // Forest hunter with leather straps, feathered quiver, engraved bow.
            line([
                [23, 57],
                [14, 77],
                [11, 107]
            ], '#82b97d', 3);
            line([
                [72, 55],
                [84, 81],
                [87, 111]
            ], '#183f30', 4);
            r(38, 58, 22, 30, '#385f43');
            line([
                [37, 61],
                [60, 85]
            ], '#b48a56', 5);
            for (let j = 0; j < 5; j++) {
                r(40 + j * 4, 77, 2, 3, '#90b47a');
                r(33 + j * 6, 89, 3, 2, '#c4a26b')
            }
            r(72, 46, 10, 43, '#79563e');
            for (let j = 0; j < 4; j++) {
                r(72 + j * 3, 43 - j * 4, 3, 11, j % 2 ? '#e9d487' : '#d3b0a5')
            }
            if (!NO_WEAPON) {
                g.strokeStyle = '#f3ce76';
                g.lineWidth = 4;
                g.beginPath();
                g.arc(78, 70, 32, -1.35, 1.35);
                g.stroke();
                line([
                    [84, 39],
                    [84, 100]
                ], '#f6ead0', 2);
                line([
                    [47, 75],
                    [93, 75]
                ], '#ffe29a', 3);
            }
            r(30, 19, 6, 8, '#4d322d');
            r(65, 22, 6, 28, '#724735');
        }
        // V19 high-resolution engraved armor, buckles, fabric seams and face accents.
        const gem = (cx, cy, light, dark) => {
            r(cx - 3, cy - 2, 7, 7, dark);
            r(cx - 1, cy - 1, 3, 4, light);
            r(cx, cy - 2, 1, 2, '#fffbe6')
        };
        const stud = (cx, cy) => {
            r(cx, cy, 3, 3, '#3c3242');
            r(cx + 1, cy, 1, 1, '#fff0bd')
        };
        for (let j = 0; j < 4; j++) {
            stud(28 + j * 12, 96);
            r(27 + j * 12, 105, 9, 2, '#7f778c')
        }
        r(37, 37, 3, 2, '#a56658');
        r(57, 37, 3, 2, '#a56658');
        r(41, 52, 15, 2, '#f5cba5');
        r(42, 55, 13, 1, '#b06f65');
        if (name === 'NOAH') {
            gem(48, 69, '#c9ffff', '#3965b8');
            for (let j = 0; j < 5; j++) {
                r(18 + j * 2, 65 + j * 6, 2, 4, '#8bbaff');
                r(72 + j * 2, 64 + j * 6, 2, 4, '#6b96ee')
            }
            r(43, 11, 3, 3, '#4a4779');
            r(58, 17, 5, 2, '#4d4270');
            if (!NO_WEAPON) for (let j = 0; j < 4; j++) r(76, 27 + j * 9, 2, 4, '#d6fbff');
        } else if (name === 'MARKIE') {
            gem(48, 78, '#ffd47e', '#644353');
            for (let j = 0; j < 4; j++) {
                r(16 + j * 4, 59, 2, 2, '#fff0d5');
                r(66 + j * 4, 59, 2, 2, '#fff0d5')
            }
            for (let j = 0; j < 6; j++) {
                r(38 + j * 4, 87, 2, 2, '#9c8b9c');
                r(40 + j * 4, 90, 2, 2, '#62536e')
            }
            r(32, 30, 4, 2, '#b9a7a4');
        } else if (name === 'DESTINY') {
            gem(49, 69, '#baffdc', '#b88a52');
            for (let j = 0; j < 5; j++) {
                r(35 + j * 6, 60, 3, 2, '#fff3cb');
                r(35 + j * 6, 86, 3, 2, '#c99c59')
            }
            r(27, 53, 5, 4, '#fce5a7');
            r(65, 53, 5, 4, '#fce5a7');
            for (let j = 0; j < 4; j++) r(8 + j * 3, 84 + j * 7, 2, 4, '#ff9b9c');
        } else {
            gem(48, 74, '#d6f7a5', '#375b42');
            for (let j = 0; j < 5; j++) {
                r(20 + j * 3, 61 + j * 5, 2, 3, '#c8a274');
                r(64 + j * 3, 62 + j * 6, 2, 3, '#739c65')
            }
            for (let j = 0; j < 4; j++) r(74 + j * 3, 47 + j * 7, 2, 4, '#f6d9a0');
            r(30, 26, 3, 5, '#9c6850');
            r(64, 30, 3, 7, '#a06d52');
        }
        // Per-pixel shading creates a richer late-arcade-era silhouette without blur.
        g.globalAlpha = .16;
        for (let y = 53; y < 113; y += 7) {
            r(30, y, 35, 1, '#fff4d7')
        };
        g.globalAlpha = 1;
        return c;
    }

    function sprite(px, py, color, enemy = false, name = 'NOAH', now = 0, entity = null) {
        if (enemy) {
            let e = arguments[6] || {};
            x.save();
            if (e.hurt) {
                px += Math.sin(now / 34) * Math.min(5, e.hurt * .5)
            }
            // Evil armored swordsman: horned helmet, crimson visor, pauldrons and short blade.
            rect(px - 13, py + 1, 11, 20, '#151321');
            rect(px + 3, py + 1, 11, 20, '#151321');
            rect(px - 11, py + 14, 10, 6, '#343044');
            rect(px + 3, py + 14, 10, 6, '#343044');
            rect(px - 14, py - 25, 28, 29, '#161421');
            rect(px - 11, py - 23, 22, 23, '#4b3c56');
            rect(px - 8, py - 20, 16, 5, '#8b354d');
            rect(px - 3, py - 13, 6, 12, '#272231');
            rect(px - 21, py - 24, 11, 12, '#61526a');
            rect(px + 10, py - 24, 11, 12, '#61526a');
            rect(px - 22, py - 13, 8, 20, '#332c42');
            rect(px + 14, py - 13, 8, 20, '#332c42');
            rect(px - 12, py - 42, 24, 20, '#17141f');
            rect(px - 10, py - 39, 20, 14, '#494054');
            rect(px - 15, py - 45, 6, 12, '#30273b');
            rect(px + 9, py - 45, 6, 12, '#30273b');
            rect(px - 17, py - 48, 5, 8, '#7a596a');
            rect(px + 12, py - 48, 5, 8, '#7a596a');
            rect(px - 8, py - 34, 16, 5, '#190d1a');
            rect(px - 7, py - 33, 5, 3, '#ff3d65');
            rect(px + 2, py - 33, 5, 3, '#ff3d65');
            // Short sword held in the enemy's right hand.
            let swordSide = e.facing || -1;
            let sx = px + swordSide * 23;
            rect(sx - 2, py - 17, 4, 15, '#765348');
            rect(sx - 8, py - 20, 16, 4, '#c28b61');
            rect(sx - 3, py - 43, 6, 23, '#b8c0d0');
            rect(sx - 1, py - 46, 2, 25, '#f1e9e4');
            rect(sx - 2, py - 49, 4, 6, '#e2d7d5');
            if (e.flash > 0) {
                x.globalAlpha = .45;
                rect(px - 23, py - 48, 46, 68, '#fff1c5')
            }
            x.restore();
            return
        }

        const tier = (entity?.upgradeTier || 0);
        const gear = (entity && entity.theme && THEMES[entity.theme] && THEMES[entity.theme].gear) || {};
        if (tier > 0) {
            x.save();
            x.globalAlpha = .13 + Math.min(.20, tier * .06);
            x.fillStyle = tier >= 3 ? '#ffce65' : tier >= 2 ? '#c899ff' : color;
            x.beginPath();
            x.ellipse(px, py - 33, 30 + tier * 5, 45 + tier * 4, 0, 0, Math.PI * 2);
            x.fill();
            x.restore();
            for (let k = 0; k < Math.min(8, tier * 3); k++) {
                const a = now * .0015 + k * 6.283 / Math.min(8, tier * 3);
                rect(px + Math.cos(a) * (23 + tier * 3), py - 35 + Math.sin(a) * (28 + tier * 2), 3, 3, tier >= 3 ? '#ffe58c' : color);
            }
        }
        const moving = (entity?.moving || false),
            attacking = now < (entity?.attackPoseUntil || 0),
            casting = now < (entity?.castPoseUntil || 0);
        const A = artSetFor(entity); // theme-aware art (V19: no theme -> original art)
        let s = A[name]?.[moving ? Math.floor(now / 110) % 2 : 0] || A.NOAH[0];
        // Hero sprites are now close to enemy scale (64px tall vs ~60px enemies).
        const scale = 1.05,
            w = 48 * scale,
            h = 64 * scale; // HD sprite is 96x128 internally; same gameplay scale
        x.fillStyle = '#17142688';
        x.beginPath();
        x.ellipse(Math.round(px), Math.round(py + 3), 17, 5, 0, 0, Math.PI * 2);
        x.fill();
        x.save();
        x.translate(Math.round(px), Math.round(py - h));
        if ((entity || {})?.facing === -1) x.scale(-1, 1);
        const stride = moving ? Math.sin(now / 85) * 2.8 : Math.sin(now / 450) * .7;
        x.translate(0, stride);
        if (attacking) x.rotate(-.10 + Math.sin((entity.attackPoseUntil - now) / 155 * Math.PI) * .16);
        if (casting) {
            x.shadowColor = color;
            x.shadowBlur = 18;
            x.translate(0, -3)
        }
        x.drawImage(s, -w / 2, 0, w, h);
        if (tier >= 1) {
            rect(-w / 2 + 3, 22, 9, 5, '#ffe3a1');
            rect(w / 2 - 12, 22, 9, 5, '#ffe3a1')
        }
        if (tier >= 2) {
            rect(-5, 5, 10, 4, '#fff1b5');
            rect(-3, 1, 6, 4, '#b7a3ff')
        }
        if (tier >= 3) {
            rect(-9, -3, 18, 4, '#ffce72');
            rect(-6, -7, 4, 5, '#ffce72');
            rect(2, -7, 4, 5, '#ffce72')
        }
        x.restore();
        if (name !== 'ENEMY') {
            const t = entity?.upgradeTier || 0,
                dir = (entity || {})?.facing || 1;
            x.save();
            x.translate(px, py - 32);
            x.scale(dir, 1);
            // Distinctive gear is visible at actual gameplay scale.
            if (name === 'NOAH') {
                x.shadowColor = '#67d8ff';
                x.shadowBlur = 8 + t * 4;
                rect(20, -25, 3, 38, '#c2f5ff');
                rect(18, -30, 7, 11, '#65c6ff');
                rect(19, -33, 5, 6, '#e7ffff');
                rect(-12, -36, 5, 5, '#ffdb72');
                if (t >= 2) {
                    rect(-17, -39, 7, 4, '#8fdfff');
                    rect(8, -39, 7, 4, '#8fdfff')
                }
            } else if (name === 'MARKIE') {
                const pauldron = t >= 1 ? '#edb965' : (gear.markiePauldron || '#9b8a81');
                rect(-24, -25, 15, 10, pauldron);
                rect(9, -25, 15, 10, pauldron);
                rect(19, -8, 5, 31, '#66483c');
                rect(13, -30, 19, 18, t >= 2 ? '#ffba55' : '#d2d6dc');
                rect(19, -32, 14, 4, '#fff0b2');
                if (t >= 3) {
                    rect(-26, -32, 8, 9, '#ffca61');
                    rect(19, -32, 8, 9, '#ffca61')
                }
            } else if (name === 'DESTINY') {
                rect(-20, -24, 10, 7, t >= 1 ? '#ffda79' : '#f5f1e4');
                rect(10, -24, 10, 7, t >= 1 ? '#ffda79' : '#f5f1e4');
                rect(19, -20, 3, 35, '#f2e9ce');
                if (gear.destinyBanner) { // captain's banner with a gold emblem (hero sheet)
                    rect(22, -19, 15, 11, '#b3243a');
                    rect(22, -8, 5, 4, '#b3243a');
                    rect(32, -8, 5, 4, '#b3243a');
                    rect(27, -16, 5, 5, '#f5c65d')
                }
                rect(16, -25, 9, 9, '#ffe19a');
                rect(-7, -32, 14, 4, '#ffda80');
                if (t >= 2) {
                    x.strokeStyle = '#9bffc6';
                    x.lineWidth = 2;
                    x.beginPath();
                    x.arc(0, 1, 29, 0, Math.PI * 2);
                    x.stroke()
                }
            } else if (name === 'ESPIRIT') {
                x.strokeStyle = t >= 2 ? '#ffed9b' : '#d9ad61';
                x.lineWidth = 3;
                x.beginPath();
                x.arc(22, -5, 22, -1.3, 1.3);
                x.stroke();
                rect(20, -7, 27 + t * 3, 3, '#fff1ad');
                rect(-19, -34, 8, 6, '#8fbf7b');
                rect(8, -34, 8, 6, '#8fbf7b');
            }
            x.restore();
            if (t >= 2) {
                x.save();
                x.globalAlpha = .35;
                x.strokeStyle = entity?.color || '#ffe49a';
                x.lineWidth = 2;
                x.beginPath();
                x.ellipse(px, py + 2, 25 + t * 4, 8 + t * 2, 0, 0, Math.PI * 2);
                x.stroke();
                x.restore()
            }
        }
    }

    function drawArena(now, zoneIndex) {
        const t = now * .001;
        const zone = ((Math.floor(zoneIndex) || 0) % 4 + 4) % 4;
        const palettes = [
            ['#08172a', '#18394c', '#142c39', '#274a5a', '#152b39', '#303d46', '#c6ece0'],
            ['#261018', '#6d2634', '#5d2730', '#8d3442', '#431a2c', '#5a3239', '#ffae68'],
            ['#0b2533', '#175b5b', '#154c58', '#2e7770', '#173e50', '#294e57', '#a4fff2'],
            ['#1b1437', '#43316d', '#2e2855', '#584c91', '#29254b', '#393458', '#dbbbff']
        ];
        const pal = palettes[zone];
        x.save();
        x.scale(1.5, 1.5);

        const sky = x.createLinearGradient(0, 0, 0, 540);
        sky.addColorStop(0, pal[0]);
        sky.addColorStop(.54, pal[1]);
        sky.addColorStop(1, pal[2]);
        x.fillStyle = sky;
        x.fillRect(0, 0, 960, 540);
        // Moon and parallax mountain silhouettes.
        x.save();
        x.shadowColor = '#9cdbd6';
        x.shadowBlur = 38;
        x.fillStyle = pal[6];
        x.beginPath();
        x.arc(786, 92, 45, 0, Math.PI * 2);
        x.fill();
        x.restore();
        x.fillStyle = pal[3];
        x.beginPath();
        x.moveTo(0, 250);
        for (let i = 0; i <= 12; i++) x.lineTo(i * 90, 160 + Math.sin(i * 2.5) * 42);
        x.lineTo(960, 310);
        x.lineTo(0, 310);
        x.fill();
        x.fillStyle = pal[4];
        x.beginPath();
        x.moveTo(0, 318);
        for (let i = 0; i <= 14; i++) x.lineTo(i * 74, 220 + Math.sin(i * 2.1 + 1) * 38);
        x.lineTo(960, 370);
        x.lineTo(0, 370);
        x.fill();
        // Mountain temple walls and lantern towers.
        rect(0, 232, 960, 308, '#26313b');
        for (let i = 0; i < 12; i++) {
            rect(i * 92 - 8, 235, 7, 305, '#39434c');
            rect(i * 92 + 34, 235, 5, 305, '#202c38')
        }
        rect(0, 230, 960, 15, '#55616a');
        rect(0, 245, 960, 7, '#151f2c');
        // Ancient torii and tiled rooftops.
        rect(385, 115, 190, 14, '#1a1e2a');
        rect(400, 130, 16, 137, '#292432');
        rect(544, 130, 16, 137, '#292432');
        rect(367, 104, 225, 13, '#553a40');
        rect(422, 91, 116, 15, '#553a40');
        rect(462, 79, 36, 14, '#553a40');
        for (const lx of [96, 864]) {
            rect(lx - 8, 175, 16, 92, '#39414b');
            rect(lx - 21, 163, 42, 15, '#b66c55');
            rect(lx - 17, 154, 34, 8, '#ffe6a5');
            rect(lx - 13, 170, 26, 20, '#eaa76d');
        }
        // Stone floor, perspective seams and geometric inlays.
        rect(0, 268, 960, 272, pal[5]);
        for (let j = 0; j < 6; j++) {
            let y = 273 + j * 48;
            rect(0, y, 960, 3, j % 2 ? '#53616a' : '#202e3b');
        }
        for (let j = 0; j < 7; j++)
            for (let i = 0; i < 9; i++) {
                let xx = i * 125 + (j % 2) * 62;
                rect(xx, 277 + j * 42, 3, 38, '#26333e')
            }
        x.save();
        x.globalAlpha = .23;
        x.strokeStyle = '#8cb3b2';
        x.lineWidth = 3;
        for (const r of [84, 116, 148]) {
            x.beginPath();
            x.ellipse(480, 405, r, r * .32, 0, 0, Math.PI * 2);
            x.stroke()
        }
        x.beginPath();
        x.moveTo(720, 400);
        x.lineTo(480, 500);
        x.moveTo(300, 405);
        x.lineTo(660, 405);
        x.stroke();
        x.restore();
        // Embers and fireflies, all deterministic and low-cost.
        for (let i = 0; i < 23; i++) {
            let xx = (i * 137 + Math.sin(t * .8 + i) * 17 + 960) % 960,
                yy = 280 + ((i * 71 - t * 17) % 255 + 255) % 255;
            x.globalAlpha = .25 + .3 * (.5 + .5 * Math.sin(t * 2 + i));
            rect(xx, yy, 3, 3, i % 3 ? '#c5e9ba' : '#ffd18b')
        }
        x.globalAlpha = 1;
        // Unique landmarks and weather after each defeated boss.
        if (zone === 1) { // Ember fortress
            for (let i = 0; i < 13; i++) {
                let px = 25 + i * 77,
                    py = 310 + Math.sin(i * 2) * 18;
                x.globalAlpha = .45 + .35 * Math.sin(t * 3 + i);
                rect(px, py - 32, 7, 26, '#fba355');
                rect(px + 2, py - 43, 3, 15, '#ffdb85')
            }
            x.globalAlpha = 1;
        } else if (zone === 2) { // Verdant spirit ruins
            for (let i = 0; i < 10; i++) {
                let px = 45 + i * 100;
                rect(px, 243, 9, 40, '#1a5149');
                rect(px - 7, 235, 23, 12, '#4eb79b');
                x.globalAlpha = .55;
                rect(px - 5, 230, 19, 5, '#9fffd4');
                x.globalAlpha = 1
            }
        } else if (zone === 3) { // Celestial void
            for (let i = 0; i < 25; i++) {
                let px = (i * 173) % 960,
                    py = 65 + (i * 71) % 205;
                x.globalAlpha = .5 + .4 * Math.sin(t + i);
                rect(px, py, 3 + (i % 3), 3 + (i % 3), '#e5cbff')
            }
            x.globalAlpha = 1;
        }
        x.restore();
    }

    // Weapon-less HD art (theme-aware) for the multiplayer pose layer: body only, weapon arm drawn separately.
    const poseArt = {};
    function makePoseArt(name, frame, themeName) {
        const key = name + frame + (themeName || '');
        if (poseArt[key]) return poseArt[key];
        NO_WEAPON = true;
        try { poseArt[key] = themeName ? makeThemedArt(name, frame, themeName) : makeHDArt(name, frame) } finally { NO_WEAPON = false }
        return poseArt[key];
    }

    function drawSprite(ctx, px, py, color, enemy, name, now, entity) {
        ensureArt();
        x = ctx;
        try {
            sprite(px, py, color, !!enemy, name || 'NOAH', now || 0, entity || null)
        } finally {
            x = null
        }
    }

    function drawArenaOn(ctx, now, zone) {
        x = ctx;
        try {
            drawArena(now || 0, zone || 0)
        } finally {
            x = null
        }
    }
    const api = {
        HERO_NAMES,
        HERO_COLORS,
        ARENA_NAMES,
        makeArt,
        makeHDArt,
        ensureArt,
        THEMES,
        makeThemedArt,
        makePoseArt,
        drawSprite,
        drawArena: drawArenaOn,
        WORLD_SCALE: 1.5, // V19 art is tuned for a 1440x810 canvas; arena() draws a 960x540 scene scaled x1.5
    };
    root.WCHRender = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);