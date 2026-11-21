'use strict';
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
const once = (c, ev, pred = () => true, ms = 4000) => new Promise((res, rej) => {
    const t = setTimeout(() => { c.off(ev, h); rej(new Error('timeout waiting for ' + ev)) }, ms);
    const h = v => { if (pred(v)) { clearTimeout(t); c.off(ev, h); res(v) } };
    c.on(ev, h);
});

// Start a real server process on a free port. Returns {url, client(), stop()}.
async function startServer(env = {}) {
    const port = await freePort();
    const url = 'http://127.0.0.1:' + port;
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('server did not start')), 8000);
        proc.stdout.on('data', d => { if (String(d).includes('port ' + port)) { clearTimeout(t); res() } });
    });
    const clients = [];
    function client() {
        const c = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
        c.latest = null;
        c.seq = 0;
        c.on('battle:state', w => { c.latest = w });
        c.on('room:update', r => { c.room = r });
        // Send one numbered movement input (what the browser does every 50 ms).
        c.input = (x, y, extra = {}) => c.emit('player:input', { seq: ++c.seq, x, y, ...extra });
        clients.push(c);
        return new Promise(res => c.on('connect', () => res(c)));
    }
    function stop() { clients.forEach(c => c.close()); proc.kill() }
    return { url, client, stop };
}

// Create a room with `n` players (first is host), all ready, battle started. Returns clients + acks.
async function battleWith(srv, n, names = ['Alice', 'Bob', 'Cara', 'Dan']) {
    const cs = await Promise.all(Array.from({ length: n }, () => srv.client()));
    const acks = [await emit(cs[0], 'room:create', { name: names[0] })];
    for (let i = 1; i < n; i++) acks.push(await emit(cs[i], 'room:join', { code: acks[0].code, name: names[i] }));
    for (const c of cs) await emit(c, 'player:ready', { ready: true });
    const starts = cs.map(c => once(c, 'battle:start'));
    const st = await emit(cs[0], 'room:start', {});
    if (!st.ok) throw new Error('start failed: ' + st.error);
    const worlds = await Promise.all(starts);
    return { cs, acks, code: acks[0].code, world: worlds[0] };
}

module.exports = { startServer, battleWith, wait, emit, once };
