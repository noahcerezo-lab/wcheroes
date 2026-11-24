/*
 * West Coast Heroes — Draper's hero sprite sheets (m-overhaul groups 1-5) for the multiplayer client.
 * Cosmetic only. Loads the sheets, maps an 8-way aim to a sheet direction, and draws one frame
 * nearest-neighbor with the feet at the origin.
 *
 *   group1 Noah attacks: noah_atk_{crescent_slash,reverse_arc,arcane_breaker}_{DIR}_96x128_8f (+ crescent / shards / shockwave FX)
 *   group2 Espirit bow:  espirit_bow_{DIR}_96x128_12f (+ fx_espirit_arrow_glow_80x16_6f)
 *   group3 Markie smash (E only, mirror for W), group4 Destiny gold sweep (E only), group5 idle/run/hurt/stun (E only).
 *
 * Scale: groups 1-2 fill the 96x128 frame (hero ~110 px, feet on row 128); groups 3-5 draw the hero ~75 px
 * with the feet on row 124. Both are scaled so the hero stands ~67 local units tall, like the V19 HD sprite.
 */
(function (root) {
    'use strict';
    const DIRS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE']; // shared-sim DIR8 order: 0 right, 2 down, 4 left, 6 up
    const BASE = 'assets/overhaul/';
    const SC_FULL = 0.61, SC_SMALL = 0.9; // local units per sheet px
    const NOAH_ATK = ['crescent_slash', 'reverse_arc', 'arcane_breaker'];
    const img = {};
    let wanted = 0, loaded = 0;
    // [file, frameW, frameH, frames, feetY, scale]
    const DEF = {};
    function def(key, file, fw, fh, n, feet, sc) { DEF[key] = { file, fw, fh, n, feet, sc } }
    for (const d of DIRS) {
        NOAH_ATK.forEach((a, s) => def('noah' + s + d, 'noah_atk_' + a + '_' + d + '_96x128_8f', 96, 128, 8, 128, SC_FULL));
        def('bow' + d, 'espirit_bow_' + d + '_96x128_12f', 96, 128, 12, 128, SC_FULL);
        def('cres' + d, 'fx_noah_crescent_tapered_' + d + '_96x96_8f', 96, 96, 8, 48, 1);
    }
    for (const h of ['noah', 'destiny', 'markie', 'espirit']) {
        def(h + 'Idle', h + '_idle_e_96x128_6f', 96, 128, 6, 124, SC_SMALL);
        def(h + 'Run', h + '_run_e_96x128_8f', 96, 128, 8, 124, SC_SMALL);
        def(h + 'Hurt', h + '_hurt_e_96x128_4f', 96, 128, 4, 124, SC_SMALL);
        def(h + 'Stun', h + '_stun_e_96x128_4f', 96, 128, 4, 124, SC_SMALL);
    }
    def('markieSmash', 'markie_axe_smash_96x128_10f', 96, 128, 10, 124, SC_SMALL);
    def('destinySweep', 'destiny_gold_sweep_96x128_8f', 96, 128, 8, 124, SC_SMALL);
    def('noahShards', 'fx_noah_shards_48x48_6f', 48, 48, 6, 24, 1);
    def('noahShock', 'fx_noah_shockwave_96x96_8f', 96, 96, 8, 48, 1);
    def('arrowGlow', 'fx_espirit_arrow_glow_80x16_6f', 80, 16, 6, 8, 1);
    def('markieSparks', 'fx_markie_sparks_32x32_6f', 32, 32, 6, 16, 1);
    def('markieCrack', 'fx_markie_groundcrack_64x32_8f', 64, 32, 8, 16, 1);
    def('destinyGuard', 'fx_destiny_defend_heal_64x64_8f', 64, 64, 8, 32, 1);

    function load() {
        if (typeof Image === 'undefined' || wanted) return;
        for (const k in DEF) {
            wanted++;
            const im = new Image();
            im.onload = () => { img[k] = im; loaded++ };
            im.src = BASE + DEF[k].file + '.png';
        }
    }
    const ready = k => !!img[k];
    const dirOf = (aim, facing) => DIRS[Number.isInteger(aim) ? ((aim % 8) + 8) % 8 : (facing === -1 ? 4 : 0)];
    // Draw frame f of sheet k with its anchor (feet, or FX centre) at (0,0). flip mirrors X.
    // scale multiplies the sheet's own scale. silhouette(img, color) -> canvas is optional (outline pass).
    function draw(g, k, f, flip, scale, outline, silhouette) {
        const im = img[k]; if (!im) return false;
        const d = DEF[k], n = d.n, fr = f < 0 ? 0 : f >= n ? n - 1 : f | 0;
        const sc = d.sc * (scale || 1), w = d.fw * sc, h = d.fh * sc, x = -d.fw / 2 * sc, y = -d.feet * sc;
        const wasSmooth = g.imageSmoothingEnabled; g.imageSmoothingEnabled = false;
        if (flip) { g.save(); g.scale(-1, 1) }
        if (outline && silhouette) {
            const s = silhouette(im, outline), o = 1.2;
            g.drawImage(s, fr * d.fw, 0, d.fw, d.fh, x - o, y, w, h); g.drawImage(s, fr * d.fw, 0, d.fw, d.fh, x + o, y, w, h);
            g.drawImage(s, fr * d.fw, 0, d.fw, d.fh, x, y - o, w, h); g.drawImage(s, fr * d.fw, 0, d.fw, d.fh, x, y + o, w, h);
        }
        g.drawImage(im, fr * d.fw, 0, d.fw, d.fh, x, y, w, h);
        if (flip) g.restore();
        g.imageSmoothingEnabled = wasSmooth;
        return true;
    }
    // High-detail concept sheets are default; ?newart=0 restores classic art.
    // A sheet that is missing or still loading never replaces the existing procedural hero.
    // Mastery tiers: 0 = Lv 1-9, 1 = Lv 10-19, 2 = Lv 20-29, 3 = Lv 30+. A tier's art lives in
    // concept-v2/tier{n}/ with the same filenames; manifest.json lists which tiers exist per hero so the
    // client never requests (and 404s on) art that hasn't been made. Missing tiers fall back to the
    // highest available lower tier, ending at the base art.
    const CONCEPT_BASE = 'assets/concept-v2/';
    const CONCEPT_HEROES = ['NOAH', 'DESTINY', 'MARKIE', 'ESPIRIT', 'SMITESH', 'DAVE', 'DONNA'];
    const CONCEPT_DEFAULT = { // used until (or if) manifest.json loads
        feet: 122,
        anims: { idle: { n: 6, fw: 96, fh: 128, ms: 150, loop: true }, run: { n: 8, fw: 96, fh: 128, ms: 85, loop: true },
            attack: { n: 8, fw: 96, fh: 128, ms: 0, loop: false }, special: { n: 8, fw: 96, fh: 128, ms: 70, loop: false },
            hurt: { n: 4, fw: 96, fh: 128, ms: 70, loop: false }, down: { n: 4, fw: 128, fh: 128, ms: 160, loop: false } },
        heroes: {},
    };
    let conceptMeta = CONCEPT_DEFAULT, manifestState = '';
    const CONCEPT_SCALE = .7; // local units per sheet px: a ~95 px tall hero stands ~67 units, like the V19 body
    const conceptImages = Object.create(null);
    const conceptStatus = Object.create(null);
    const conceptEnabled = typeof location === 'undefined' ||
        new URLSearchParams(location.search).get('newart') !== '0';
    const masteryTier = lv => { lv = lv | 0; return lv >= 30 ? 3 : lv >= 20 ? 2 : lv >= 10 ? 1 : 0 };
    // highest tier <= wanted that has art for this hero (always at least 0)
    function artTier(name, lv) {
        const want = masteryTier(lv), h = conceptMeta.heroes[String(name).toLowerCase()];
        const have = h && h.tiers ? h.tiers : [0];
        let best = 0;
        for (const t of have) if (t <= want && t > best) best = t;
        return best;
    }
    function conceptFile(name, action, tier) {
        const A = conceptMeta.anims[action];
        return CONCEPT_BASE + (tier ? 'tier' + tier + '/' : '') + name.toLowerCase() + '_' + action + '_' + A.fw + 'x' + A.fh + '_' + A.n + 'f.png';
    }
    function loadManifest() {
        if (manifestState || typeof fetch === 'undefined') return;
        manifestState = 'loading';
        fetch(CONCEPT_BASE + 'manifest.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).then(m => {
            if (m && m.anims && m.heroes) conceptMeta = m;
            manifestState = 'ready';
        }).catch(() => { manifestState = 'ready' });
    }
    function loadConcept(name, action, tier) {
        if (!conceptEnabled || !CONCEPT_HEROES.includes(name) || !conceptMeta.anims[action]) return;
        const key = name + '_' + action + '_' + (tier | 0);
        if (conceptStatus[key]) return;
        conceptStatus[key] = 'loading';
        const im = new Image();
        im.onload = () => { conceptImages[key] = im; conceptStatus[key] = 'ready' };
        im.onerror = () => { conceptStatus[key] = 'missing' };
        im.src = conceptFile(name, action, tier | 0);
    }
    // Load every pose of one hero (only heroes actually on screen ever get loaded).
    function loadConceptHero(name, lv) {
        if (!conceptEnabled) return;
        loadManifest();
        if (manifestState !== 'ready') return;
        const t = artTier(name, lv);
        for (const action in conceptMeta.anims) loadConcept(name, action, t);
    }
    function loadConceptRoster(names) {
        if (!conceptEnabled) return;
        for (const name of names || CONCEPT_HEROES) loadConceptHero(name, 1);
    }
    // Frame for an action given ms since it started. Looping actions wrap; one-shots hold the last frame.
    // durMs (optional) stretches a one-shot over that time, e.g. the hero's real attack length.
    function conceptFrame(action, ms, durMs) {
        const A = conceptMeta.anims[action]; if (!A) return 0;
        const fd = durMs ? durMs / A.n : A.ms || 70;
        const f = Math.floor(Math.max(0, ms) / fd);
        return A.loop ? f % A.n : Math.min(A.n - 1, f);
    }
    // Draw one frame with the feet at (0,0). Nearest-neighbour, cached Image, no per-frame processing.
    function drawConcept(g, name, action, frame, flip, look, lv) {
        if (!conceptEnabled) return false;
        loadConceptHero(name, lv);
        const tier = artTier(name, lv);
        let im = conceptImages[name + '_' + action + '_' + tier];
        if (!im && tier) im = conceptImages[name + '_' + action + '_0'];   // tier art still loading
        if (!im) return false;
        const A = conceptMeta.anims[action], n = A.n, f = ((frame % n) + n) % n;
        const sc = CONCEPT_SCALE, wasSmooth = g.imageSmoothingEnabled;
        g.imageSmoothingEnabled = false;
        g.save();
        if (flip) g.scale(-1, 1);
        // look.fx dims only attack/ability FX for allies; hero bodies always draw fully opaque
        // (like the classic renderer). Real state fades (downed) are set by the caller's globalAlpha.
        g.drawImage(im, f * A.fw, 0, A.fw, A.fh, -A.fw / 2 * sc, -(conceptMeta.feet || 122) * sc, A.fw * sc, A.fh * sc);
        g.restore();
        g.imageSmoothingEnabled = wasSmooth;
        return true;
    }
    const conceptReady = (name, action, lv) => !!conceptImages[name + '_' + action + '_' + artTier(name, lv)] || !!conceptImages[name + '_' + action + '_0'];
    root.WCHSheets = { load, ready, draw, dirOf, DIRS, DEF, img: k => img[k],
        progress: () => ({ wanted, loaded }), loadConceptRoster, loadConceptHero, drawConcept, conceptReady,
        conceptFrame, masteryTier, artTier, conceptEnabled, conceptStatus, conceptMeta: () => conceptMeta };

})(typeof window !== 'undefined' ? window : globalThis);
