'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/combat.js');

test('ultimate activates a server-owned awakening timer for each hero', () => {
    for (let i = 0; i < 4; i++) {
        const w = C.createBattle({ seed: 123, firstWaveDelayMs: 1e9 });
        w.heroes.forEach(h => { h.ai = false });
        const h = w.heroes[i];
        h.wantSpecial = true;
        C.step(w);
        assert.equal(h.specialN, 1);
        assert.equal(h.awakenUntil, w.time + 8000);
        assert.ok(C.snapshot(w).heroes[i].awake > 0);
        assert.ok(w.events.some(e => e.t === 'awaken' && e.h === i));
        for (let j = 0; j < 161; j++) C.step(w);
        assert.equal(C.snapshot(w).heroes[i].awake, 0, 'awakening expires after eight seconds');
    }
});

test('awakening damage bonus is applied by the server only during the timer', () => {
    const w = C.createBattle({ seed: 9, firstWaveDelayMs: 1e9 });
    w.heroes.forEach(h => { h.ai = false });
    const h = w.heroes[0];
    const e = C.spawnEnemy(w, 0);
    e.x = h.x + 30; e.y = h.y; e.entered = true; e.hp = e.max = 10000;
    h.awakenUntil = w.time + 8000;
    C.damageEnemy(w, h, e, 100);
    const boosted = 10000 - e.hp;
    assert.ok(boosted >= 125, 'awakened hit has a 25% damage multiplier before crit');
    assert.ok(boosted === 125 || boosted > 125, 'critical strikes may multiply it further');
});
