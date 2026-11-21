'use strict';
const express = require('express');
const http = require('http');
const {
    Server
} = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: false
    }
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({
    ok: true,
    rooms: rooms.size
}));
const PORT = Number(process.env.PORT || 3000);
const HEROES = ['NOAH', 'MARKIE', 'DESTINY', 'ESPIRIT'];
const COLORS = ['#6daaff', '#e8a14b', '#e8c78c', '#6edba0'];
const rooms = new Map();
const safeAck = (ack, data) => {
    if (typeof ack === 'function') ack(data)
};
const publicRoom = r => ({
    code: r.code,
    phase: r.phase,
    host: r.host,
    players: [...r.players.values()].map(p => ({
        id: p.id,
        name: p.name,
        hero: p.hero,
        ready: p.ready
    })),
    slots: HEROES.map((hero, i) => ({
        hero,
        controller: [...r.players.values()].find(p => p.hero === i)?.name || 'AI',
        human: !![...r.players.values()].find(p => p.hero === i)
    }))
});
const emitRoom = r => io.to(r.code).emit('room:update', publicRoom(r));
const cleanName = s => String(s || 'Hero').trim().replace(/[<>]/g, '').slice(0, 20) || 'Hero';
const codeGen = () => {
    let c;
    do {
        c = crypto.randomBytes(3).toString('hex').toUpperCase()
    } while (rooms.has(c));
    return c
};

function leave(socket) {
    const code = socket.data.room;
    if (!code) return;
    socket.leave(code);
    socket.data.room = null;
    const r = rooms.get(code);
    if (!r) return;
    r.players.delete(socket.id);
    if (!r.players.size) {
        rooms.delete(code);
        return
    }
    if (r.host === socket.id) r.host = r.players.keys().next().value;
    emitRoom(r)
}

function join(socket, r, name, ack) {
    if (socket.data.room) leave(socket);
    if (r.phase !== 'lobby') return safeAck(ack, {
        ok: false,
        error: 'Battle already started. Join the next room.'
    });
    if (r.players.size >= 4) return safeAck(ack, {
        ok: false,
        error: 'Room is full.'
    });
    const used = new Set([...r.players.values()].map(p => p.hero));
    const hero = HEROES.findIndex((_, i) => !used.has(i));
    r.players.set(socket.id, {
        id: socket.id,
        name: cleanName(name),
        hero,
        ready: false,
        input: {
            x: 0,
            y: 0
        }
    });
    socket.data.room = r.code;
    socket.join(r.code);
    safeAck(ack, {
        ok: true,
        code: r.code
    });
    emitRoom(r)
}

function initialWorld(r) {
    const spawn = [
        [410, 230],
        [510, 230],
        [410, 330],
        [510, 330]
    ];
    r.world = {
        tick: 0,
        heroes: HEROES.map((name, i) => ({
            name,
            color: COLORS[i],
            x: spawn[i][0],
            y: spawn[i][1],
            hp: 100,
            controller: [...r.players.values()].find(p => p.hero === i)?.id || null
        }))
    }
}
io.on('connection', socket => {
    socket.on('room:create', (data, ack) => {
        const code = codeGen();
        const r = {
            code,
            phase: 'lobby',
            host: socket.id,
            players: new Map(),
            world: null
        };
        rooms.set(code, r);
        join(socket, r, data?.name, ack)
    });
    socket.on('room:join', (data, ack) => {
        const code = String(data?.code || '').trim().toUpperCase();
        const r = rooms.get(code);
        if (!r) return safeAck(ack, {
            ok: false,
            error: 'Room not found. Check the code.'
        });
        join(socket, r, data?.name, ack)
    });
    socket.on('hero:select', (data, ack) => {
        const r = rooms.get(socket.data.room),
            p = r?.players.get(socket.id);
        if (!r || !p || r.phase !== 'lobby') return safeAck(ack, {
            ok: false,
            error: 'Not in a lobby.'
        });
        const hero = Number(data?.hero);
        if (!Number.isInteger(hero) || hero < 0 || hero >= 4) return safeAck(ack, {
            ok: false,
            error: 'Invalid hero.'
        });
        if ([...r.players.values()].some(v => v.id !== p.id && v.hero === hero)) return safeAck(ack, {
            ok: false,
            error: 'Hero already claimed.'
        });
        p.hero = hero;
        p.ready = false;
        emitRoom(r);
        safeAck(ack, {
            ok: true
        })
    });
    socket.on('player:ready', (data, ack) => {
        const r = rooms.get(socket.data.room),
            p = r?.players.get(socket.id);
        if (!r || !p || r.phase !== 'lobby') return safeAck(ack, {
            ok: false,
            error: 'Not in lobby.'
        });
        p.ready = !!data?.ready;
        emitRoom(r);
        safeAck(ack, {
            ok: true
        })
    });
    socket.on('room:start', (_data, ack) => {
        const r = rooms.get(socket.data.room);
        if (!r || r.host !== socket.id) return safeAck(ack, {
            ok: false,
            error: 'Only host can start.'
        });
        if (r.phase !== 'lobby') return safeAck(ack, {
            ok: false,
            error: 'Already started.'
        });
        if (![...r.players.values()].every(p => p.ready)) return safeAck(ack, {
            ok: false,
            error: 'Everyone must be ready.'
        });
        r.phase = 'battle';
        initialWorld(r);
        emitRoom(r);
        io.to(r.code).emit('battle:start', r.world);
        safeAck(ack, {
            ok: true
        })
    });
    socket.on('player:input', data => {
        const r = rooms.get(socket.data.room),
            p = r?.players.get(socket.id);
        if (!r || !p || r.phase !== 'battle') return;
        let x = Number(data?.x) || 0,
            y = Number(data?.y) || 0;
        const len = Math.hypot(x, y);
        if (len > 1) {
            x /= len;
            y /= len
        }
        p.input = {
            x: Math.max(-1, Math.min(1, x)),
            y: Math.max(-1, Math.min(1, y))
        }
    });
    socket.on('disconnect', () => leave(socket));
    socket.on('room:leave', () => leave(socket));
});
// Authoritative 20 Hz movement prototype. Combat, enemy AI, damage and waves are not networked yet.
setInterval(() => {
    for (const r of rooms.values()) {
        if (r.phase !== 'battle' || !r.world) continue;
        r.world.tick++;
        const humans = [...r.players.values()];
        for (let i = 0; i < 4; i++) {
            const h = r.world.heroes[i];
            const p = humans.find(p => p.hero === i);
            if (p) {
                h.controller = p.id;
                h.x = Math.max(28, Math.min(932, h.x + p.input.x * 5));
                h.y = Math.max(28, Math.min(512, h.y + p.input.y * 5))
            } else {
                h.controller = null;
                const leader = r.world.heroes.find(v => humans.some(p => p.hero === HEROES.indexOf(v.name))) || r.world.heroes[0];
                const dx = leader.x - h.x + (i % 2 ? 55 : -55),
                    dy = leader.y - h.y + ((i % 3) - 1) * 50,
                    d = Math.hypot(dx, dy);
                if (d > 65) {
                    h.x += dx / d * 2.6;
                    h.y += dy / d * 2.6
                }
            }
        }
        io.to(r.code).emit('battle:state', r.world)
    }
}, 50);
server.listen(PORT, () => console.log('West Coast Heroes multiplayer server on port ' + PORT));