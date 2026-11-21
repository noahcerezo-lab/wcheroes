'use strict';
// M5: pooled particles — fixed capacity, density scaling, frame-rate independent motion.
const test = require('node:test');
const assert = require('node:assert');
const { createPool } = require('../public/js/fx-pool.js');

test('pool never grows past its capacity and recycles dead particles', () => {
    const p = createPool(64);
    for (let i = 0; i < 20; i++) p.burst(0, 0, '#fff', 10);
    assert.equal(p.count, 64);
    p.update(50); for (let i = 0; i < 40; i++) p.update(50);
    assert.equal(p.count, 0, 'all expired');
    assert.equal(p.burst(0, 0, '#fff', 10), 10, 'slots are reused');
});

test('density scales how many particles spawn (adaptive quality)', () => {
    const p = createPool(5000);
    p.density = 0.35;
    let n = 0; for (let i = 0; i < 200; i++) n += p.burst(0, 0, '#fff', 10);
    assert.ok(n > 600 && n < 800, 'about 35% of 2000: ' + n);
});

test('motion is frame-rate independent (30 vs 120 fps end at the same place)', () => {
    const run = step => { const p = createPool(1); p.emit(1, q => { q.x = 0; q.y = 0; q.vx = .2; q.vy = 0; q.life = 1000 }); for (let t = 0; t < 300; t += step) p.update(step); return p };
    const a = run(1000 / 30), b = run(1000 / 120);
    // read the live particle through draw() into a fake context
    const pos = p => { let x = null; p.draw({ fillRect: (X) => { x = X }, set globalAlpha(v) {}, set fillStyle(v) {}, set globalCompositeOperation(v) {} }); return x };
    assert.ok(Math.abs(pos(a) - pos(b)) <= 2, pos(a) + ' vs ' + pos(b));
});
