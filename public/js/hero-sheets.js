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
    // High-detail concept sheets, opt-in while art QA is underway.
    // A missing image never replaces the existing procedural hero.
    const CONCEPT_BASE = 'assets/concept-v2/';
    const CONCEPT_HEROES = new Set(['NOAH','DESTINY','MARKIE','ESPIRIT','SMITESH','DAVE','DONNA']);
    const CONCEPT_ANIMS = {idle:6,run:8,attack:8,special:8,hurt:4,down:4};
    const conceptImages = Object.create(null);
    const conceptStatus = Object.create(null);
    const conceptEnabled = typeof location !== 'undefined' &&
        new URLSearchParams(location.search).get('newart') === '1';
    function loadConcept(name,action) {
        if(!conceptEnabled || !CONCEPT_HEROES.has(name) || !CONCEPT_ANIMS[action])return;
        const key=name+'_'+action;
        if(conceptStatus[key])return;
        conceptStatus[key]='loading';
        const im=new Image();
        im.onload=()=>{conceptImages[key]=im;conceptStatus[key]='ready'};
        im.onerror=()=>{conceptStatus[key]='missing'};
        im.src=CONCEPT_BASE+name.toLowerCase()+'_'+action+'_96x128_'+CONCEPT_ANIMS[action]+'f.png';
    }
    function loadConceptRoster() {
        if(!conceptEnabled)return;
        // Only preload the three gameplay poses. Other poses load on demand.
        for(const name of CONCEPT_HEROES)
            for(const action of ['idle','run','attack'])loadConcept(name,action);
    }
    function drawConcept(g,name,action,frame,flip,look) {
        if(!conceptEnabled)return false;
        const key=name+'_'+action,im=conceptImages[key];
        if(!im){loadConcept(name,action);return false}
        const n=CONCEPT_ANIMS[action],f=((frame%n)+n)%n;
        // Same feet anchor and ~70-local-unit body height as the existing hero.
        const sc=.64,wasSmooth=g.imageSmoothingEnabled;
        g.imageSmoothingEnabled=false;
        g.save();
        if(flip)g.scale(-1,1);
        if(look&&look.fx!==undefined)g.globalAlpha*=look.fx;
        g.drawImage(im,f*96,0,96,128,-48*sc,-120*sc,96*sc,128*sc);
        g.restore();
        g.imageSmoothingEnabled=wasSmooth;
        return true;
    }
    root.WCHSheets = { load, ready, draw, dirOf, DIRS, DEF, img: k => img[k],
        progress: () => ({ wanted, loaded }), loadConceptRoster, drawConcept,
        conceptEnabled, conceptStatus };

})(typeof window !== 'undefined' ? window : globalThis);
