'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HEROES } = require('../public/js/heroes-config.js');
const { LEVEL_TABLE, levelStats } = require('../shared/levelup-table.js');

test('all selectable heroes have valid progression through level 15', () => {
    for (const hero of HEROES) {
        const rows = LEVEL_TABLE[hero.name];
        assert.ok(rows, hero.name + ' is missing level-up stats');
        assert.equal(rows.length, 15, hero.name + ' needs 15 level rows');
        for (let level = 1; level <= 20; level++) {
            const stats = levelStats(hero.name, level);
            for (const key of ['hp', 'damage', 'speed', 'cool', 'skill', 'crit']) {
                assert.ok(Number.isFinite(stats[key]), hero.name + ' level ' + level + ' has invalid ' + key);
            }
            assert.ok(stats.hp > 0 && stats.cool > 0);
        }
    }
});
test('Smitesh and Dave preserve level-one combat baseline', () => {
    for (const name of ['SMITESH', 'DAVE']) {
        const hero = HEROES.find(h => h.name === name);
        const stats = levelStats(name, 1);
        assert.equal(stats.hp, hero.v19.hp);
        assert.equal(stats.damage, hero.v19.damage);
        assert.equal(stats.cool, hero.v19.cool);
    }
});
