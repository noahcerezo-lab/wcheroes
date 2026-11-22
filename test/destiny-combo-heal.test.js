'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/combat.js');

test('Destiny heals herself after three connected basic attack swings, not misses', () => {
  const w = C.createBattle({ seed: 17, firstWaveDelayMs: 1e9 });
  const h = w.heroes.find(x => x.name === 'DESTINY');
  h.ai = false; h.x = 200; h.y = 300; h.aim = 0; h.facing = 1;
  h.hp = Math.max(1, h.maxHp - 50);
  const e = C.spawnEnemy(w, 0);
  e.x = 225; e.y = 300; e.entered = true; e.hp = e.max = 100000;
  const before = h.hp;
  for (let n = 0; n < 3; n++) {
    w.time += 1000;
    assert.equal(C.performAttack(w, h), true);
  }
  assert.ok(h.hp > before, 'third connected swing grants a small heal');
  assert.ok(h.hp <= before + Math.round(h.maxHp * .05));
  assert.equal(w.events.filter(ev => ev.t === 'comboHeal').length, 1);
  const healed = h.hp;
  e.x = 900; e.y = 500;
  for (let n = 0; n < 3; n++) { w.time += 1000; C.performAttack(w, h); }
  assert.equal(h.hp, healed, 'missing attacks cannot charge the heal');
});

test('Destiny heal caps at maximum health and multi-target sweeps count once', () => {
  const w = C.createBattle({ seed: 11, firstWaveDelayMs: 1e9 });
  const h = w.heroes.find(x => x.name === 'DESTINY');
  h.ai = false; h.x = 200; h.y = 300; h.aim = 0; h.hp = h.maxHp - 2;
  for (const y of [295, 305]) {
    const e = C.spawnEnemy(w, 0); e.x = 225; e.y = y; e.entered = true; e.hp = e.max = 100000;
  }
  w.time = 1000; C.performAttack(w, h);
  assert.equal(h.destinyComboHits, 1);
  w.time = 2000; C.performAttack(w, h);
  w.time = 3000; C.performAttack(w, h);
  assert.equal(h.hp, h.maxHp);
  assert.equal(w.events.filter(ev => ev.t === 'comboHeal').length, 1);
});
