'use strict';
// Deterministic unit tests for shared/combat.js (no server, no network). Same seed -> same fight.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/combat.js');
const SIM = require('../public/js/shared-sim.js');
const A = SIM.ARENA;

// A quiet battle: no waves start, crits off, all heroes human-controlled (no AI) unless asked.
function quiet(opts = {}) {
    const w = C.createBattle({ seed: 42, firstWaveDelayMs: 1e9, ...opts });
    for (const h of w.heroes) { h.ai = false; h.stats = { ...h.stats, LUK: 0 } }
    return w;
}
const step = (w, n = 1) => { for (let i = 0; i < n; i++) C.step(w) };
function place(w, i, x, y, facing = 1) { const h = w.heroes[i]; h.x = x; h.y = y; h.facing = facing; return h }
function enemyAt(w, x, y, type = 0) { const e = C.spawnEnemy(w, type); e.x = x; e.y = y; e.entered = true; e.hp = e.max = 1000; e.stunUntil = 1e12; return e }
function spread(w) { place(w, 0, 100, 120); place(w, 1, 860, 120); place(w, 2, 100, 500); place(w, 3, 860, 500) }

test('basic attack: damage, frontal arc, cooldown enforced by the server clock', () => {
    const w = quiet(); spread(w);
    const noah = place(w, 0, 300, 300, 1);
    const front = enemyAt(w, 360, 300), behind = enemyAt(w, 240, 300);
    noah.wantAttack = true; step(w);
    assert.equal(front.hp, 1000 - 23, 'NOAH crescent hits in front for V19 damage 23');
    assert.equal(behind.hp, 1000, 'nothing behind him is hit');
    assert.equal(noah.attackN, 1);
    noah.wantAttack = true; step(w); // 50 ms later: still on the 290 ms cooldown
    assert.equal(noah.attackN, 1, 'second swing refused during cooldown');
    step(w, 5); noah.wantAttack = true; step(w);
    assert.equal(noah.attackN, 2, 'allowed again after 290 ms');
});

test('Markie cleave hits all around, harder in front; Espirit hits only the nearest in her lane', () => {
    const w = quiet(); spread(w);
    const m = place(w, 2, 400, 300, 1);
    const f = enemyAt(w, 430, 300), b = enemyAt(w, 370, 300);
    m.wantAttack = true; step(w);
    assert.equal(1000 - f.hp, Math.max(1, Math.round(Math.round(49 * 1.5)))); // front bonus x1.5
    assert.equal(1000 - b.hp, Math.round(49 * 0.7), 'behind x0.7');
    const w2 = quiet(); spread(w2);
    const es = place(w2, 3, 300, 300, 1);
    const near = enemyAt(w2, 450, 300), far = enemyAt(w2, 520, 300), off = enemyAt(w2, 450, 420);
    es.wantAttack = true; step(w2);
    assert.equal(near.hp, 1000 - 19);
    assert.equal(far.hp, 1000, 'single arrow');
    assert.equal(off.hp, 1000, 'out of the narrow lane');
});

test('specials: 6.5 s cooldown, area damage, Destiny heals + buffs allies, Markie taunts + shields', () => {
    const w = quiet(); spread(w);
    const d = place(w, 1, 400, 300), ally = place(w, 0, 430, 300);
    ally.hp = 50;
    const e = enemyAt(w, 450, 330);
    d.wantSpecial = true; step(w);
    assert.equal(e.hp, 1000 - 28 * 3, 'RALLY STRIKE x3');
    assert.ok(ally.hp >= 50 + 35, 'heals nearby ally 35');
    assert.ok(ally.buffUntil > w.time, 'damage buff');
    assert.ok(e.stunUntil > w.time, 'stun');
    d.wantSpecial = true; step(w, 20);
    assert.equal(d.specialN, 1, 'cooldown');
    step(w, 120); d.wantSpecial = true; step(w);
    assert.equal(d.specialN, 2, 'ready after 6.5 s');
    const w2 = quiet(); spread(w2);
    const m = place(w2, 2, 400, 300), victim = enemyAt(w2, 450, 300);
    m.wantSpecial = true; step(w2);
    assert.equal(victim.tauntBy, 2, 'taunted onto Markie');
    const hp = m.hp; C.damageHero(w2, m, 20, victim);
    assert.ok(hp - m.hp <= Math.round(20 * 0.45 * C.damageTakenMul(m.stats)) + 1, 'shield soaks damage');
});

test('crits come from LUK and are deterministic for a seed', () => {
    const run = () => {
        const w = C.createBattle({ seed: 7, firstWaveDelayMs: 1e9 }); for (const h of w.heroes) h.ai = false;
        spread(w); const es = place(w, 3, 300, 300, 1); const e = enemyAt(w, 400, 300);
        let crits = 0;
        for (let i = 0; i < 400; i++) { es.wantAttack = true; C.step(w); crits += w.events.filter(v => v.t === 'hit' && v.c).length; e.hp = 1000; e.x = 400; e.y = 300; e.kx = e.ky = 0 }
        return crits;
    };
    const a = run(), b = run();
    assert.equal(a, b, 'same seed, same crits');
    assert.ok(a > 20 && a < 100, 'Espirit crits ~36% of ' + 400 * 50 / 180 + ' shots (' + a + ')');
});

