'use strict';
// Headless multiplayer checks: starts the real server and drives it with Socket.IO clients.
// Run with `npm test`. No browser needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const SIM = require('../public/js/shared-sim.js');
const { startServer, battleWith, wait, emit, once } = require('./helpers');

let srv;
test.before(async () => { srv = await startServer() });
test.after(() => srv?.stop());

test('health endpoint and static pages are served', async () => {
    const h = await (await fetch(srv.url + '/health')).json();
    assert.equal(h.ok, true);
    for (const p of ['/', '/legacy-v19.html', '/js/heroes-render.js', '/js/mp-arena.js', '/js/heroes-config.js', '/js/shared-sim.js', '/js/mp-client.js', '/assets/portraits/noah.jpg']) {
        assert.equal((await fetch(srv.url + p)).status, 200, p);
    }
});

test('shared hero config matches the hero sheets', () => {
    const R = require('../public/js/heroes-config.js');
    assert.deepEqual(R.HEROES.map(h => [h.slot, h.name, h.cls]), [
        ['1P', 'NOAH', 'SPELLBLADE MAGE'], ['2P', 'DESTINY', 'CAPTAIN WARRIOR'], ['3P', 'MARKIE', 'ROGUE-TANK'], ['4P', 'ESPIRIT', 'HUNTER']]);
    for (const h of R.HEROES) for (const k of R.STAT_KEYS) assert.ok(h.stats[k] >= 1 && h.stats[k] <= 10, h.name + ' ' + k);
});

test('shared movement rule rejects NaN/Infinity and clamps to the arena', () => {
    assert.deepEqual(SIM.normalizeMove('abc', Infinity), { x: 0, y: 0 });
    assert.deepEqual(SIM.normalizeMove(NaN, -5), { x: 0, y: -1 });
    const m = SIM.normalizeMove(1e9, 1e9);
    assert.ok(Math.abs(Math.hypot(m.x, m.y) - 1) < 1e-9);
    const h = { x: SIM.ARENA.maxX - 1, y: SIM.ARENA.minY + 1, facing: -1 };
    SIM.stepHero(h, { x: 1, y: -1 });
    assert.equal(h.x, SIM.ARENA.maxX); assert.equal(h.y, SIM.ARENA.minY); assert.equal(h.facing, 1);
});

