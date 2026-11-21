'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/combat.js');

test('boss encounters replace ordinary waves at 10, 20 and 30', () => {
    for (const n of [10, 20, 30]) {
        const w = C.createBattle({ seed: 42, firstWaveDelayMs: 1e9 });
        w.heroes.forEach(h => { h.ai = false });
        w.wave = n - 1;
        w.waveState = 'intermission';
        w.nextWaveAt = 0;
        C.step(w);
        assert.equal(w.wave, n);
        assert.equal(w.bossWave, true);
        assert.equal(w.toSpawn, 1);
        assert.ok(w.events.some(e => e.t === 'wave' && e.boss === 1));
        C.step(w);
        assert.equal(w.toSpawn, 0);
        assert.equal(w.enemies.length, 1);
        assert.equal(w.enemies[0].type, C.ENEMY_INDEX.voidEmperor);
        assert.equal(C.snapshot(w).boss.name, 'VOID EMPEROR');
    }
});

test('boss telegraphs a server-authoritative slam and awards a level only after defeat', () => {
    const w = C.createBattle({ seed: 3, firstWaveDelayMs: 1e9 });
    w.heroes.forEach(h => { h.ai = false });
    w.wave = 9; w.waveState = 'intermission'; w.nextWaveAt = 0;
    C.step(w); C.step(w);
    const boss = w.enemies[0];
    assert.equal(w.heroes[0].level, 1);
    boss.entered = true;
    boss.x = w.heroes[0].x + 10; boss.y = w.heroes[0].y;
    boss.at = -1e9;
    while (w.time < boss.entranceUntil) C.step(w);
    C.step(w);
    assert.ok(boss.windUntil > w.time, 'boss telegraphs before damage');
    const hp = w.heroes[0].hp;
    assert.equal(w.heroes[0].hp, hp);
    while (w.time < boss.windUntil) C.step(w);
    assert.ok(w.events.some(e => e.t === 'slam'), 'server resolves the slam');
    assert.ok(w.heroes[0].hp < hp, 'hero takes damage if still inside the warning ring');
    boss.hp = 1;
    C.damageEnemy(w, w.heroes[0], boss, 999999);
    C.step(w);
    assert.equal(w.waveState, 'intermission');
    assert.equal(w.heroes[0].level, 2, 'victory awards the existing tenth-wave level-up');
    assert.equal(C.snapshot(w).boss, null);
});

test('boss locks a targeted smash position and allows heroes to dodge before impact', () => {
    const w = C.createBattle({ seed: 8, firstWaveDelayMs: 1e9 });
    w.heroes.forEach(h => { h.ai = false });
    w.wave = 9; w.waveState = 'intermission'; w.nextWaveAt = 0;
    C.step(w); C.step(w);
    const boss = w.enemies[0];
    boss.entranceUntil = 0; boss.entered = true;
    boss.x = w.heroes[0].x + 70; boss.y = w.heroes[0].y;
    boss.at = -1e9; boss.attackCount = 1; // next attack is targeted smash
    C.step(w);
    const warning = w.events.find(e => e.t === 'boss:target');
    assert.ok(warning, 'targeted smash warning emitted');
    const original = { x: warning.x, y: warning.y };
    w.heroes[0].x = original.x + 130;
    w.heroes[0].y = original.y;
    const hp = w.heroes[0].hp;
    while (w.time < boss.windUntil) C.step(w);
    assert.ok(w.events.some(e => e.t === 'slam' && e.x === original.x && e.y === original.y));
    assert.equal(w.heroes[0].hp, hp, 'hero who dodges locked position is unharmed');
});