test('downed: hp 0 downs a hero, downed heroes cannot act, a nearby teammate revives them', () => {
    const w = quiet(); spread(w);
    const n = place(w, 0, 300, 300), d = place(w, 1, 700, 300);
    C.damageHero(w, n, 9999, null);
    assert.equal(n.state, 'downed');
    assert.ok(w.events.some(e => e.t === 'down' && e.h === 0));
    const e = enemyAt(w, 330, 300);
    n.wantAttack = true; step(w);
    assert.equal(e.hp, 1000, 'downed hero cannot attack');
    step(w, 60);
    assert.equal(n.state, 'downed', 'no revive without a teammate nearby');
    place(w, 1, 320, 300);
    step(w, 39);
    assert.equal(n.state, 'downed', 'revive takes 2 s');
    step(w, 2);
    assert.equal(n.state, 'alive');
    assert.equal(n.hp, Math.round(n.maxHp * 0.4), 'back at 40% hp');
    void d;
});

test('team wipe ends the battle', () => {
    const w = quiet();
    for (const h of w.heroes) C.damageHero(w, h, 9999, null);
    step(w);
    assert.equal(w.over, true);
    assert.ok(w.events.some(e => e.t === 'over'));
    assert.equal(C.snapshot(w).over, 1);
});

test('enemies spawn off-screen, walk in, and never leave the arena once inside', () => {
    const w = C.createBattle({ seed: 3, firstWaveDelayMs: 0 });
    let entered = 0, spawnedOutside = 0;
    const seen = new Set();
    for (let i = 0; i < 20 * 240 && !w.over; i++) {
        C.step(w);
        for (const e of w.enemies) {
            if (!seen.has(e.id)) { seen.add(e.id); if (e.x < A.minX || e.x > A.maxX || e.y < A.minY || e.y > A.maxY) spawnedOutside++ }
            if (e.entered) { entered++; assert.ok(e.x >= A.minX && e.x <= A.maxX && e.y >= A.minY && e.y <= A.maxY, 'enemy ' + e.id + ' inside') }
            if (e.entered && i % 7 === 0 && e.id % 3 === 0) { e.kx = (i % 2 ? 1 : -1) * 400; e.ky = 400 } // absurd knockback must still be clamped
        }
        assert.ok(w.enemies.length <= w.maxEnemies, 'enemy cap');
    }
    assert.ok(seen.size > 20 && spawnedOutside === seen.size, 'all ' + seen.size + ' enemies spawned off-screen');
    assert.ok(entered > 0);
});

test('waves advance after a clear, harder enemy types unlock, every 15th wave is flagged for a Phase D boss', () => {
    const w = C.createBattle({ seed: 11, firstWaveDelayMs: 0 });
    const waves = [], clears = [], types = new Set();
    for (let i = 0; i < 20 * 600 && w.wave < 6 && !w.over; i++) {
        C.step(w);
        for (const e of w.events) { if (e.t === 'wave') waves.push(e.n); if (e.t === 'clear') clears.push(e.n) }
        for (const e of w.enemies) types.add(C.ENEMY_TYPES[e.type].key);
    }
    assert.deepEqual(waves.slice(0, 5), [1, 2, 3, 4, 5]);
    assert.deepEqual(clears.slice(0, 4), [1, 2, 3, 4]);
    assert.ok(types.has('acolyte') && types.has('wisp'), [...types].join());
    assert.equal(C.waveSize(1), 8);
    assert.equal(C.isBossWave(15), true);
    assert.equal(C.isBossWave(14), false);
});

test('AI teammates fight on their own and the same seed replays the same battle', () => {
    const run = () => { const w = C.createBattle({ seed: 5, firstWaveDelayMs: 0 }); for (let i = 0; i < 20 * 90; i++) C.step(w); return w };
    const a = run(), b = run();
    assert.ok(a.kills > 10, 'AI squad scored kills (' + a.kills + ')');
    assert.ok(a.heroes.every(h => h.attackN > 0), 'every AI hero attacked');
    assert.deepEqual(C.snapshot(a), C.snapshot(b));
});

test('ranged enemies fire dodgeable projectiles; melee strikes can be dodged during the windup', () => {
    const w = quiet(); spread(w);
    const h = place(w, 0, 300, 300);
    const archer = C.spawnEnemy(w, C.ENEMY_INDEX.archer); archer.x = 440; archer.y = 300; archer.entered = true;
    let shot = false;
    for (let i = 0; i < 40 && !shot; i++) { C.step(w); shot = w.shots.length > 0 }
    assert.ok(shot, 'archer fired');
    const hp = h.hp;
    for (let i = 0; i < 30; i++) C.step(w);
    assert.ok(h.hp < hp, 'standing still: hit by the arrow');
    const w2 = quiet(); spread(w2);
    const me = place(w2, 0, 300, 300), ac = C.spawnEnemy(w2, 0); ac.x = 318; ac.y = 300; ac.entered = true;
    C.step(w2); // acolyte starts its windup
    assert.ok(ac.windUntil > 0, 'telegraph');
    me.x = 200; // step away
    for (let i = 0; i < 4; i++) C.step(w2);
    assert.equal(me.hp, me.maxHp, 'dodged');
});
