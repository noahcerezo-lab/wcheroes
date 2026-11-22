'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const roster = require('../public/js/heroes-config.js');
const combat = require('../shared/combat.js');
const levels = require('../shared/levelup-table.js');

test('Donna has complete progression and the game retains four battle slots', () => {
  assert.equal(roster.HEROES.length, 7);
  assert.equal(roster.HEROES[6].name, 'DONNA');
  for (let lv = 1; lv <= 35; lv++) assert.ok(levels.levelStats('DONNA', lv).hp > 0);
  assert.equal(combat.createBattle({heroIndices:[6,0,4,5]}).heroes.length, 4);
});

test('Donna companion is permanent and evolves at levels 10, 20 and 30', () => {
  const w = combat.createBattle({heroIndices:[6,0,4,5],seed:42});
  const h = w.heroes[0];
  w.time = 10000;
  assert.equal(combat.performAttack(w,h), true);
  assert.equal(combat.performSpecial(w,h), true);
  assert.equal(h.animalBoostUntil,18000);
  for (const [lv,pet] of [[1,0],[9,0],[10,1],[19,1],[20,2],[29,2],[30,3],[40,3]]) {
    h.level=lv;
    assert.equal(combat.snapshot(w).heroes[0].pet,pet);
    w.time+=2000;
    assert.doesNotThrow(()=>combat.step(w));
  }
  h.level=1;
  w.wave=10;
  combat.levelUp(w);
  assert.equal(h.level,2);
  assert.equal(combat.snapshot(w).heroes.length,4);
});