test('4-player lobby -> battle -> synchronized movement, AI takeover', async () => {
    const [A, B, C, D] = await Promise.all([srv.client(), srv.client(), srv.client(), srv.client()]);
    const created = await emit(A, 'room:create', { name: 'Alice<script>' });
    assert.equal(created.ok, true);
    assert.match(created.code, /^[0-9A-F]{6}$/);
    assert.match(created.token, /^[0-9a-f]{32}$/, 'session token issued');
    const code = created.code;
    const ids = { A: created.playerId };
    for (const [c, n, k] of [[B, 'Bob', 'B'], [C, 'Cara', 'C']]) { const r = await emit(c, 'room:join', { code: code.toLowerCase(), name: n }); assert.equal(r.ok, true); ids[k] = r.playerId }
    assert.equal((await emit(D, 'room:join', { code: 'ZZZZZZ', name: 'x' })).ok, false, 'bad code rejected');
    await wait(100);
    assert.equal(A.room.players.length, 3);
    assert.equal(A.room.players[0].name, 'Alicescript', 'name sanitized');
    assert.ok(!JSON.stringify(A.room).includes(created.token), 'tokens never broadcast');
    assert.deepEqual(A.room.players.map(p => p.hero).sort(), [0, 1, 2], 'unique auto-assigned heroes');
    assert.equal((await emit(B, 'hero:select', { hero: 0 })).ok, false);
    assert.equal((await emit(B, 'hero:select', { hero: 9 })).ok, false);
    assert.equal((await emit(C, 'hero:select', { hero: 3 })).ok, true); // Cara -> ESPIRIT (4P), MARKIE (3P) left for AI
    assert.equal((await emit(A, 'room:start', {})).ok, false, 'cannot start before all ready');
    for (const c of [A, B, C]) assert.equal((await emit(c, 'player:ready', { ready: true })).ok, true);
    assert.equal((await emit(B, 'room:start', {})).ok, false, 'non-host cannot start');
    const starts = [A, B, C].map(c => once(c, 'battle:start'));
    assert.equal((await emit(A, 'room:start', {})).ok, true);
    const worlds = await Promise.all(starts);
    for (const w of worlds) {
        assert.deepEqual(w.heroes.map(h => h.name), ['NOAH', 'DESTINY', 'MARKIE', 'ESPIRIT'], 'hero-sheet slot order');
        assert.ok(w.arena && w.arena.minY > 0, 'arena bounds sent');
    }
    const w0 = worlds[0];
    assert.equal(w0.heroes[0].controller, ids.A);
    assert.equal(w0.heroes[1].controller, ids.B);
    assert.equal(w0.heroes[3].controller, ids.C);
    assert.equal(w0.heroes[2].controller, null, 'MARKIE is AI');
    assert.equal((await emit(D, 'room:join', { code, name: 'Late' })).ok, false, 'cannot join mid-battle');

    const startX = w0.heroes[0].x, t0 = A.latest?.tick ?? 0;
    let sent = 0;
    const iv = setInterval(() => { sent++; A.input(1, 0); B.input(0, -1); C.input(1e9, 'abc'); C.emit('player:input', { x: 1, y: 1 }) /* no seq: ignored */ }, 50);
    await wait(2200);
    clearInterval(iv);
    await wait(300);
    const sA = A.latest;
    const ticks = sA.tick - t0;
    assert.ok(ticks >= 40 && ticks <= 58, '~20 Hz state (' + ticks + ' ticks in 2.5s)');
    const noah = sA.heroes[0];
    assert.ok(noah.x > startX + 100, 'NOAH moved right ' + (noah.x - startX));
    assert.ok(noah.x - startX <= sent * SIM.HERO_SPEED + 1e-9, 'one step per input at most');
    assert.equal(noah.seq, A.seq, 'last input acknowledged');
    assert.equal(noah.facing, 1);
    assert.equal(noah.moving, false, 'stopped after inputs stop');
    assert.equal(sA.heroes[1].y, sA.arena.minY, 'DESTINY clamped at top boundary');
    const esp = sA.heroes[3];
    assert.ok(esp.x - w0.heroes[3].x <= sent * SIM.HERO_SPEED + 1e-9, 'garbage input cannot exceed max speed');
    assert.equal(esp.y, w0.heroes[3].y, 'non-numeric axis ignored, seq-less input ignored');
    const snapsAt = await Promise.all([A, B, C].map(c => once(c, 'battle:state', w => w.tick === sA.tick + 10)));
    for (const s of snapsAt) assert.deepEqual(s.heroes.map(h => [h.x, h.y]), snapsAt[0].heroes.map(h => [h.x, h.y]));
    const ai = snapsAt[0].heroes[2], lead = snapsAt[0].heroes[0];
    assert.ok(Math.hypot(ai.x - lead.x, ai.y - lead.y) < Math.hypot(w0.heroes[2].x - lead.x, w0.heroes[2].y - lead.y) + 1, 'AI closed in on leader');
    for (const h of snapsAt[0].heroes) assert.ok(h.x >= sA.arena.minX && h.x <= sA.arena.maxX && h.y >= sA.arena.minY && h.y <= sA.arena.maxY, h.name + ' in bounds');
    // Bob drops: DESTINY goes to AI while his slot stays reserved.
    const upd = once(A, 'room:update', r => r.players.some(p => p.id === ids.B && !p.connected));
    B.close();
    const r1 = await upd;
    assert.equal(r1.slots[1].reservedFor, 'Bob');
    assert.equal(r1.slots[1].controller, 'AI');
    const after = await once(A, 'battle:state', w => w.heroes[1].controller === null);
    assert.equal(after.heroes[0].controller, ids.A);
    for (const c of [A, C, D]) c.close();
});

