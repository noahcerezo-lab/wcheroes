/*
 * West Coast Heroes — shared hero roster (used by server.js AND the browser).
 *
 * Slot order, classes and colors follow Noah's official hero sheets:
 *   1P NOAH    – Spellblade Mage  (blue/purple robes, arcane magic + sword, high INT, burst damage)
 *   2P DESTINY – Captain Warrior  (red cape, gold armor, sword/banner, leadership & team buffs, balanced)
 *   3P MARKIE  – Rogue-Tank       (fur mantle, blue headband, big axe, high STR/VIT, crowd control, damage soak)
 *   4P ESPIRIT – Hunter           (green leather, bow, long-range crits, high AGI/LUK)
 *
 * stats: STR/AGI/INT/VIT/LUK on a 1–10 scale, measured from the bar fill lengths on Noah's character
 *   sheet (/workspace/wcheroes-assets/sheet-2.png, bar ≈ 149 px; fill/149 × 10, rounded; ±1 because the
 *   bars have glints). Colors follow the sheets (sheet-1/sheet-2).
 * v19: the original single-player combat numbers from legacy-v19.html, kept here as the starting point
 *   for server-side combat (Phase C). Not used by the server yet.
 */
(function (root) {
    'use strict';
    const HEROES = [
        {
            id: 'NOAH', slot: '1P', name: 'NOAH', cls: 'SPELLBLADE MAGE', color: '#5b5fe0', accent: '#a77bff',
            blurb: 'Arcane crescents and a spellblade. Big area magic.',
            stats: { STR: 7, AGI: 4, INT: 8, VIT: 5, LUK: 4 },
            v19: { hp: 110, speed: 3.7, damage: 23, range: 170, cool: 290, special: 'ARCANE NOVA' }
        },
        {
            id: 'DESTINY', slot: '2P', name: 'DESTINY', cls: 'CAPTAIN WARRIOR', color: '#d8434f', accent: '#f5c65d',
            blurb: 'Leads the squad: team buffs, healing aura, stuns.',
            stats: { STR: 10, AGI: 6, INT: 4, VIT: 6, LUK: 4 },
            v19: { hp: 145, speed: 3.4, damage: 28, range: 83, cool: 310, special: 'RALLY STRIKE' }
        },
        {
            id: 'MARKIE', slot: '3P', name: 'MARKIE', cls: 'ROGUE-TANK', color: '#b98149', accent: '#4a5aa8',
            blurb: 'Big axe, soaks damage, controls crowds.',
            stats: { STR: 10, AGI: 4, INT: 2, VIT: 9, LUK: 4 },
            v19: { hp: 190, speed: 2.8, damage: 49, range: 76, cool: 390, special: 'EARTHSHATTER' }
        },
        {
            id: 'ESPIRIT', slot: '4P', name: 'ESPIRIT', cls: 'HUNTER', color: '#6fae4a', accent: '#f5d477',
            blurb: 'Long-range bow, precision critical hits.',
            stats: { STR: 6, AGI: 10, INT: 4, VIT: 5, LUK: 9 },
            v19: { hp: 100, speed: 4.2, damage: 19, range: 410, cool: 180, special: 'ARROW STORM' }
        }
    ];
    const STAT_KEYS = ['STR', 'AGI', 'INT', 'VIT', 'LUK'];
    const api = { HEROES, STAT_KEYS, NAMES: HEROES.map(h => h.name), ART_THEME: 'sheet' };
    root.WCHHeroes = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
