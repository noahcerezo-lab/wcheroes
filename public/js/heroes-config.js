/*
 * West Coast Heroes — shared hero roster (used by server.js AND the browser).
 *
 * Slot order, classes and colors follow Noah's official hero sheets:
 *   1P NOAH    – Spellblade Mage  (blue/purple robes, arcane magic + sword, high INT, burst damage)
 *   2P DESTINY – Captain Warrior  (red cape, gold armor, sword/banner, leadership & team buffs, balanced)
 *   3P MARKIE  – Rogue-Tank       (fur mantle, blue headband, big axe, high STR/VIT, crowd control, damage soak)
 *   4P ESPIRIT – Hunter           (green leather, bow, long-range crits, high AGI/LUK)
 *
 * fill: STR/AGI/INT/VIT/LUK bar fill fractions (0–1) from Oracle's measured asset pack
 *   (/workspace/wcheroes-assets/heroes.json + README "Stats": mid-band of each bar on sheet-2, ignoring the
 *   gold whiskers on empty tracks). The lobby draws these bars as-is.
 * stats: the same values on a 1–10 scale (round(fill × 10)) for gameplay: LUK -> crit chance, VIT -> damage
 *   taken (shared/combat.js). Colors follow the sheets (sheet-1/sheet-2).
 * cls: Noah uses sheet-1's 'Spellblade-Mage' spelling (Oracle README "Class names").
 * v19: the original single-player combat numbers from legacy-v19.html; shared/combat.js converts them to
 *   server units (Phase C).
 */
(function (root) {
    'use strict';
    const HEROES = [
        {
            id: 'NOAH', slot: '1P', name: 'NOAH', cls: 'SPELLBLADE-MAGE', color: '#5b5fe0', accent: '#a77bff',
            blurb: 'Arcane crescents and a spellblade. Big area magic.',
            fill: { STR: .61, AGI: .25, INT: .79, VIT: .51, LUK: .41 },
            v19: { hp: 110, speed: 3.7, damage: 23, range: 170, cool: 290, special: 'ARCANE NOVA' }
        },
        {
            id: 'DESTINY', slot: '2P', name: 'DESTINY', cls: 'CAPTAIN WARRIOR', color: '#d8434f', accent: '#f5c65d',
            blurb: 'Leads the squad: team buffs, healing aura, stuns.',
            fill: { STR: 1, AGI: .61, INT: .41, VIT: .61, LUK: .41 },
            v19: { hp: 145, speed: 3.4, damage: 28, range: 83, cool: 310, special: 'RALLY STRIKE' }
        },
        {
            id: 'MARKIE', slot: '3P', name: 'MARKIE', cls: 'ROGUE-TANK', color: '#b98149', accent: '#4a5aa8',
            blurb: 'Big axe, soaks damage, controls crowds.',
            fill: { STR: 1, AGI: .41, INT: .25, VIT: .91, LUK: .40 },
            v19: { hp: 190, speed: 2.8, damage: 49, range: 76, cool: 390, special: 'EARTHSHATTER' }
        },
        {
            id: 'ESPIRIT', slot: '4P', name: 'ESPIRIT', cls: 'HUNTER', color: '#6fae4a', accent: '#f5d477',
            blurb: 'Long-range bow, precision critical hits.',
            fill: { STR: .62, AGI: .92, INT: .42, VIT: .42, LUK: .91 },
            v19: { hp: 100, speed: 4.2, damage: 19, range: 410, cool: 180, special: 'ARROW STORM' }
        },
        {
            id: 'SMITESH', slot: '5TH', name: 'SMITESH', cls: 'SPIRIT SHAMAN',
            color: '#40bfae', accent: '#bda2ff',
            blurb: 'Spirit bolts, ancestral healing, and a restorative spirit totem.',
            fill: { STR: .25, AGI: .56, INT: .95, VIT: .48, LUK: .62 },
            v19: { hp: 115, speed: 3.5, damage: 21, range: 330, cool: 300, special: 'SPIRIT TOTEM' }
        }
    ];
    const STAT_KEYS = ['STR', 'AGI', 'INT', 'VIT', 'LUK'];
    for (const h of HEROES) h.stats = Object.fromEntries(STAT_KEYS.map(k => [k, Math.max(1, Math.round(h.fill[k] * 10))]));
    const api = { HEROES, STAT_KEYS, NAMES: HEROES.map(h => h.name), ART_THEME: 'sheet' };
    root.WCHHeroes = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
