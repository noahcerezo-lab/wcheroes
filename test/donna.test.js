'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const roster = require('../public/js/heroes-config.js');
const combat = require('../shared/combat.js');
const levels = require('../shared/levelup-table.js');

test('Donna is a seventh selectable hero with complete progression', () => {
  assert.equal(roster.HEROES.length, 7);
  assert.equal(roster.HEROES[6].name, 'DONNA');
  for (let level = 1; level <= 15; level++) {
    const stats = levels.levelStats('DONNA', level);
    assert.ok(stats.hp > 0 && stats.damage > 0 && stats.cool > 0);
  }
});

test('Donna can attack, summon rotating animal allies, level up and snapshot without crashing', () => {
  const w = combat.createBattle({ heroIndices: [6, 0, 4, 5], seed: 42 });
  const donna = w.heroes[0];
  assert.equal(donna.name, 'DONNA');
  w.time = 10000;
  assert.equal(combat.performAttack(w, donna), true);
  assert.equal(combat.performSpecial(w, donna), true);
  assert.equal(donna.animalKind, 0);
  assert.equal(donna.animalUntil, 20000);
  assert.ok(w.events.some(e => e.t === 'druidSummon'));
  w.time = 20000;
  assert.equal(combat.performSpecial(w, donna), true);
  assert.equal(donna.animalKind, 1);
  w.time = 30000;
  assert.equal(combat.performSpecial(w, donna), true);
  assert.equal(donna.animalKind, 2);
  w.wave = 10;
  combat.levelUp(w);
  assert.equal(donna.level, 2);
  assert.ok(combat.snapshot(w).heroes.length === 4);
  for (let i = 0; i < 30; i++) combat.step(w);
});
