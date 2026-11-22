/*
 * West Coast Heroes — multiplayer client (lobby, session, input, prediction).
 *
 * - Session: the server gives each player a secret token, stored in localStorage. After a drop or a
 *   page refresh we send `session:resume` and get the same hero back (within the server's grace window).
 * - Prediction: every 50 ms we send one numbered input and immediately apply the same movement rule
 *   locally (WCHSim.stepHero), so your hero moves with no network delay. Each snapshot tells us the last
 *   input the server applied (hero.seq); we restart from the server's position and replay newer inputs.
 *   Other heroes are drawn with interpolation (mp-arena.js).
 */
(function () {
    'use strict';
    const SIM = window.WCHSim, ROSTER = WCHHeroes.HEROES, STORE_KEY = 'wch.session';
    const params = new URLSearchParams(location.search);
    const socket = io({ reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 500, reconnectionDelayMax: 5000, timeout: 20000 });
    const $ = id => document.getElementById(id);
    let room = null, world = null, me = null; // me = {playerId, token, code}
    let seq = 0, pending = [], predicted = null, predictedFor = null, visualOffset = { x: 0, y: 0 }, lastLocalMove = 0;
    const keys = {}, touch = { x: 0, y: 0, attack: false, special: false };
    const tapped = { attack: false, special: false }; // a quick tap between two input ticks still counts
    const predictionOn = params.get('predict') !== '0';

    if (window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0) document.body.classList.add('touch');

    // ---------- small UI helpers ----------
    function show(id) {
        for (const key of ['entry', 'lobby', 'battle']) $(key).classList.toggle('hidden', key !== id);
        document.body.classList.toggle('in-battle', id === 'battle');
        if (id === 'battle') $('notice').textContent = '';
    }
    function note(msg, ms = 6500) {
        $('notice').textContent = msg;
        setTimeout(() => { if ($('notice').textContent === msg) $('notice').textContent = '' }, ms);
    }
    function send(event, data, cb) {
        socket.emit(event, data, r => {
            if (!r?.ok) { note(r?.error || 'Request failed'); return }
            cb?.(r);
        });
    }
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const invite = () => location.origin + location.pathname + '?room=' + room.code;
    const myId = () => me?.playerId || null;

    // ---------- session ----------
    function saveSession(r) {
        me = { playerId: r.playerId, token: r.token, code: r.code };
        try { localStorage.setItem(STORE_KEY, JSON.stringify(me)) } catch {}
        history.replaceState({}, '', '?room=' + r.code);
    }
    function clearSession() {
        me = null;
        try { localStorage.removeItem(STORE_KEY) } catch {}
    }
    function storedSession() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null') } catch { return null }
    }
    function resume() {
        const s = me || storedSession();
        if (!s?.token) return;
        socket.emit('session:resume', { token: s.token }, r => {
            if (!r?.ok) {
                clearSession();
                $('conn').classList.add('hidden');
                room = null; world = null; arena.reset(); resetPrediction();
                show('entry');
                if (s.code) $('roomCode').value = s.code;
                note('Your previous session expired — join again.');
                return;
            }
            saveSession(r);
            seq = Math.max(seq, r.lastSeq || 0);
            if (r.phase === 'battle' && r.world) { world = r.world; arena.reset(); arena.push(r.world); resetPrediction(); show('battle') } // prediction restarts on the next snapshot (controller is set by the next tick)
            $('conn').classList.add('hidden');
            note(r.phase === 'battle' ? 'Reconnected — you have your hero back.' : 'Reconnected to room ' + r.code + '.');
        });
    }

    // ---------- lobby ----------
    function renderLobby() {
        if (!room) return;
        $('code').textContent = room.code;
        const mine = room.players.find(p => p.id === myId());
        $('heroes').replaceChildren();
        room.slots.forEach((slot, i) => {
            const owner = room.players.find(p => p.hero === i), b = document.createElement('button');
            const cfg = ROSTER[i];
            b.className = 'hero' + (mine?.hero === i ? ' mine' : '') + (owner && owner.id !== myId() ? ' taken' : '');
            b.disabled = !!owner && owner.id !== myId();
            b.style.setProperty('--hero', cfg.color);
            const bars = WCHHeroes.STAT_KEYS.map(k => '<span class="stat"><i>' + k + '</i><span class="bar"><span style="width:' + Math.round(cfg.fill[k] * 100) + '%"></span></span></span>').join('');
            const tag = !owner ? 'AVAILABLE' : !owner.connected ? '⟳ ' + esc(owner.name) + ' reconnecting…' : esc(owner.name) + (owner.ready ? ' ✓ READY' : ' • NOT READY');
            b.innerHTML = '<span class="slot">' + cfg.slot + '</span>' + (slot.hero === 'SMITESH' ? '<span class="portrait" style="display:grid;place-items:center;font-size:42px;background:radial-gradient(circle,#377c83,#17253c);color:#d9fff4">✦</span>' : '<img class="portrait" src="assets/portraits/' + slot.hero.toLowerCase() + '.png" alt="' + slot.hero + ' portrait">') + '<b>' + slot.hero + '</b><small>' + cfg.cls + '</small><span class="stats">' + bars + '</span><span class="tag">' + tag + '</span>';
            b.onclick = () => send('hero:select', { hero: i });
            $('heroes').appendChild(b);
        });
        const connected = room.players.filter(p => p.connected), waiting = room.players.filter(p => !p.connected);
        $('ready').textContent = mine?.ready ? '✓ READY — TAP TO UNREADY' : "I'M READY";
        $('start').classList.toggle('hidden', room.host !== myId());
        $('start').disabled = !connected.length || connected.some(p => !p.ready);
        $('lobbyStatus').textContent = connected.length + ' player(s) connected • ' + (4 - connected.length) + ' AI teammate(s) • ' + connected.filter(p => p.ready).length + '/' + connected.length + ' ready' + (waiting.length ? ' • waiting on ' + waiting.map(p => p.name).join(', ') : '') + (room.host === myId() ? ' • you are the host' : '');
    }
    function renderSquad() {
        if (!room) return;
        $('toLobby').classList.toggle('hidden', room.host !== myId());
        const active = room.activeRoster || [0, 1, 2, 3];
        $('squad').replaceChildren(...active.map(i => { const slot = room.slots[i];
            const owner = room.players.find(p => p.hero === i), li = document.createElement('li');
            li.style.setProperty('--hero', ROSTER[i].color);
            li.className = owner?.connected ? '' : 'ai';
            let who;
            if (!owner) who = '<span class="badge ai">AI</span>';
            else if (!owner.connected) who = esc(owner.name) + ' <span class="badge wait">reconnecting ' + Math.ceil(owner.graceLeftMs / 1000) + 's</span> <span class="badge ai">AI meanwhile</span>';
            else who = esc(owner.name) + (owner.id === myId() ? ' <span class="badge you">YOU</span>' : '') + (owner.id === room.host ? ' <span class="badge">HOST</span>' : '');
            li.innerHTML = '<b>' + ROSTER[i].slot + ' ' + slot.hero + '</b>' + who;
            return li;
        }));
    }
    function render() {
        if (!room) return;
        renderLobby();
        renderSquad();
        show(room.phase === 'battle' ? 'battle' : 'lobby');
    }

    $('create').onclick = () => send('room:create', { name: $('name').value }, r => { saveSession(r); seq = 0 });
    $('join').onclick = () => send('room:join', { code: $('roomCode').value, name: $('name').value }, r => { saveSession(r); seq = 0 });
    $('ready').onclick = () => { const mine = room?.players.find(p => p.id === myId()); send('player:ready', { ready: !mine?.ready }) };
    $('start').onclick = () => send('room:start', {});
    $('toLobby').onclick = () => send('room:lobby', {});
    const leave = () => { socket.emit('room:leave'); clearSession(); room = null; world = null; arena.reset(); resetPrediction(); history.replaceState({}, '', location.pathname); show('entry') };
    $('leaveLobby').onclick = leave;
    $('leaveBattle').onclick = () => { if (confirm('Leave the battle? Your hero becomes an AI teammate.')) leave() };
    $('copy').onclick = async () => {
        try { await navigator.clipboard.writeText(invite()); note('Invite link copied!') } catch { note('Share this link: ' + invite()) }
    };

    // ---------- server events ----------
    socket.on('room:update', r => { room = r; render() });
    socket.on('battle:start', w => { world = w; arena.reset(); arena.push(w); resetPrediction(); reconcile(w); show('battle') });
    socket.on('battle:state', w => { world = w; reconcile(w); arena.push(w) });
    socket.on('battle:end', e => {
        world = null; arena.reset(); resetPrediction();
        if (e?.reason === 'wipe') note('Squad defeated on wave ' + e.wave + ' — score ' + e.score + ', ' + e.kills + ' KOs. Ready up to play again!', 12000);
        else note('Back in the lobby' + (e?.by ? ' — ' + e.by + ' ended the round.' : '.'));
    });
    socket.on('session:replaced', () => { me = null; room = null; world = null; arena.reset(); show('entry'); note('This game was opened in another tab or window.') });
    socket.on('disconnect', reason => {
        $('status').textContent = 'Disconnected — reconnecting…';
        if (room) { $('conn').classList.remove('hidden'); note('Connection lost (' + reason + ') — reconnecting…') }
    });
    socket.io.on('reconnect_error', () => { if (room) $('status').textContent = 'Trying to reconnect…'; });
    // iOS Safari may suspend sockets when switching apps or locking the screen.
    // Wake the transport promptly instead of waiting for a stale heartbeat timeout.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !socket.connected) socket.connect();
    });
    window.addEventListener('pageshow', () => { if (!socket.connected) socket.connect(); });
    socket.on('connect', () => {
        $('status').textContent = 'Connected';
        resume(); // first load (refresh) or after a drop
    });

    const urlRoom = params.get('room');
    if (urlRoom && !storedSession()) { $('roomCode').value = urlRoom.toUpperCase(); note('Enter your name, then tap JOIN ROOM.') }
    try { const n = localStorage.getItem('wch.name'); if (n) $('name').value = n } catch {}
    $('name').addEventListener('change', () => { try { localStorage.setItem('wch.name', $('name').value) } catch {} });

    // ---------- prediction ----------
    function myHeroIndex(w) { return w ? w.heroes.findIndex(h => h.controller && h.controller === myId()) : -1 }
    // Same speed the server uses: the snapshot's effective speed (spd includes HASTE x1.5), else the
    // hero's base V19 speed converted to world units per input.
    const speedOf = i => { const h = world && world.heroes[i]; return h && Number.isFinite(h.spd) && h.spd > 0 ? h.spd : SIM.speedFromV19(ROSTER[i].v19.speed) };
    const canMove = w => { const i = myHeroIndex(w); return i >= 0 && !w.heroes[i].state && !w.over };
    function resetPrediction() { pending = []; predicted = null; predictedFor = null; visualOffset = { x: 0, y: 0 } }
    function reconcile(w) {
        const i = myHeroIndex(w);
        if (i < 0 || !predictionOn) { if (predicted) resetPrediction(); return }
        const h = w.heroes[i];
        pending = pending.filter(p => p.seq > h.seq);
        const next = { x: h.x, y: h.y, facing: h.facing, vx: h.vx, vy: h.vy, aim: h.aim }; // velocity + aim too, so acceleration replays exactly
        if (!h.state && !w.over) for (const p of pending) SIM.stepHero(next, p.move, speedOf(i)); // downed: no movement to replay
        if (predicted && predictedFor === i) {
            // Keep what's on screen continuous: the correction fades out over a few frames.
            visualOffset.x += predicted.x - next.x;
            visualOffset.y += predicted.y - next.y;
            if (Math.hypot(visualOffset.x, visualOffset.y) > 80) visualOffset = { x: 0, y: 0 };
        }
        predicted = next;
        predictedFor = i;
    }
    function localHero() {
        if (!predicted || !predictionOn) return null;
        visualOffset.x *= 0.8; visualOffset.y *= 0.8;
        return { index: predictedFor, x: predicted.x + visualOffset.x, y: predicted.y + visualOffset.y, facing: predicted.facing, aim: predicted.aim, moving: performance.now() - lastLocalMove < 120 };
    }

    // ---------- input ----------
    function readMove() {
        let x = (keys.d || keys.arrowright ? 1 : 0) - (keys.a || keys.arrowleft ? 1 : 0);
        let y = (keys.s || keys.arrowdown ? 1 : 0) - (keys.w || keys.arrowup ? 1 : 0);
        if (!x && !y) { x = touch.x; y = touch.y }
        return SIM.normalizeMove(x, y);
    }
    function tickInput() {
        if (!socket.connected || !room || room.phase !== 'battle' || !world || myHeroIndex(world) < 0) return;
        const move = readMove();
        const attack = !!(keys[' '] || touch.attack || tapped.attack), special = !!(keys.q || touch.special || tapped.special);
        tapped.attack = tapped.special = false;
        seq++;
        socket.emit('player:input', { seq, x: move.x, y: move.y, attack, special });
        if (predictionOn && predicted) {
            pending.push({ seq, move });
            if (pending.length > 120) pending.shift();
            if (canMove(world) && SIM.stepHero(predicted, move, speedOf(predictedFor))) lastLocalMove = performance.now();
        }
    }
    setInterval(tickInput, SIM.TICK_MS);
    addEventListener('keydown', e => {
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
        keys[e.key.toLowerCase()] = true;
        if (e.key === ' ') tapped.attack = true;
        if (e.key.toLowerCase() === 'q') tapped.special = true;
        if (e.key.startsWith('Arrow') || (e.key === ' ' && document.body.classList.contains('in-battle'))) e.preventDefault();
    });
    addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false });
    addEventListener('blur', () => { for (const k in keys) keys[k] = false; resetJoy(); touch.attack = touch.special = false });

    // V19 virtual joystick: analog direction, released when the finger lifts.
    const joy = $('joystick'), stick = $('stick');
    let joyPointer = null;
    function moveStick(e) {
        const r = joy.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        let dx = e.clientX - cx, dy = e.clientY - cy;
        const radius = r.width * .32, dist = Math.hypot(dx, dy) || 1;
        if (dist > radius) { dx = dx / dist * radius; dy = dy / dist * radius }
        stick.style.transform = `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px))`;
        const dead = radius * .2, mag = Math.hypot(dx, dy);
        if (mag < dead) { touch.x = touch.y = 0; return }
        const k = Math.min(1, (mag - dead) / (radius - dead)) / mag; // ramp from the dead zone to full speed
        touch.x = dx * k; touch.y = dy * k;
    }
    function resetJoy() { joyPointer = null; joy.classList.remove('active'); stick.style.transform = 'translate(-50%,-50%)'; touch.x = touch.y = 0 }
    joy.addEventListener('pointerdown', e => {
        e.preventDefault();
        if (joyPointer !== null) return;
        joyPointer = e.pointerId;
        joy.classList.add('active');
        try { joy.setPointerCapture(e.pointerId) } catch {}
        moveStick(e);
    });
    joy.addEventListener('pointermove', e => { if (e.pointerId === joyPointer) { e.preventDefault(); moveStick(e) } });
    for (const evt of ['pointerup', 'pointercancel', 'lostpointercapture']) joy.addEventListener(evt, e => { if (e.pointerId === joyPointer) resetJoy() });
    function bindButton(id, field) {
        const b = $(id);
        let pointer = null;
        b.addEventListener('pointerdown', e => {
            e.preventDefault();
            if (pointer !== null) return;
            pointer = e.pointerId;
            try { b.setPointerCapture(e.pointerId) } catch {}
            touch[field] = true;
            tapped[field] = true;
            b.classList.add('pressed');
        });
        for (const evt of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(evt, e => {
            if (pointer === e.pointerId) { pointer = null; touch[field] = false; b.classList.remove('pressed') }
        });
    }
    bindButton('attack-touch', 'attack');
    bindButton('special-touch', 'special');
    document.addEventListener('touchmove', e => { if (e.target.closest('#touch-controls')) e.preventDefault() }, { passive: false });

    // ---------- arena ----------
    const arena = WCHArena.createArena($('arena'), {
        getRoom: () => room,
        getMyId: myId,
        getLocalHero: localHero,
        interpolate: params.get('interp') !== '0'
    });
    arena.start();
    setInterval(() => { if (room?.phase === 'battle') renderSquad() }, 1000); // reconnect countdowns
    // Debug/test hook (read-only views).
    window.__wch = { arena, getWorld: () => world, getRoom: () => room, getMe: () => me, getPending: () => pending.length, getPredicted: () => predicted, socket };
})();
