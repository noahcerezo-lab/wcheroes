'use strict';
// Headless multiplayer checks: starts the real server and drives it with 4 Socket.IO clients.
// Run with `npm test`. No browser needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { io } = require('socket.io-client');

const freePort = () => new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) });
    s.on('error', rej);
});
const wait = ms => new Promise(r => setTimeout(r, ms));
const emit = (c, ev, data) => new Promise(res => c.emit(ev, data, res));
const once = (c, ev, pred = () => true, ms = 3000) => new Promise((res, rej) => {
    const t = setTimeout(() => { c.off(ev, h); rej(new Error('timeout waiting for ' + ev)) }, ms);
    const h = v => { if (pred(v)) { clearTimeout(t); c.off(ev, h); res(v) } };
    c.on(ev, h);
});

let server, url;
const clients = [];
function client() {
    const c = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    c.latest = null;
    c.on('battle:state', w => { c.latest = w });
    c.on('room:update', r => { c.room = r });
    clients.push(c);
    return new Promise(res => c.on('connect', () => res(c)));
}

test.before(async () => {
    const port = await freePort();
    url = 'http://127.0.0.1:' + port;
    server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('server did not start')), 8000);
        server.stdout.on('data', d => { if (String(d).includes('port ' + port)) { clearTimeout(t); res() } });
    });
});
test.after(() => { clients.forEach(c => c.close()); server?.kill() });

test('health endpoint and static pages are served', async () => {
    const h = await (await fetch(url + '/health')).json();
    assert.equal(h.ok, true);
    for (const p of ['/', '/legacy-v19.html', '/js/heroes-render.js', '/js/mp-arena.js', '/js/heroes-config.js', '/assets/portraits/noah.jpg']) {
        const r = await fetch(url + p);
        assert.equal(r.status, 200, p);
    }
});

test('shared hero config matches the hero sheets', () => {
    const R = require('../public/js/heroes-config.js');
    assert.deepEqual(R.HEROES.map(h => [h.slot, h.name, h.cls]), [
        ['1P', 'NOAH', 'SPELLBLADE MAGE'], ['2P', 'DESTINY', 'CAPTAIN WARRIOR'], ['3P', 'MARKIE', 'ROGUE-TANK'], ['4P', 'ESPIRIT', 'HUNTER']]);
    for (const h of R.HEROES) for (const k of R.STAT_KEYS) assert.ok(h.stats[k] >= 1 && h.stats[k] <= 10, h.name + ' ' + k);
});

