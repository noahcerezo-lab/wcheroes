'use strict';
// Power-ups, SQUAD SYNERGY and HASTE prediction parity (shared/combat.js + public/js/shared-sim.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/combat.js');
const SIM = require('../public/js/shared-sim.js');
const R = C.RULES;

// A battle in wave 1 with no enemies coming, heroes parked in the corners, humans by default.
function arena({ seed = 3, ai = false } = {}) {
    const w = C.createBattle({ seed, firstWaveDelayMs: 1e9 });
    for (const h of w.heroes) h.ai = ai;
    w.wave = 1; w.waveState = 'fighting'; w.toSpawn = 0; w.enemies = [{ id: 999, type: 0, x: -500, y: -500, hp: 1, max: 1, entered: false, stunUntil: 1e12, windUntil: 0, kx: 0, ky: 0, facing: 1, atkAt: 1e12 }];
    const c = [[40, 90], [920, 90], [40, 510], [920, 510]];
    w.heroes.forEach((h, i) => { h.x = c[i][0]; h.y = c[i][1] });
    return w;
}
const kindIdx = k => C.PICKUP_KINDS.indexOf(k);
function give(w, i, kind) { // put a pickup under hero i and let the server collect it
    const h = w.heroes[i];
    w.pickups.push({ id: w.nextPickupId++, kind: kindIdx(kind), x: h.x, y: h.y, at: w.time, until: w.time + 15000 });
    C.step(w);
    return w.events;
}

test('pickups spawn every 10-17 s (server RNG), inside the arena, max 2 on the field, expire after 15 s', () => {
    const gaps = [];
    for (const seed of [1, 2, 3, 4, 5]) {
        const w = arena({ seed });
        let last = 0;
        for (let i = 0; i < 20 * 120; i++) {
            C.step(w);
            for (const e of w.events) if (e.t === 'pspawn') {
                gaps.push(w.time - last); last = w.time;
                assert.ok(e.x >= SIM.ARENA.minX && e.x <= SIM.ARENA.maxX && e.y >= SIM.ARENA.minY && e.y <= SIM.ARENA.maxY, 'inside arena');
                assert.ok(e.k >= 0 && e.k < 4);
            }
            assert.ok(w.pickups.length <= R.pickupMax);
            for (const p of w.pickups) assert.ok(w.time < p.until, 'expired pickups are removed');
        }
    }
    // gaps between spawns are 10-17 s (a gap can be longer only when 2 were already on the field)
    assert.ok(gaps.length > 20, 'spawned ' + gaps.length);
    const first = gaps.filter(g => g <= 17050);
    assert.ok(gaps.every(g => g >= 10000), 'min gap ' + Math.min(...gaps));
    assert.ok(first.length >= gaps.length * 0.8, 'most gaps within 10-17 s');
    const w = arena(); for (let i = 0; i < 20 * 9; i++) C.step(w);
    assert.equal(w.pickups.length, 0, 'nothing before 10 s');
    const w0 = C.createBattle({ seed: 1, firstWaveDelayMs: 1e9 }); for (let i = 0; i < 20 * 60; i++) C.step(w0);
    assert.equal(w0.pickups.length, 0, 'nothing before the first wave');
});

test('collecting: only a living hero standing on the pickup collects it; snapshots list pickups', () => {
    const w = arena();
    w.pickups.push({ id: 50, kind: 0, x: 480, y: 300, at: 0, until: 1e9 });
    C.step(w);
    assert.equal(C.snapshot(w).pk.length, 1);
    assert.deepEqual(C.snapshot(w).pk[0].slice(0, 4), [50, 0, 480, 300]);
    const h = w.heroes[0]; h.x = 480 + R.pickupRadius + 3; h.y = 300; C.step(w);
    assert.equal(w.pickups.length, 1, 'too far');
    h.state = 'downed'; h.x = 480; C.step(w);
    assert.equal(w.pickups.length, 1, 'downed heroes cannot collect');
    h.state = 'alive'; C.step(w);
    assert.equal(w.pickups.length, 0, 'collected');
    assert.ok(w.events.some(e => e.t === 'pick' && e.id === 50 && e.h === 0));
});

test('HEAL restores 32% of max HP (capped at max)', () => {
    const w = arena(); const h = w.heroes[2];
    h.hp = 10; give(w, 2, 'heal');
    assert.equal(h.hp, 10 + Math.round(h.maxHp * 0.32));
    h.hp = h.maxHp - 5; give(w, 2, 'heal');
    assert.equal(h.hp, h.maxHp);
});

test('FURY raises crit chance for 10.5 s', () => {
    const w = arena(); const h = w.heroes[0];
    assert.equal(C.critChance(h, w), 0.14);
    give(w, 0, 'fury');
    assert.ok(Math.abs(C.critChance(h, w) - 0.39) < 1e-9);
    assert.equal(C.snapshot(w).heroes[0].pu[0], 105);
    let n = 0, c = 0; const e = C.spawnEnemy(w, 0);
    for (let i = 0; i < 5000; i++) { e.hp = 1e6; C.damageEnemy(w, h, e, 10); c += w.events.pop().c; n++ }
    assert.ok(Math.abs(c / n - 0.39) < 0.025, 'fury crit rate ' + c / n);
    for (let i = 0; i < 210; i++) C.step(w);
    assert.equal(C.critChance(h, w), 0.14, 'wears off after 10.5 s');
    assert.equal(C.snapshot(w).heroes[0].pu[0], 0);
});

