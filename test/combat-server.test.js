'use strict';
// Server-level combat checks: the real server with waves on, driven by Socket.IO clients.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, battleWith, wait, once } = require('./helpers');

test('clients cannot forge damage: extra input fields and fake events do nothing; internals never leave the server', async () => {
    const srv = await startServer({ FIRST_WAVE_DELAY_MS: '0', COMBAT_SEED: '9' });
    try {
        const { cs: [A], world } = await battleWith(srv, 1);
        assert.equal(world.seed, undefined, 'RNG seed is not sent');
        assert.ok(Array.isArray(world.enemies) && world.arena, 'battle:start carries arena + enemies');
        const evs = [];
        A.on('battle:state', w => evs.push(...w.ev));
        const iv = setInterval(() => {
            A.input(0, 0, { attack: 'yes', special: 1, damage: 99999, hp: 99999, kill: true, enemies: [] });
            A.emit('enemy:hit', { id: 1, damage: 99999 }); A.emit('battle:state', { over: 1 }); A.emit('hero:hp', { hp: 9999 });
        }, 50);
        await wait(9000);
        clearInterval(iv);
        const mine = evs.filter(e => (e.t === 'hit' || e.t === 'kill') && e.h === 0);
        assert.equal(mine.length, 0, 'NOAH (human, never sent attack:true) dealt no damage');
        assert.ok(evs.some(e => e.t === 'hit' && e.h > 0), 'AI teammates did fight');
        const me = A.latest.heroes[0];
        assert.ok(me.hp <= me.maxHp && me.attackN === 0 && me.specialN === 0);
        assert.equal(A.latest.over, 0);
        A.close();
    } finally { srv.stop() }
});

test('downed humans cannot move; a team wipe shows game over and returns everyone to the lobby', { timeout: 90000 }, async () => {
    const srv = await startServer({ FIRST_WAVE_DELAY_MS: '0', ENEMY_DAMAGE_MUL: '60', GAME_OVER_RETURN_MS: '1500', COMBAT_SEED: '4' });
    try {
        const { cs: [A, B] } = await battleWith(srv, 2);
        // No projectile enemies any more, so walk both humans to the left edge where enemies come in.
        const walk = setInterval(() => { if (A.latest && A.latest.heroes[0].state !== 1) A.input(-1, 0); B.input(-1, 0) }, 50);
        let down;
        try { down = await once(A, 'battle:state', w => w.heroes[0].state === 1, 60000) } finally { clearInterval(walk) }
        const x0 = down.heroes[0].x, y0 = down.heroes[0].y;
        for (let i = 0; i < 6; i++) { A.input(1, 1); await wait(50) }
        await wait(200);
        const h = A.latest.heroes[0];
        if (h.state === 1) assert.deepEqual([h.x, h.y], [x0, y0], 'downed hero stayed put');
        assert.equal(h.seq, A.seq, 'inputs still acknowledged while downed');
        const overState = await once(A, 'battle:state', w => w.over === 1, 60000);
        assert.ok(overState.ev.some(e => e.t === 'over') || overState.over === 1);
        const ended = await once(B, 'battle:end', undefined, 10000);
        assert.equal(ended.reason, 'wipe');
        assert.ok(ended.wave >= 1 && typeof ended.score === 'number');
        await wait(100);
        assert.equal(B.room.phase, 'lobby');
        assert.ok(B.room.players.every(p => !p.ready), 'ready flags reset for the next round');
        A.close(); B.close();
    } finally { srv.stop() }
});
