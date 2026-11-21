'use strict';
// LEVEL UP every 10th wave + Espirit's doubled reach.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/combat.js');
const R = C.RULES;

// Fast-forward to the end of wave n: put the world in "fighting" with nothing left so the next step clears it.
function clearWave(w, n) { w.wave = n; w.waveState = 'fighting'; w.toSpawn = 0; w.enemies = []; C.step(w); return w.events }

test('clearing wave 10 levels up every living hero (human and AI), applies stats and fully heals', () => {
    const w = C.createBattle({ seed: 1, firstWaveDelayMs: 1e9 });
    w.heroes[0].ai = false; w.heroes[1].ai = false; // 2 humans + 2 AI
    const before = w.heroes.map(h => ({ maxHp: h.maxHp, damage: h.damage, speed: h.speed, crit: C.critChance(h, w) }));
    w.heroes.forEach(h => { h.hp = 5 });
    for (const n of [1, 5, 9]) { const ev = clearWave(w, n); assert.ok(!ev.some(e => e.t === 'lvl'), 'no level-up at wave ' + n) }
    assert.ok(w.heroes.every(h => h.level === 1));
    const ev = clearWave(w, 10);
    const lvl = ev.find(e => e.t === 'lvl');
    assert.ok(lvl, 'lvl event');
    assert.deepEqual(lvl.all, [0, 1, 2, 3]);
    w.heroes.forEach((h, i) => {
        assert.equal(h.level, 2, h.name);
        assert.equal(h.maxHp, Math.round(before[i].maxHp * 1.12));
        assert.equal(h.damage, Math.round(before[i].damage * 1.10));
        assert.ok(Math.abs(h.speed - before[i].speed * 1.03) < 1e-9);
        assert.ok(Math.abs(C.critChance(h, w) - (before[i].crit + 0.02)) < 1e-9);
        assert.equal(h.hp, h.maxHp, 'full heal');
        assert.equal(C.snapshot(w).heroes[i].lv, 2);
    });
    assert.ok(w.heroes.filter(h => h.ai).every(h => h.level === 2), 'AI teammates level up too');
});

test('wave 20 levels up again (Lv 3); downed heroes miss it; levels are not re-applied mid-wave', () => {
    const w = C.createBattle({ seed: 2, firstWaveDelayMs: 1e9 });
    clearWave(w, 10);
    const d = w.heroes[2]; d.state = 'downed'; d.hp = 0;
    for (let n = 11; n < 20; n++) clearWave(w, n);
    assert.ok(w.heroes.every(h => h.level === 2));
    const ev = clearWave(w, 20);
    assert.deepEqual(ev.find(e => e.t === 'lvl').all, [0, 1, 3]);
    assert.equal(w.heroes[0].level, 3); assert.equal(d.level, 2, 'downed hero missed it');
    assert.equal(w.heroes[0].maxHp, Math.round(w.heroes[0].base.hp * (1 + 0.12 * 2)));
    assert.equal(C.moveSpeed(w, w.heroes[0]), w.heroes[0].base.speed * 1.06, 'snapshot speed carries the level bonus (prediction parity)');
    assert.equal(C.snapshot(w).heroes[0].spd, C.moveSpeed(w, w.heroes[0]));
    const ev30 = clearWave(w, 30); assert.ok(ev30.some(e => e.t === 'lvl'));
    assert.equal(w.heroes[0].level, 4);
});

test('Espirit reaches about twice as far as V19 (546 units)', () => {
    const w = C.createBattle({ seed: 3, firstWaveDelayMs: 1e9 });
    const es = w.heroes[3];
    assert.ok(Math.abs(es.range - 410 / 1.5 * 2) < 1e-9);
    for (const h of w.heroes) h.ai = false;
    es.x = 100; es.y = 300; es.aim = 0; es.facing = 1;
    w.heroes.forEach((h, i) => { if (i !== 3) { h.x = 100; h.y = 100 + i * 10 } });
    const e = C.spawnEnemy(w, 0); e.x = 100 + 500; e.y = 300; e.entered = true; e.hp = e.max = 1e6; e.stunUntil = 1e12;
    es.wantAttack = true; C.step(w);
    assert.ok(w.events.some(v => v.t === 'hit' && v.h === 3), 'hit at 500 units');
});