test('4-player lobby -> battle -> synchronized movement, AI takeover', async () => {
    const [A, B, C, D] = await Promise.all([client(), client(), client(), client()]);
    const created = await emit(A, 'room:create', { name: 'Alice<script>' });
    assert.equal(created.ok, true);
    assert.match(created.code, /^[0-9A-F]{6}$/);
    const code = created.code;
    for (const [c, n] of [[B, 'Bob'], [C, 'Cara']]) assert.equal((await emit(c, 'room:join', { code: code.toLowerCase(), name: n })).ok, true);
    assert.equal((await emit(D, 'room:join', { code: 'ZZZZZZ', name: 'x' })).ok, false, 'bad code rejected');
    await wait(100);
    assert.equal(A.room.players.length, 3);
    assert.equal(A.room.players[0].name, 'Alicescript', 'name sanitized');
    assert.deepEqual(A.room.players.map(p => p.hero).sort(), [0, 1, 2], 'unique auto-assigned heroes');

    // Hero selection: taking a claimed hero fails, a free one works.
    assert.equal((await emit(B, 'hero:select', { hero: 0 })).ok, false);
    assert.equal((await emit(B, 'hero:select', { hero: 9 })).ok, false);
    assert.equal((await emit(C, 'hero:select', { hero: 3 })).ok, true); // Cara -> ESPIRIT (4P), MARKIE (3P) left for AI

    // Ready checks and host-only start.
    assert.equal((await emit(A, 'room:start', {})).ok, false, 'cannot start before all ready');
    for (const c of [A, B, C]) assert.equal((await emit(c, 'player:ready', { ready: true })).ok, true);
    assert.equal((await emit(B, 'room:start', {})).ok, false, 'non-host cannot start');
    const starts = [A, B, C].map(c => once(c, 'battle:start'));
    assert.equal((await emit(A, 'room:start', {})).ok, true);
    const worlds = await Promise.all(starts);
    for (const w of worlds) {
        assert.equal(w.heroes.length, 4);
        assert.deepEqual(w.heroes.map(h => h.name), ['NOAH', 'DESTINY', 'MARKIE', 'ESPIRIT'], 'hero-sheet slot order');
        assert.ok(w.arena && w.arena.minY > 0, 'arena bounds sent');
    }
    const ids = { A: A.id, B: B.id, C: C.id };
    const w0 = worlds[0];
    assert.equal(w0.heroes[0].controller, ids.A);
    assert.equal(w0.heroes[1].controller, ids.B);
    assert.equal(w0.heroes[3].controller, ids.C);
    assert.equal(w0.heroes[2].controller, null, 'MARKIE is AI');
    assert.equal((await emit(D, 'room:join', { code, name: 'Late' })).ok, false, 'cannot join mid-battle');

    // Movement: A moves right, B moves up (into the wall), C sends garbage input.
    const startX = w0.heroes[0].x;
    const t0 = A.latest?.tick ?? 0;
    const iv = setInterval(() => {
        A.emit('player:input', { x: 1, y: 0 });
        B.emit('player:input', { x: 0, y: -1 });
        C.emit('player:input', { x: 1e9, y: 'abc' });
    }, 50);
    await wait(2200);
    clearInterval(iv);
    A.emit('player:input', { x: 0, y: 0 }); B.emit('player:input', { x: 0, y: 0 }); C.emit('player:input', { x: 0, y: 0 });
    await wait(300);
    const sA = A.latest;
    const ticks = sA.tick - t0;
    assert.ok(ticks >= 35 && ticks <= 55, '~20 Hz state (' + ticks + ' ticks in 2.5s)');
    const noah = sA.heroes[0];
    assert.ok(noah.x > startX + 100, 'NOAH moved right ' + (noah.x - startX));
    assert.ok(noah.x - startX <= ticks * 5 + 0.001, 'speed capped by server');
    assert.equal(noah.facing, 1);
    assert.equal(noah.moving, false, 'stopped after input released');
    assert.equal(sA.heroes[1].y, sA.arena.minY, 'DESTINY clamped at top boundary');
    const esp = sA.heroes[3];
    assert.ok(esp.x - w0.heroes[3].x <= ticks * 5 + 0.001, 'garbage input cannot exceed max speed');
    assert.equal(esp.y, w0.heroes[3].y, 'non-numeric axis ignored');
    // Same tick on every client => same positions (server-authoritative broadcast).
    await wait(30);
    const snapsAt = await Promise.all([A, B, C].map(c => once(c, 'battle:state', w => w.tick === sA.tick + 10)));
    for (const s of snapsAt) assert.deepEqual(s.heroes.map(h => [h.x, h.y]), snapsAt[0].heroes.map(h => [h.x, h.y]));
    // AI follows a human leader.
    const ai = snapsAt[0].heroes[2], lead = snapsAt[0].heroes[0];
    assert.ok(Math.hypot(ai.x - lead.x, ai.y - lead.y) < Math.hypot(w0.heroes[2].x - lead.x, w0.heroes[2].y - lead.y) + 1, 'AI closed in on leader');
    for (const h of snapsAt[0].heroes) {
        assert.ok(h.x >= sA.arena.minX && h.x <= sA.arena.maxX && h.y >= sA.arena.minY && h.y <= sA.arena.maxY, h.name + ' in bounds');
    }

    // Disconnect: Bob leaves mid-battle -> DESTINY becomes AI, others keep playing.
    const upd = once(A, 'room:update', r => r.players.length === 2);
    B.close();
    await upd;
    const after = await once(A, 'battle:state', w => w.heroes[1].controller === null);
    assert.equal(after.heroes[0].controller, ids.A);
    // Host leaves -> host migrates to Cara.
    const upd2 = once(C, 'room:update', r => r.players.length === 1);
    A.close();
    const r2 = await upd2;
    assert.equal(r2.host, ids.C);
});
