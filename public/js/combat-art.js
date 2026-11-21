/*
 * West Coast Heroes — combat sprite sheets (Draper's art pack, /workspace/wcheroes-design).
 *
 * Sheets are transparent PNG strips: frames left-to-right, no padding (README "How the sheets are
 * packed"). They are drawn with imageSmoothingEnabled = false (crisp pixels). World radii from the
 * game rules win over a sheet's native pixel size (combat-vfx.md "Playback rules" 3), and floor
 * effects (rings, cracks, downed/revive, telegraphs) are never X-flipped (rule 2).
 *
 * Enemy art only has idle loops so far; walk / windup / strike / death are procedural in mp-arena.js.
 */
(function (root) {
    'use strict';
    const BASE = 'assets/combat/';
    // key: [file, frameW, frameH, frames, msPerFrame, anchorY (0..1 of frame height = floor/feet line)]
    const SHEETS = {
        noahCrescent: ['fx_noah_crescent_48x48_6f.png', 48, 48, 6, 50, .5],
        noahNova: ['fx_noah_nova_64x64_8f.png', 64, 64, 8, 70, .5],
        destinySlash: ['fx_destiny_slash_48x48_6f.png', 48, 48, 6, 50, .5],
        destinyRally: ['fx_destiny_rally_64x64_8f.png', 64, 64, 8, 70, .5],
        markieCleave: ['fx_markie_cleave_64x64_6f.png', 64, 64, 6, 50, .5],
        markieQuake: ['fx_markie_earthshatter_64x64_8f.png', 64, 64, 8, 70, .56],
        espiritArrow: ['fx_espirit_arrow_48x16_4f.png', 48, 16, 4, 60, .5],
        espiritCrit: ['fx_espirit_crit_32x32_5f.png', 32, 32, 5, 40, .5],
        espiritStorm: ['fx_espirit_storm_64x64_8f.png', 64, 64, 8, 70, .75],
        hitSpark: ['fx_hit_spark_16x16_5f.png', 16, 16, 5, 45, .5],
        critFlash: ['fx_crit_flash_32x32_5f.png', 32, 32, 5, 40, .5],
        healAura: ['fx_heal_aura_48x48_6f.png', 48, 48, 6, 90, .7],
        buffAura: ['fx_buff_aura_32x32_6f.png', 32, 32, 6, 110, .5],
        stunStar: ['fx_stun_star_24x24_4f.png', 24, 24, 4, 120, .5],
        tauntMark: ['fx_taunt_mark_24x24_4f.png', 24, 24, 4, 120, .5],
        downedRing: ['fx_downed_ring_64x32_4f.png', 64, 32, 4, 160, .5],
        reviveRing: ['fx_revive_ring_64x32_8f.png', 64, 32, 8, 80, .5],
        comboBurst: ['fx_combo_burst_48x24_5f.png', 48, 24, 5, 70, .5],
        warning: ['fx_boss_warning_64x32_6f.png', 64, 32, 6, 90, .5],
        impact: ['fx_boss_impact_64x32_6f.png', 64, 32, 6, 70, .5],
        acolyte: ['enemy_horned_acolyte_48x64_4f.png', 48, 64, 4, 180, 1],
        wisp: ['enemy_lantern_wisp_32x48_4f.png', 32, 48, 4, 150, 1],
        archer: ['enemy_tomoe_archer_48x64_4f.png', 48, 64, 4, 190, 1],
        warden: ['enemy_temple_warden_64x80_4f.png', 64, 80, 4, 230, 1],
        voidEmperor: ['boss_void_emperor_96x128_4f.png', 96, 128, 4, 220, 1], // Phase D boss
    };
    const images = {};
    let loaded = 0;
    function load() {
        if (typeof Image === 'undefined') return;
        for (const [key, def] of Object.entries(SHEETS)) {
            if (images[key]) continue;
            const img = new Image();
            img.onload = () => { loaded++ };
            img.src = BASE + def[0];
            images[key] = img;
        }
    }
    const ready = key => { const i = images[key]; return !!(i && i.complete && i.naturalWidth) };
    const frameCount = key => SHEETS[key][3];
    const duration = key => SHEETS[key][3] * SHEETS[key][4];

    // Draw frame `f` of `key` with its anchor at (x, y). `w` is the on-screen width (height keeps the
    // pixel aspect unless `h` is given). flip mirrors on X (sprites face right in the source).
    function frame(g, key, f, x, y, w, h, flip, alpha) {
        if (!ready(key)) return false;
        const [, fw, fh, n, , ay] = SHEETS[key];
        f = Math.max(0, Math.min(n - 1, f | 0));
        h = h || w * fh / fw;
        g.save();
        g.imageSmoothingEnabled = false;
        if (alpha !== undefined) g.globalAlpha *= alpha;
        g.translate(Math.round(x), Math.round(y));
        if (flip) g.scale(-1, 1);
        g.drawImage(images[key], f * fw, 0, fw, fh, Math.round(-w / 2), Math.round(-h * ay), Math.round(w), Math.round(h));
        g.restore();
        return true;
    }
    // One-shot: frame from elapsed time; returns false when finished.
    function play(g, key, elapsed, x, y, w, h, flip, alpha) {
        const [, , , n, ms] = SHEETS[key];
        const f = Math.floor(elapsed / ms);
        if (f >= n) return false;
        frame(g, key, f, x, y, w, h, flip, alpha);
        return true;
    }
    // Looping animation from a clock.
    function loop(g, key, now, x, y, w, h, flip, alpha, phase = 0) {
        const [, , , n, ms] = SHEETS[key];
        return frame(g, key, Math.floor((now + phase) / ms) % n, x, y, w, h, flip, alpha);
    }

    // Combat-sim enemy type index (shared/combat.js ENEMY_TYPES) -> Draper sprite + on-screen width.
    const ENEMY_ART = [
        { key: 'acolyte', w: 50 }, // 0 acolyte: melee grunt, ~64px tall like V19's swordsman
        { key: 'wisp', w: 36 }, // 1 wisp: ranged ember lantern (hovers)
        { key: 'archer', w: 50 }, // 2 archer: mid-range arrows
        { key: 'warden', w: 74 }, // 3 warden: heavy ground slam
    ];
    load();
    root.WCHCombatArt = { SHEETS, ENEMY_ART, load, ready, frame, play, loop, frameCount, duration, loadedCount: () => loaded };
})(typeof window !== 'undefined' ? window : globalThis);
