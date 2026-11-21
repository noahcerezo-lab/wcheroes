'use strict';
/*
 * West Coast Heroes — multiplayer server (Node + Express + Socket.IO).
 *
 * The server is the authority for rooms, hero slots and movement. Clients send inputs; the server
 * applies them, runs the AI teammates and broadcasts one snapshot per 50 ms tick.
 *
 * Phase A additions:
 *   - Sessions: every player gets a secret token. If their connection drops (or they refresh), the
 *     hero is AI-controlled but RESERVED for RECONNECT_GRACE_MS; `session:resume` with the token
 *     hands it back, mid-battle included. After the grace window the slot is released.
 *   - Sequence-numbered inputs: each `player:input` carries `seq`; snapshots echo the last applied
 *     seq per hero so the client can reconcile its prediction.
 *   - Rate limiting / validation on every client event.
 *   - Host can return the room to the lobby (play again).
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const SIM = require('./public/js/shared-sim.js');
// Roster (slot order, names, colors) is shared with the browser: public/js/heroes-config.js
const ROSTER = require('./public/js/heroes-config.js');

const PORT = Number(process.env.PORT || 3000);
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS || 45000);
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 500);
const INPUT_RATE = 22; // inputs per second refilled (client sends 20/s)
const INPUT_BURST = 8; // short bursts allowed (network jitter can bunch inputs)
const EVENT_RATE = 5; // lobby/room events per second
const EVENT_BURST = 15;
const SPECIAL_COOLDOWN_MS = 6500; // V19 special cooldown
const AI_SPEED = 2.6;

const app = express();
const server = http.createServer(app);
// Faster dead-connection detection than the defaults (25s + 20s) so AI takes over sooner.
const io = new Server(server, { cors: { origin: false }, pingInterval: 10000, pingTimeout: 8000, maxHttpBufferSize: 16e3 });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const HEROES = ROSTER.NAMES; // ['NOAH', 'DESTINY', 'MARKIE', 'ESPIRIT']
const COLORS = ROSTER.HEROES.map(h => h.color);
const ATTACK_COOLDOWN_MS = ROSTER.HEROES.map(h => h.v19.cool);
const ARENA = SIM.ARENA;
const clamp = SIM.clamp;
const rooms = new Map();
const sessions = new Map(); // token -> {code, playerId}
const safeAck = (ack, data) => { if (typeof ack === 'function') ack(data) };
const cleanName = s => String(s || 'Hero').trim().replace(/[<>]/g, '').slice(0, 20) || 'Hero';
const randomId = bytes => crypto.randomBytes(bytes).toString('hex');
const codeGen = () => { let c; do { c = randomId(3).toUpperCase() } while (rooms.has(c)); return c };

// Token bucket: returns false when the caller is over its rate.
function takeToken(bucket, rate, burst) {
    const now = Date.now();
    bucket.tokens = Math.min(burst, (bucket.tokens ?? burst) + ((now - (bucket.at || now)) / 1000) * rate);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
}

const playersOf = r => [...r.players.values()];
const connectedPlayers = r => playersOf(r).filter(p => p.connected);
const controllerOf = (r, i) => playersOf(r).find(p => p.hero === i && p.connected) || null;

const publicRoom = r => ({
    code: r.code,
    phase: r.phase,
    host: r.host,
    round: r.round,
    graceMs: RECONNECT_GRACE_MS,
    players: playersOf(r).map(p => ({
        id: p.id, name: p.name, hero: p.hero, ready: p.ready, connected: p.connected,
        graceLeftMs: p.connected ? 0 : Math.max(0, RECONNECT_GRACE_MS - (Date.now() - p.disconnectedAt))
    })),
    slots: HEROES.map((hero, i) => {
        const owner = playersOf(r).find(p => p.hero === i);
        return { hero, controller: owner && owner.connected ? owner.name : 'AI', human: !!(owner && owner.connected), reservedFor: owner && !owner.connected ? owner.name : null };
    })
});
const emitRoom = r => io.to(r.code).emit('room:update', publicRoom(r));

// Host must be a connected player whenever one exists.
function ensureHost(r) {
    const host = r.players.get(r.host);
    if (host && host.connected) return;
    const next = connectedPlayers(r)[0];
    if (next) r.host = next.id;
    else if (!host && r.players.size) r.host = r.players.keys().next().value;
}

function attach(socket, r, p) {
    if (p.socketId && p.socketId !== socket.id) {
        const old = io.sockets.sockets.get(p.socketId);
        if (old) { // same token opened elsewhere (new tab / reconnect before the old socket timed out)
            old.data.room = null; old.data.playerId = null;
            old.leave(r.code);
            old.emit('session:replaced');
        }
    }
    if (socket.data.room && (socket.data.room !== r.code || socket.data.playerId !== p.id)) leave(socket);
    clearTimeout(p.graceTimer);
    p.graceTimer = null;
    p.connected = true;
    p.socketId = socket.id;
    p.disconnectedAt = 0;
    p.input = { x: 0, y: 0 };
    socket.data.room = r.code;
    socket.data.playerId = p.id;
    socket.join(r.code);
    ensureHost(r);
}

function removePlayer(r, p) {
    clearTimeout(p.graceTimer);
    r.players.delete(p.id);
    sessions.delete(p.token);
    if (!r.players.size) { rooms.delete(r.code); return }
    ensureHost(r);
    emitRoom(r);
}

// Connection lost: keep the slot for the grace window, AI plays the hero meanwhile.
function drop(socket) {
    const r = rooms.get(socket.data.room), p = r?.players.get(socket.data.playerId);
    socket.data.room = null; socket.data.playerId = null;
    if (!r || !p || p.socketId !== socket.id) return;
    p.connected = false;
    p.socketId = null;
    p.ready = false;
    p.input = { x: 0, y: 0 };
    p.disconnectedAt = Date.now();
    p.graceTimer = setTimeout(() => { if (!p.connected && r.players.get(p.id) === p) removePlayer(r, p) }, RECONNECT_GRACE_MS);
    p.graceTimer.unref?.();
    ensureHost(r);
    emitRoom(r);
}

// Deliberate leave: free the slot immediately.
function leave(socket) {
    const r = rooms.get(socket.data.room), p = r?.players.get(socket.data.playerId);
    if (r) socket.leave(r.code);
    socket.data.room = null; socket.data.playerId = null;
    if (r && p && p.socketId === socket.id) removePlayer(r, p);
}

function join(socket, r, name, ack) {
    if (r.phase !== 'lobby') return safeAck(ack, { ok: false, error: 'Battle already started. Ask the host to return to the lobby, or join the next room.' });
    if (r.players.size >= 4) return safeAck(ack, { ok: false, error: 'Room is full.' });
    if (socket.data.room) leave(socket);
    const used = new Set(playersOf(r).map(p => p.hero));
    const hero = HEROES.findIndex((_, i) => !used.has(i));
    const p = { id: 'p' + randomId(6), token: randomId(16), name: cleanName(name), hero, ready: false, connected: false, socketId: null, disconnectedAt: 0, graceTimer: null, input: { x: 0, y: 0 }, lastSeq: 0, lastMoveTick: -9, dropped: 0, bucket: {} };
    r.players.set(p.id, p);
    sessions.set(p.token, { code: r.code, playerId: p.id });
    attach(socket, r, p);
    safeAck(ack, { ok: true, code: r.code, playerId: p.id, token: p.token });
    emitRoom(r);
}

function initialWorld(r) {
    const spawn = [[410, 230], [510, 230], [410, 330], [510, 330]];
    r.world = {
        tick: 0, serverTime: Date.now(), arena: ARENA, zone: 0, round: r.round,
        heroes: HEROES.map((name, i) => ({
            name, color: COLORS[i], x: spawn[i][0], y: spawn[i][1], hp: 100, maxHp: 100,
            facing: i % 2 ? -1 : 1, moving: false, seq: 0, attackN: 0, specialN: 0, attackAt: 0, specialAt: 0,
            controller: controllerOf(r, i)?.id || null
        }))
    };
}

// Wrap a lobby/room event handler with a per-socket rate limit.
function limited(socket, handler) {
    return (data, ack) => {
        socket.data.bucket = socket.data.bucket || {};
        if (!takeToken(socket.data.bucket, EVENT_RATE, EVENT_BURST)) return safeAck(ack, { ok: false, error: 'Slow down.' });
        try { handler(data && typeof data === 'object' ? data : {}, ack) } catch (e) { console.error(e); safeAck(ack, { ok: false, error: 'Server error.' }) }
    };
}

io.on('connection', socket => {
    const ctx = () => { const r = rooms.get(socket.data.room); return { r, p: r?.players.get(socket.data.playerId) } };
    socket.on('room:create', limited(socket, (data, ack) => {
        if (rooms.size >= MAX_ROOMS) return safeAck(ack, { ok: false, error: 'Server is full. Try again later.' });
        if (socket.data.room) leave(socket);
        const code = codeGen();
        const r = { code, phase: 'lobby', host: null, round: 0, players: new Map(), world: null };
        rooms.set(code, r);
        join(socket, r, data.name, ack);
    }));
    socket.on('room:join', limited(socket, (data, ack) => {
        const r = rooms.get(String(data.code || '').trim().toUpperCase().slice(0, 6));
        if (!r) return safeAck(ack, { ok: false, error: 'Room not found. Check the code.' });
        join(socket, r, data.name, ack);
    }));
    socket.on('session:resume', limited(socket, (data, ack) => {
        const s = sessions.get(String(data.token || ''));
        const r = s && rooms.get(s.code), p = r?.players.get(s?.playerId);
        if (!r || !p) return safeAck(ack, { ok: false, error: 'Session expired.' });
        attach(socket, r, p);
        safeAck(ack, { ok: true, code: r.code, playerId: p.id, token: p.token, phase: r.phase, world: r.world, lastSeq: p.lastSeq });
        emitRoom(r);
    }));
    socket.on('hero:select', limited(socket, (data, ack) => {
        const { r, p } = ctx();
        if (!r || !p || r.phase !== 'lobby') return safeAck(ack, { ok: false, error: 'Not in a lobby.' });
        const hero = Number(data.hero);
        if (!Number.isInteger(hero) || hero < 0 || hero >= HEROES.length) return safeAck(ack, { ok: false, error: 'Invalid hero.' });
        const owner = playersOf(r).find(v => v.id !== p.id && v.hero === hero);
        if (owner) return safeAck(ack, { ok: false, error: owner.connected ? 'Hero already claimed.' : 'Hero reserved for ' + owner.name + ' (reconnecting).' });
        p.hero = hero;
        p.ready = false;
        emitRoom(r);
        safeAck(ack, { ok: true });
    }));
    socket.on('player:ready', limited(socket, (data, ack) => {
        const { r, p } = ctx();
        if (!r || !p || r.phase !== 'lobby') return safeAck(ack, { ok: false, error: 'Not in lobby.' });
        p.ready = data.ready === true;
        emitRoom(r);
        safeAck(ack, { ok: true });
    }));
    socket.on('room:start', limited(socket, (_data, ack) => {
        const { r, p } = ctx();
        if (!r || !p || r.host !== p.id) return safeAck(ack, { ok: false, error: 'Only host can start.' });
        if (r.phase !== 'lobby') return safeAck(ack, { ok: false, error: 'Already started.' });
        if (!connectedPlayers(r).every(v => v.ready)) return safeAck(ack, { ok: false, error: 'Everyone must be ready.' });
        r.phase = 'battle';
        r.round++;
        for (const v of playersOf(r)) { v.lastMoveTick = -9 }
        initialWorld(r);
        emitRoom(r);
        io.to(r.code).emit('battle:start', r.world);
        safeAck(ack, { ok: true });
    }));
    // Play again: host sends everyone back to hero select. Ready flags reset.
    socket.on('room:lobby', limited(socket, (_data, ack) => {
        const { r, p } = ctx();
        if (!r || !p || r.host !== p.id) return safeAck(ack, { ok: false, error: 'Only the host can return to the lobby.' });
        if (r.phase !== 'battle') return safeAck(ack, { ok: false, error: 'Not in a battle.' });
        r.phase = 'lobby';
        r.world = null;
        for (const v of playersOf(r)) v.ready = false;
        io.to(r.code).emit('battle:end', { reason: 'host', by: p.name });
        emitRoom(r);
        safeAck(ack, { ok: true });
    }));
    // Movement input. Not acked: the next snapshot's hero.seq is the acknowledgement.
    socket.on('player:input', data => {
        const { r, p } = ctx();
        if (!r || !p || r.phase !== 'battle' || !r.world || !data || typeof data !== 'object') return;
        const seq = Number(data.seq);
        if (!Number.isInteger(seq) || seq <= p.lastSeq || seq > p.lastSeq + 100000) return; // stale, duplicate or bogus
        p.lastSeq = seq;
        const h = r.world.heroes[p.hero];
        if (!takeToken(p.bucket, INPUT_RATE, INPUT_BURST)) { p.dropped++; return } // acked (seq advanced) but not applied
        const move = SIM.normalizeMove(data.x, data.y);
        p.input = move;
        if (SIM.stepHero(h, move)) p.lastMoveTick = r.world.tick;
        const now = Date.now();
        if (data.attack === true && now - h.attackAt >= ATTACK_COOLDOWN_MS[p.hero]) { h.attackAt = now; h.attackN++ }
        if (data.special === true && now - h.specialAt >= SPECIAL_COOLDOWN_MS) { h.specialAt = now; h.specialN++ }
    });
    socket.on('room:leave', () => leave(socket));
    socket.on('disconnect', () => drop(socket));
});

// Authoritative 20 Hz tick. Human movement is applied as inputs arrive (rate-limited above);
// the tick runs AI teammates, records who controls each hero and broadcasts one snapshot.
// Combat, enemy AI, damage and waves are not networked yet.
function stepWorld(r) {
    const w = r.world;
    w.tick++;
    w.serverTime = Date.now();
    const humans = connectedPlayers(r);
    for (let i = 0; i < HEROES.length; i++) {
        const h = w.heroes[i];
        const p = humans.find(v => v.hero === i);
        const owner = playersOf(r).find(v => v.hero === i);
        h.seq = owner ? owner.lastSeq : 0;
        if (p) {
            h.controller = p.id;
            h.moving = w.tick - p.lastMoveTick <= 1;
            continue;
        }
        h.controller = null;
        const ox = h.x, oy = h.y;
        const leader = w.heroes.find(v => humans.some(q => q.hero === HEROES.indexOf(v.name))) || w.heroes[0];
        const dx = leader.x - h.x + (i % 2 ? 55 : -55), dy = leader.y - h.y + ((i % 3) - 1) * 50, d = Math.hypot(dx, dy);
        if (d > 65) {
            h.x = clamp(h.x + dx / d * AI_SPEED, ARENA.minX, ARENA.maxX);
            h.y = clamp(h.y + dy / d * AI_SPEED, ARENA.minY, ARENA.maxY);
        }
        const mx = h.x - ox;
        h.moving = Math.abs(mx) + Math.abs(h.y - oy) > 0.01;
        if (Math.abs(mx) > 0.01) h.facing = mx > 0 ? 1 : -1;
    }
}
setInterval(() => {
    for (const r of rooms.values()) {
        if (r.phase !== 'battle' || !r.world) continue;
        stepWorld(r);
        io.to(r.code).emit('battle:state', r.world);
    }
}, SIM.TICK_MS);
server.listen(PORT, () => console.log('West Coast Heroes multiplayer server on port ' + PORT));