test('reconnect-to-slot: dropped player resumes the same hero mid-battle; bogus tokens fail', async () => {
    const { cs: [A, B], acks } = await battleWith(srv, 2);
    const tokenB = acks[1].token, idB = acks[1].playerId;
    // B moves a bit, then drops.
    for (let i = 0; i < 5; i++) { B.input(1, 0); await wait(50) }
    await wait(150);
    const xBefore = A.latest.heroes[1].x;
    B.close();
    await once(A, 'battle:state', w => w.heroes[1].controller === null);
    await wait(300); // AI moves the hero meanwhile
    const B2 = await srv.client();
    assert.equal((await emit(B2, 'session:resume', { token: 'nope' })).ok, false, 'unknown token rejected');
    const res = await emit(B2, 'session:resume', { token: tokenB });
    assert.equal(res.ok, true);
    assert.equal(res.playerId, idB, 'same player identity');
    assert.equal(res.phase, 'battle');
    assert.equal(res.lastSeq, 5, 'server reports last applied input so the client can continue numbering');
    const back = await once(B2, 'battle:state', w => w.heroes[1].controller === idB);
    assert.ok(back, 'DESTINY returned to Bob');
    assert.ok(Math.abs(back.heroes[1].x - xBefore) < 400);
    B2.seq = res.lastSeq;
    const x0 = back.heroes[1].x;
    for (let i = 0; i < 4; i++) { B2.input(-1, 0); await wait(50) }
    await once(B2, 'battle:state', w => w.heroes[1].seq === 9);
    assert.ok(B2.latest.heroes[1].x < x0, 'resumed player controls the hero again');
    assert.ok(B2.room.players.find(p => p.id === idB).connected);
    A.close(); B2.close();
});

test('host migration on drop; host does not bounce back on resume; replaced sessions are told', async () => {
    const { cs: [A, B], acks } = await battleWith(srv, 2);
    const upd = once(B, 'room:update', r => r.host === acks[1].playerId);
    A.close();
    await upd;
    const A2 = await srv.client();
    const res = await emit(A2, 'session:resume', { token: acks[0].token });
    assert.equal(res.ok, true);
    await wait(100);
    assert.equal(A2.room.host, acks[1].playerId, 'Bob stays host');
    assert.equal((await emit(A2, 'room:lobby', {})).ok, false, 'old host lost host powers');
    // Same token from a third socket: A2 is told it was replaced.
    const A3 = await srv.client();
    const replaced = once(A2, 'session:replaced');
    assert.equal((await emit(A3, 'session:resume', { token: acks[0].token })).ok, true);
    await replaced;
    A2.input(1, 0); // ignored now
    await wait(120);
    const h = A3.latest.heroes[0];
    assert.equal(h.controller, acks[0].playerId);
    B.close(); A2.close(); A3.close();
});

test('prediction acks: hero.seq echoes the last applied input, replay reproduces the server exactly, stale seqs ignored', async () => {
    const { cs: [A], world } = await battleWith(srv, 1);
    const start = { ...world.heroes[0] };
    const moves = [[1, 0], [1, 0.5], [0.3, -1], [-1, -1], [1, 1], [0.7, 0.7], [1, 0], [0, 1], [-0.2, 0.9], [1, 0]];
    for (const [x, y] of moves) { A.input(x, y); await wait(50) }
    const s = await once(A, 'battle:state', w => w.heroes[0].seq === 10);
    const pred = { x: start.x, y: start.y, facing: start.facing };
    for (const [x, y] of moves) SIM.stepHero(pred, SIM.normalizeMove(x, y));
    assert.equal(s.heroes[0].x, pred.x, 'client replay == server x');
    assert.equal(s.heroes[0].y, pred.y, 'client replay == server y');
    // Stale / duplicate / absurd sequence numbers do nothing.
    A.emit('player:input', { seq: 5, x: 1, y: 0 });
    A.emit('player:input', { seq: 10, x: 1, y: 0 });
    A.emit('player:input', { seq: 10 + 500000, x: 1, y: 0 });
    A.emit('player:input', { seq: 11.5, x: 1, y: 0 });
    A.emit('player:input', 'garbage');
    await wait(200);
    assert.equal(A.latest.heroes[0].seq, 10);
    assert.equal(A.latest.heroes[0].x, pred.x);
    A.close();
});