test('HASTE: +50% move speed and faster attacks for 10.5 s', () => {
    const w = arena(); const h = w.heroes[3];
    const base = h.speed;
    give(w, 3, 'haste');
    assert.equal(C.moveSpeed(w, h), base * 1.5);
    assert.equal(C.snapshot(w).heroes[3].spd, base * 1.5);
    // attacks: count swings in 4 s with and without haste (human attack spam)
    const swings = hasted => {
        const v = arena(); const u = v.heroes[0];
        if (hasted) u.hasteUntil = 1e12;
        const n0 = u.attackN; for (let i = 0; i < 80; i++) { u.wantAttack = true; C.step(v) }
        return u.attackN - n0;
    };
    const slow = swings(false), fast = swings(true);
    assert.ok(fast > slow * 1.3, 'haste swings ' + fast + ' vs ' + slow);
    for (let i = 0; i < 211; i++) C.step(w);
    assert.equal(C.moveSpeed(w, h), base, 'wears off');
});

test('WARD reduces incoming damage for 11 s', () => {
    const w = arena(); const h = w.heroes[1];
    C.damageHero(w, h, 20, null); const plain = h.maxHp - h.hp; h.hp = h.maxHp;
    give(w, 1, 'ward');
    C.damageHero(w, h, 20, null); const warded = h.maxHp - h.hp; h.hp = h.maxHp;
    assert.equal(warded, Math.max(1, Math.round(plain * 0.5)), plain + ' -> ' + warded);
    for (let i = 0; i < 221; i++) C.step(w);
    C.damageHero(w, h, 20, null);
    assert.equal(h.maxHp - h.hp, plain, 'wears off after 11 s');
});

test('SQUAD SYNERGY: with AI teammates, a pickup gives every living hero +12% crit for 6.5 s', () => {
    const w = arena(); w.heroes[1].ai = true; w.heroes[3].ai = true; w.heroes[2].state = 'downed'; w.heroes[2].hp = 0;
    const ev = give(w, 0, 'ward');
    const syn = ev.find(e => e.t === 'syn');
    assert.ok(syn, 'synergy event');
    assert.deepEqual(syn.all, [0, 1, 3], 'living heroes only');
    for (const i of [0, 1, 3]) assert.ok(Math.abs(C.critChance(w.heroes[i], w) - 0.26) < 1e-9);
    assert.equal(C.critChance(w.heroes[2], w), 0.14, 'downed hero left out');
    assert.equal(C.snapshot(w).heroes[1].pu[3], 65);
    for (let i = 0; i < 131; i++) C.step(w);
    assert.equal(C.critChance(w.heroes[1], w), 0.14, 'ends after 6.5 s');
    // stacks with FURY
    const v = arena(); v.heroes[1].ai = true; give(v, 0, 'fury');
    assert.ok(Math.abs(C.critChance(v.heroes[0], v) - 0.51) < 1e-9);
    // all-human squad: no synergy
    const u = arena(); const e2 = give(u, 0, 'heal');
    assert.ok(!e2.some(e => e.t === 'syn'));
    assert.equal(C.critChance(u.heroes[1], u), 0.14);
});

test('HASTE prediction parity: client replay with the snapshot speed lands exactly where the server does', () => {
    const w = arena(); const i = 0, h = w.heroes[i]; h.x = 300; h.y = 300;
    give(w, i, 'haste');
    // client-side copy of mp-client.js prediction: predict with snap.spd, replay pending inputs on each snapshot
    const speedOf = snap => snap.heroes[i].spd;
    let snap = C.snapshot(w);
    const predicted = { x: h.x, y: h.y, facing: h.facing, vx: h.vx, vy: h.vy, aim: h.aim };
    const pending = []; let seq = 0;
    const moves = []; for (let t = 0; t < 60; t++) moves.push(SIM.normalizeMove(Math.cos(t / 7), Math.sin(t / 5)));
    const LAG = 3; // inputs reach the server 3 ticks after they were sent
    const inflight = [];
    for (let t = 0; t < moves.length + LAG + 1; t++) {
        if (t < moves.length) { seq++; pending.push({ seq, move: moves[t] }); inflight.push({ seq, move: moves[t] }); SIM.stepHero(predicted, moves[t], speedOf(snap)) }
        while (inflight.length && inflight[0].seq <= seq - LAG || (t >= moves.length && inflight.length)) { const m = inflight.shift(); SIM.stepHero(h, m.move, C.moveSpeed(w, h)); h.seq = m.seq }
        C.step(w); snap = C.snapshot(w);
        const sh = snap.heroes[i];
        const next = { x: sh.x, y: sh.y, facing: sh.facing, vx: sh.vx, vy: sh.vy, aim: sh.aim };
        for (const p of pending.filter(p => p.seq > sh.seq)) SIM.stepHero(next, p.move, speedOf(snap));
        assert.ok(Math.abs(next.x - predicted.x) < 1e-9 && Math.abs(next.y - predicted.y) < 1e-9, 'tick ' + t + ': replay ' + next.x + ',' + next.y + ' vs predicted ' + predicted.x + ',' + predicted.y);
    }
    assert.equal(predicted.x, h.x); assert.equal(predicted.y, h.y);
    const moved = Math.hypot(h.x - 300, h.y - 300);
    assert.ok(snap.heroes[i].spd === h.speed * 1.5 && moved > 0);
});
