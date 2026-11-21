'use strict';
// AI teammate movement: orbit threats, back off from overlaps, escape when stuck, Espirit keeps distance.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/combat.js');

function measure(seed) {
    const w = C.createBattle({ seed, firstWaveDelayMs: 0 }); // all four heroes are AI
    const st = w.heroes.map(() => ({ engaged: 0, still: 0, overlapRun: 0, maxOverlapRun: 0, dist: 0, n: 0 }));
    for (let t = 0; t < 20 * 90 && !w.over; t++) {
        const before = w.heroes.map(h => [h.x, h.y]);
        C.step(w);
        w.heroes.forEach((h, i) => {
            if (h.state !== 'alive') return;
            let ed = Infinity, ne = null;
            for (const e of w.enemies) if (e.entered) { const d = Math.hypot(e.x - h.x, e.y - h.y); if (d < ed) { ed = d; ne = e } }
            const s = st[i];
            if (ed < 200) {
                s.engaged++;
                if (Math.hypot(h.x - before[i][0], h.y - before[i][1]) < 0.05) s.still++;
                s.dist += ed; s.n++;
            }
            const overlap = ne && ed < (C.ENEMY_TYPES[ne.type].radius || 12) + 6;
            s.overlapRun = overlap ? s.overlapRun + 1 : 0;
            s.maxOverlapRun = Math.max(s.maxOverlapRun, s.overlapRun);
        });
    }
    return { w, st };
}

test('AI teammates keep moving against enemies (orbit), do not stay overlapped, Espirit keeps more distance', () => {
    for (const seed of [1, 2, 3]) {
        const { w, st } = measure(seed);
        assert.ok(w.kills > 20, 'squad still fights well (seed ' + seed + ': ' + w.kills + ' kills, wave ' + w.wave + ')');
        st.forEach((s, i) => {
            const name = w.heroes[i].name;
            assert.ok(s.engaged > 100, name + ' engaged ' + s.engaged);
            assert.ok(s.still / s.engaged < 0.15, name + ' motionless ' + Math.round(100 * s.still / s.engaged) + '% of engaged ticks (seed ' + seed + ')');
            assert.ok(s.maxOverlapRun <= 12, name + ' overlapped an enemy for ' + s.maxOverlapRun + ' ticks in a row (seed ' + seed + ')');
        });
        const avg = i => st[i].dist / st[i].n;
        for (const i of [0, 1, 2]) assert.ok(avg(3) > avg(i), 'Espirit avg distance ' + avg(3).toFixed(0) + ' vs ' + w.heroes[i].name + ' ' + avg(i).toFixed(0));
    }
});

test('one-on-one with a held enemy: every AI hero circles it instead of standing still; Espirit stays ~150 away', () => {
    const res = {};
    for (const hi of [0, 1, 2, 3]) {
        const w = C.createBattle({ seed: 21, firstWaveDelayMs: 1e9 });
        w.heroes.forEach((h, i) => { h.x = i % 2 ? 925 : 35; h.y = i < 2 ? 85 : 515; h.ai = i === hi }); // others: idle humans in the corners
        const h = w.heroes[hi]; h.x = 330; h.y = 300;
        const e = C.spawnEnemy(w, 0); e.x = 480; e.y = 300; e.entered = true; e.hp = e.max = 1e9; e.stunUntil = 1e12;
        let still = 0, d = 0, angles = new Set();
        for (let t = 0; t < 100; t++) {
            const x0 = h.x, y0 = h.y; C.step(w); e.x = 480; e.y = 300; e.kx = e.ky = 0;
            if (t >= 20) { if (Math.hypot(h.x - x0, h.y - y0) < 0.05) still++; d += Math.hypot(h.x - e.x, h.y - e.y); angles.add(Math.round(Math.atan2(h.y - e.y, h.x - e.x) / (Math.PI / 4))) }
        }
        res[h.name] = { still, d: d / 80, octants: angles.size, attacks: h.attackN };
    }
    for (const [name, r] of Object.entries(res)) {
        assert.ok(r.still <= 8, name + ' stood still ' + r.still + '/80 ticks');
        assert.ok(r.attacks >= 4, name + ' still attacks while moving (' + r.attacks + ')');
        if (name !== 'ESPIRIT') assert.ok(r.octants >= 3, name + ' circled through ' + r.octants + ' octants');
    }
    assert.ok(res.ESPIRIT.d > 120, 'Espirit distance ' + res.ESPIRIT.d.toFixed(0));
    for (const n of ['NOAH', 'DESTINY', 'MARKIE']) assert.ok(res[n].d < 85 && res.ESPIRIT.d > res[n].d + 50, n + ' ' + res[n].d.toFixed(0));
});

test('AI backs off when overlapping an enemy and sidesteps when stuck', () => {
    const w = C.createBattle({ seed: 9, firstWaveDelayMs: 1e9 });
    w.heroes.forEach((h, i) => { h.x = 60 + i * 5; h.y = 500 }); // park the others far away
    const m = w.heroes[2]; m.x = 480; m.y = 300; // Markie
    const e = C.spawnEnemy(w, 0); e.x = 482; e.y = 300; e.entered = true; e.hp = e.max = 1e6; e.stunUntil = 1e12;
    for (let t = 0; t < 6; t++) C.step(w);
    assert.ok(Math.hypot(m.x - e.x, m.y - e.y) > 12 + 6, 'moved off the enemy body (' + Math.hypot(m.x - e.x, m.y - e.y).toFixed(1) + ')');
    // stuck against the top wall with the orbit pushing into it: escape kicks in and the hero keeps moving
    const v = C.createBattle({ seed: 4, firstWaveDelayMs: 1e9 });
    v.heroes.forEach((h, i) => { h.x = 60 + i * 5; h.y = 500 });
    const n = v.heroes[0]; n.x = 30; n.y = 82;
    const f = C.spawnEnemy(v, 0); f.x = 30; f.y = 160; f.entered = true; f.hp = f.max = 1e6; f.stunUntil = 1e12;
    const path = [];
    for (let t = 0; t < 60; t++) { C.step(v); path.push([n.x, n.y]) }
    let still = 0; for (let t = 1; t < path.length; t++) if (Math.hypot(path[t][0] - path[t - 1][0], path[t][1] - path[t - 1][1]) < 0.05) still++;
    assert.ok(still < 10, 'cornered AI kept moving (' + still + ' still ticks of 60)');
});