test('rate limiting: input floods are acked but only a burst is applied; lobby event spam is refused', async () => {
    const { cs: [A], world } = await battleWith(srv, 1);
    const x0 = world.heroes[0].x;
    for (let i = 0; i < 100; i++) A.input(1, 0); // 100 inputs at once (5 s worth)
    await wait(250);
    const s = await once(A, 'battle:state', w => w.heroes[0].seq === 100);
    const moved = s.heroes[0].x - x0;
    assert.ok(moved > 0, 'some inputs applied');
    assert.ok(moved <= 15 * SIM.HERO_SPEED, 'flood capped (moved ' + moved + ', unlimited would be 500)');
    // Lobby/room events: burst of 40 -> some refused.
    const acks = await Promise.all(Array.from({ length: 40 }, () => emit(A, 'player:ready', { ready: false })));
    assert.ok(acks.some(a => a.error === 'Slow down.'), 'event spam rate-limited');
    assert.ok(acks.filter(a => a.ok === true).length <= 20);
    A.close();
});

test('attack/special: server enforces cooldowns (animation counters only)', async () => {
    const { cs: [A] } = await battleWith(srv, 1);
    const t = Date.now();
    for (let i = 0; i < 12; i++) { A.input(0, 0, { attack: true, special: true }); await wait(50) }
    await wait(120);
    const h = A.latest.heroes[0];
    const elapsed = Date.now() - t;
    assert.ok(h.attackN >= 1 && h.attackN <= Math.ceil(elapsed / 290) + 1, 'attack throttled to NOAH cooldown (' + h.attackN + ')');
    assert.equal(h.specialN, 1, 'special 6.5 s cooldown');
    A.close();
});

test('play again: host returns everyone to the lobby, ready resets, a new round starts', async () => {
    const { cs: [A, B], world } = await battleWith(srv, 2);
    assert.equal((await emit(B, 'room:lobby', {})).ok, false, 'non-host cannot end the battle');
    const ended = once(B, 'battle:end');
    assert.equal((await emit(A, 'room:lobby', {})).ok, true);
    await ended;
    await wait(80);
    assert.equal(B.room.phase, 'lobby');
    assert.ok(B.room.players.every(p => !p.ready), 'ready reset');
    assert.equal((await emit(B, 'hero:select', { hero: 3 })).ok, true, 'can change hero between rounds');
    for (const c of [A, B]) await emit(c, 'player:ready', { ready: true });
    const st = once(B, 'battle:start');
    assert.equal((await emit(A, 'room:start', {})).ok, true);
    const w2 = await st;
    assert.equal(w2.round, world.round + 1);
    assert.equal(w2.heroes[3].controller, B.room.players.find(p => p.name === 'Bob').id);
    // Input numbering carries over between rounds.
    B.input(-1, 0);
    await once(B, 'battle:state', w => w.heroes[3].seq === B.seq);
    A.close(); B.close();
});

test('grace window: after it expires the slot is released and resume fails', async () => {
    const short = await startServer({ RECONNECT_GRACE_MS: '700' });
    try {
        const { cs: [A, B], acks } = await battleWith(short, 2);
        B.close();
        await once(A, 'room:update', r => r.players.length === 1, 3000);
        const B2 = await short.client();
        assert.equal((await emit(B2, 'session:resume', { token: acks[1].token })).ok, false, 'expired');
        const w = await once(A, 'battle:state');
        assert.equal(w.heroes[1].controller, null, 'AI keeps the hero');
        assert.equal(A.room.slots[1].reservedFor, null);
    } finally { short.stop() }
});
