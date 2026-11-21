'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/combat.js');
function battle() {
  const w = C.createBattle({seed:44, firstWaveDelayMs:1e9});
  w.heroes.forEach(h => { h.ai=false; h.stats={...h.stats,LUK:0}; });
  return w;
}
test('wave-10 and wave-20 clears unlock mastery I and II for surviving heroes',()=>{
  const w=battle();
  w.wave=10; C.levelUp(w);
  assert.equal(w.heroes[3].masteryTier,1);
  assert.equal(C.snapshot(w).heroes[3].mastery,1);
  w.wave=20; C.levelUp(w);
  assert.equal(w.heroes[3].masteryTier,2);
  assert.equal(C.snapshot(w).heroes[3].mastery,2);
});
test('Espirit volleys hit one, two, three distinct enemies by mastery tier',()=>{
  for(let tier=0;tier<=2;tier++){
    const w=battle(), h=w.heroes[3];
    h.x=200;h.y=300;h.aim=0;h.facing=1;h.masteryTier=tier;
    const targets=[[270,300],[275,325],[275,275]].map(([x,y])=>{
      const e=C.spawnEnemy(w,0);e.x=x;e.y=y;e.entered=true;e.hp=e.max=1000;return e;
    });
    assert.equal(C.performAttack(w,h),true);
    assert.equal(targets.filter(e=>e.hp<1000).length,tier+1);
  }
});
test('Markie mastery extends basic-attack stun duration',()=>{
  const durations=[];
  for(let tier=0;tier<=2;tier++){
    const w=battle(),h=w.heroes[2];h.x=200;h.y=300;h.aim=0;h.masteryTier=tier;
    const e=C.spawnEnemy(w,0);e.x=230;e.y=300;e.entered=true;e.hp=e.max=1000;
    C.performAttack(w,h);
    durations.push(e.stunUntil-w.time);
  }
  assert.deepEqual(durations,[140,270,400]);
});
