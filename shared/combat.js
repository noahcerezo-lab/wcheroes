'use strict';
/*
 * West Coast Heroes — server-authoritative combat simulation (DOM-free, deterministic).
 *
 * Ported from legacy-v19.html (attack(), special(), hit(), aiTick(), healingPulse(), enemy loop) and
 * re-expressed for a fixed 20 Hz server tick:
 *   - World units are 960x540 (see public/js/shared-sim.js). V19 distances / 1.5, V19 per-frame
 *     speeds x 2 per tick, V19 millisecond timers kept as milliseconds of simulated time.
 *   - All randomness comes from a seeded RNG stored in the world, so a given seed + inputs always
 *     produces the same fight (unit tests rely on this).
 *   - Clients never call this. They send intents (move / attack / special); the server calls
 *     step() and broadcasts snapshot() + the tick's events.
 *
 * Phase D hooks: isBossWave(), hooks.onWaveStart / onWaveCleared / onUpgrade, world.zone.
 */
const SIM = require('../public/js/shared-sim.js');
const ROSTER = require('../public/js/heroes-config.js');

const ARENA = SIM.ARENA;
const TICK = SIM.TICK_MS;
const S = SIM.fromV19;
const clamp = SIM.clamp;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------- tuning (V19 values, converted) ----------------
const RULES = {
    specialCooldownMs: 6500, // V19 special()
    aiSpecialCooldownMs: 9500, // V19 aiTick specials
    aiAttackCooldownMul: 1.2, // V19 AI attacks at cool * 1.2
    destinyAuraMs: 1500, destinyAuraHeal: 3, destinyAuraRadius: S(145),
    reviveRadius: 38, reviveMs: 2000, reviveHpFrac: 0.4,
    comboWindowMs: 4300,
    knockPerTick: 2.338 / 1.5, knockDecay: Math.pow(0.76, 3), // V19 kx decays x0.76 per frame
    enemyMargin: S(85), // spawn distance outside the arena
    maxEnemies: 24, // cap on enemies alive (bandwidth + readability)
    intermissionMs: 3000,
    waveClearHeal: 25, // V19 heals 25 HP on wave-up
    downedHp: 0,
};

// Enemy types. Grunt = V19's armored swordsman (hp 30+8w, speed 1+0.1w per frame, 7+w damage every 850 ms).
const ENEMY_TYPES = [
    { key: 'grunt', from: 1, weight: 1, hp: w => 30 + 8 * w, speed: w => Math.min(5.2, (1 + 0.1 * w) * 2), dmg: w => 7 + w, reach: S(29) + 3, atkMs: 850, knockResist: 0, radius: 12, scale: 1 },
    { key: 'runner', from: 3, weight: 0.35, hp: w => 16 + 5 * w, speed: w => Math.min(6.4, (1.5 + 0.1 * w) * 2), dmg: w => 4 + 0.7 * w, reach: S(26) + 3, atkMs: 600, knockResist: 0, radius: 10, scale: 0.85 },
    { key: 'brute', from: 5, weight: 0.2, hp: w => 90 + 22 * w, speed: w => Math.min(3.4, (0.7 + 0.05 * w) * 2), dmg: w => 14 + 2 * w, reach: S(40) + 3, atkMs: 1300, knockResist: 0.6, radius: 18, scale: 1.3 },
];
const ENEMY_INDEX = Object.fromEntries(ENEMY_TYPES.map((t, i) => [t.key, i]));

// Per-hero combat kit. Base numbers come from V19 (heroes-config v19 block); shapes from V19 attack()/special().
const KITS = {
    NOAH: { attack: 'crescent', arc: 1.12, knock: 15, stun: 0, specialName: 'ARCANE NOVA', specialRadius: S(210), specialMul: 3, specialKnock: 15, aiIdeal: S(100) },
    DESTINY: { attack: 'captain', arc: 0.95, knock: 10, stun: 650, specialName: 'RALLY STRIKE', specialRadius: S(180), specialMul: 3, specialStun: 1000, rallyHeal: 35, rallyRadius: S(190), buffMs: 5000, buffMul: 1.25, aiIdeal: S(58) },
    MARKIE: { attack: 'cleave', front: 0.55, frontMul: 1.5, sideMul: 0.7, knock: 19, stun: 140, specialName: 'EARTHSHATTER', specialRadius: S(160), specialMul: 4, specialStun: 600, tauntMs: 4000, shieldMs: 3000, shieldMul: 0.45, aiIdeal: S(48) },
    ESPIRIT: { attack: 'arrow', arc: 0.24, knock: 10, stun: 0, specialName: 'ARROW STORM', specialRadius: S(340), specialMul: 3, aiIdeal: S(185), critMul: 2 },
};

// Sheet stats -> small modifiers. LUK = crit chance, VIT = damage taken.
const critChance = (name, st) => st.LUK * (name === 'ESPIRIT' ? 0.04 : 0.015); // Espirit: 36%
const damageTakenMul = st => clamp(1 - (st.VIT - 5) * 0.04, 0.7, 1.2); // Markie (VIT 9): 0.84

function isBossWave(n) { return n > 0 && n % 15 === 0 } // Phase D: spawn a boss instead of a normal wave

// ---------------- RNG ----------------
function rng(world) { // mulberry32
    let t = (world.seed = (world.seed + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------------- world ----------------
function createBattle(opts = {}) {
    const spawn = opts.spawn || [[410, 230], [510, 230], [410, 330], [510, 330]];
    const world = {
        tick: 0, time: 0, seed: (opts.seed >>> 0) || 1, zone: 0,
        wave: 0, waveState: 'intermission', nextWaveAt: opts.firstWaveDelayMs ?? RULES.intermissionMs,
        toSpawn: 0, spawnTimer: 0, nextEnemyId: 1,
        score: 0, kills: 0, combo: 0, comboUntil: 0, over: false,
        maxEnemies: opts.maxEnemies || RULES.maxEnemies,
        heroes: ROSTER.HEROES.map((cfg, i) => ({
            name: cfg.name, x: spawn[i][0], y: spawn[i][1], facing: i % 2 ? -1 : 1, moving: false,
            hp: cfg.v19.hp, maxHp: cfg.v19.hp, damage: cfg.v19.damage, range: S(cfg.v19.range), cool: cfg.v19.cool,
            speed: SIM.speedFromV19(cfg.v19.speed), stats: cfg.stats,
            state: 'alive', reviveMs: 0, attackAt: -1e9, specialAt: -1e9, healAt: 0, attackN: 0, specialN: 0,
            buffUntil: 0, shieldUntil: 0, wantAttack: false, wantSpecial: false, ai: true, controller: null, seq: 0,
        })),
        enemies: [],
        events: [],
        hooks: opts.hooks || {},
    };
    return world;
}

const alive = h => h.state === 'alive';
const emit = (w, e) => { w.events.push(e) };

// ---------------- damage ----------------
function damageEnemy(w, hero, e, base, o = {}) {
    if (e.hp <= 0) return;
    let d = base * (w.time < hero.buffUntil ? KITS.DESTINY.buffMul : 1);
    const crit = rng(w) < critChance(hero.name, hero.stats);
    if (crit) d *= KITS[hero.name].critMul || 1.75;
    d = Math.max(1, Math.round(d));
    e.hp -= d;
    const t = ENEMY_TYPES[e.type];
    const dir = o.dir ?? (Math.sign(e.x - hero.x) || hero.facing);
    const kb = (o.knock ?? 11) * RULES.knockPerTick * (1 - t.knockResist);
    e.kx = dir * kb;
    e.ky = (rng(w) - 0.5) * 5 * RULES.knockPerTick * (1 - t.knockResist);
    if (o.stun) e.stunUntil = Math.max(e.stunUntil, w.time + o.stun);
    emit(w, { t: 'hit', id: e.id, d, c: crit ? 1 : 0, h: w.heroes.indexOf(hero), x: Math.round(e.x), y: Math.round(e.y) });
    if (e.hp <= 0) killEnemy(w, hero, e);
}

function killEnemy(w, hero, e) {
    w.enemies.splice(w.enemies.indexOf(e), 1);
    w.combo = w.time < w.comboUntil ? Math.min(20, w.combo + 1) : 1;
    w.comboUntil = w.time + RULES.comboWindowMs;
    const mult = Math.min(5, 1 + Math.floor(w.combo / 4));
    const pts = 10 * Math.max(1, w.wave) * mult * (e.type === ENEMY_INDEX.brute ? 3 : 1);
    w.score += pts;
    w.kills++;
    emit(w, { t: 'kill', id: e.id, h: w.heroes.indexOf(hero), x: Math.round(e.x), y: Math.round(e.y), combo: w.combo, mult, pts });
}

function damageHero(w, h, amount, by) {
    if (!alive(h) || w.over) return;
    let d = amount * damageTakenMul(h.stats);
    if (w.time < h.shieldUntil) d *= KITS.MARKIE.shieldMul;
    d = Math.max(1, Math.round(d));
    h.hp = Math.max(0, h.hp - d);
    const i = w.heroes.indexOf(h);
    emit(w, { t: 'hurt', h: i, d, by: by?.id });
    if (h.hp <= 0) {
        h.state = 'downed';
        h.reviveMs = 0;
        h.wantAttack = h.wantSpecial = false;
        emit(w, { t: 'down', h: i });
    }
}

function healHero(w, h, amount, from) {
    if (!alive(h) || h.hp >= h.maxHp) return 0;
    const n = Math.min(amount, h.maxHp - h.hp);
    h.hp += n;
    emit(w, { t: 'heal', h: w.heroes.indexOf(h), n, from: w.heroes.indexOf(from) });
    return n;
}

// V19 inArc(): facing-locked cone, y squashed by 1.2 for the fake perspective.
function inArc(h, e, range, half) {
    const dx = e.x - h.x, dy = (e.y - h.y) * 1.2, d = Math.hypot(dx, dy);
    if (d > range || d < 0.5) return d < 0.5;
    return dx * h.facing / d >= Math.cos(half);
}
const inReach = (h, e, range) => Math.hypot(e.x - h.x, (e.y - h.y) * 1.2) <= range;

// Targets a basic attack would hit right now (used by attack + AI decisions).
function attackTargets(w, h) {
    const k = KITS[h.name];
    if (h.name === 'ESPIRIT') {
        const lane = w.enemies.filter(e => inArc(h, e, h.range, k.arc)).sort((a, b) => dist(a, h) - dist(b, h));
        return lane.slice(0, 1); // single arrow, nearest in the lane
    }
    if (h.name === 'MARKIE') return w.enemies.filter(e => inReach(h, e, h.range));
    return w.enemies.filter(e => inArc(h, e, h.range, k.arc));
}

function performAttack(w, h) {
    if (!alive(h) || w.over) return false;
    const cool = h.ai ? h.cool * RULES.aiAttackCooldownMul : h.cool;
    if (w.time - h.attackAt < cool) return false;
    h.attackAt = w.time;
    h.attackN++;
    const k = KITS[h.name], i = w.heroes.indexOf(h);
    const targets = attackTargets(w, h);
    emit(w, { t: 'atk', h: i, k: k.attack, f: h.facing, n: targets.length });
    for (const e of [...targets]) {
        let dmg = h.damage;
        if (h.name === 'MARKIE') dmg = Math.round(h.damage * (inArc(h, e, h.range, k.front) ? k.frontMul : k.sideMul));
        damageEnemy(w, h, e, dmg, { knock: k.knock, stun: k.stun, dir: h.facing });
    }
    return true;
}

function performSpecial(w, h) {
    if (!alive(h) || w.over) return false;
    const cd = h.ai ? RULES.aiSpecialCooldownMs : RULES.specialCooldownMs;
    if (w.time - h.specialAt < cd) return false;
    h.specialAt = w.time;
    h.specialN++;
    const k = KITS[h.name], i = w.heroes.indexOf(h);
    emit(w, { t: 'spc', h: i, k: k.specialName, r: Math.round(k.specialRadius) });
    for (const e of [...w.enemies]) {
        if (dist(e, h) < k.specialRadius) damageEnemy(w, h, e, h.damage * k.specialMul, { knock: k.specialKnock ?? 12, stun: k.specialStun || 0 });
    }
    if (h.name === 'DESTINY') { // team heal + damage buff (leadership)
        for (const u of w.heroes) if (alive(u) && dist(u, h) < k.rallyRadius) { healHero(w, u, k.rallyHeal, h); u.buffUntil = w.time + k.buffMs; emit(w, { t: 'buff', h: w.heroes.indexOf(u) }) }
    }
    if (h.name === 'MARKIE') { // taunt + damage soak
        h.shieldUntil = w.time + k.shieldMs;
        for (const e of w.enemies) if (dist(e, h) < k.specialRadius * 1.5) { e.tauntBy = i; e.tauntUntil = w.time + k.tauntMs }
    }
    return true;
}

// ---------------- enemies ----------------
function pickEnemyType(w) {
    const avail = ENEMY_TYPES.filter(t => w.wave >= t.from);
    const total = avail.reduce((s, t) => s + t.weight, 0);
    let r = rng(w) * total;
    for (const t of avail) { if ((r -= t.weight) <= 0) return ENEMY_INDEX[t.key] }
    return 0;
}

function spawnEnemy(w, typeIndex = pickEnemyType(w)) {
    const t = ENEMY_TYPES[typeIndex], m = RULES.enemyMargin, side = Math.floor(rng(w) * 4);
    const x = side === 0 ? -m : side === 1 ? ARENA.width + m : ARENA.minX + rng(w) * (ARENA.maxX - ARENA.minX);
    const y = side === 2 ? -m : side === 3 ? ARENA.height + m : ARENA.minY + rng(w) * (ARENA.maxY - ARENA.minY);
    const e = { id: w.nextEnemyId++, type: typeIndex, x, y, hp: t.hp(w.wave), max: t.hp(w.wave), speed: t.speed(w.wave), dmg: Math.round(t.dmg(w.wave)), at: -1e9, kx: 0, ky: 0, stunUntil: 0, facing: -1, entered: false, tauntBy: -1, tauntUntil: 0 };
    w.enemies.push(e);
    return e;
}

const insideArena = e => e.x >= ARENA.minX && e.x <= ARENA.maxX && e.y >= ARENA.minY && e.y <= ARENA.maxY;
function keepInside(e) {
    if (!e.entered && insideArena(e)) e.entered = true;
    if (e.entered) { e.x = clamp(e.x, ARENA.minX, ARENA.maxX); e.y = clamp(e.y, ARENA.minY, ARENA.maxY) }
}

function stepEnemies(w) {
    const living = w.heroes.filter(alive);
    for (const e of w.enemies) {
        const t = ENEMY_TYPES[e.type];
        e.x += e.kx; e.y += e.ky;
        e.kx *= RULES.knockDecay; e.ky *= RULES.knockDecay;
        keepInside(e);
        if (w.time < e.stunUntil || !living.length) continue;
        let target = e.tauntUntil > w.time && alive(w.heroes[e.tauntBy]) ? w.heroes[e.tauntBy] : null;
        if (!target) { let best = Infinity; for (const h of living) { const d = dist(h, e); if (d < best) { best = d; target = h } } }
        const d = dist(target, e) || 1;
        e.facing = Math.sign(target.x - e.x) || -1;
        if (d > t.reach) {
            e.x += (target.x - e.x) / d * Math.min(e.speed, d - t.reach + 0.5);
            e.y += (target.y - e.y) / d * Math.min(e.speed, d - t.reach + 0.5);
            keepInside(e);
        } else if (w.time - e.at >= t.atkMs) {
            e.at = w.time;
            emit(w, { t: 'eatk', id: e.id, f: e.facing });
            damageHero(w, target, e.dmg, e);
        }
    }
    // Light separation so a crowd doesn't collapse into one sprite.
    const es = w.enemies;
    for (let a = 0; a < es.length; a++) for (let b = a + 1; b < es.length; b++) {
        const A = es[a], B = es[b], dx = B.x - A.x, dy = B.y - A.y, dd = Math.hypot(dx, dy), min = ENEMY_TYPES[A.type].radius + ENEMY_TYPES[B.type].radius;
        if (dd > 0.01 && dd < min) { const push = (min - dd) * 0.25 / dd; A.x -= dx * push; A.y -= dy * push; B.x += dx * push; B.y += dy * push; keepInside(A); keepInside(B) }
    }
}

// ---------------- waves ----------------
const waveSize = n => Math.min(60, 5 + 3 * n);
const spawnIntervalTicks = n => Math.max(4, 16 - n);

function startWave(w) {
    w.wave++;
    w.waveState = 'fighting';
    w.bossWave = isBossWave(w.wave); // Phase D: replace with a boss encounter
    w.toSpawn = waveSize(w.wave);
    w.spawnTimer = 0;
    w.zone = Math.floor(Math.max(0, w.wave - 1) / 15) % 4; // V19: battlefield changes every 15 waves
    emit(w, { t: 'wave', n: w.wave, size: w.toSpawn, boss: w.bossWave ? 1 : 0 });
    w.hooks.onWaveStart?.(w, w.wave);
}

function stepWaves(w) {
    if (w.waveState === 'intermission') {
        if (w.time >= w.nextWaveAt) startWave(w);
        return;
    }
    if (w.toSpawn > 0 && --w.spawnTimer <= 0 && w.enemies.length < w.maxEnemies) {
        spawnEnemy(w);
        w.toSpawn--;
        w.spawnTimer = spawnIntervalTicks(w.wave);
    }
    if (w.toSpawn === 0 && w.enemies.length === 0) {
        w.waveState = 'intermission';
        w.nextWaveAt = w.time + RULES.intermissionMs;
        for (const h of w.heroes) if (alive(h)) h.hp = Math.min(h.maxHp, h.hp + RULES.waveClearHeal);
        emit(w, { t: 'clear', n: w.wave });
        w.hooks.onWaveCleared?.(w, w.wave);
        if (w.wave % 10 === 0) w.hooks.onUpgrade?.(w, w.wave); // Phase D: V19 hero ascension every 10 waves
    }
}

// ---------------- heroes: passives, revive, AI ----------------
function stepPassives(w) {
    for (const h of w.heroes) {
        if (h.name === 'DESTINY' && alive(h) && w.time - h.healAt >= RULES.destinyAuraMs) {
            h.healAt = w.time;
            for (const u of w.heroes) if (dist(u, h) <= RULES.destinyAuraRadius) healHero(w, u, RULES.destinyAuraHeal, h);
        }
        if (h.state === 'downed') {
            const helpers = w.heroes.filter(u => u !== h && alive(u) && dist(u, h) <= RULES.reviveRadius).length;
            h.reviveMs = helpers ? h.reviveMs + TICK * Math.min(2, helpers) : Math.max(0, h.reviveMs - TICK / 2);
            if (h.reviveMs >= RULES.reviveMs) {
                h.state = 'alive';
                h.hp = Math.round(h.maxHp * RULES.reviveHpFrac);
                h.reviveMs = 0;
                emit(w, { t: 'revive', h: w.heroes.indexOf(h) });
            }
        }
    }
}

function moveToward(h, tx, ty, speed) {
    const dx = tx - h.x, dy = ty - h.y, d = Math.hypot(dx, dy) || 1, s = Math.min(speed, d);
    const ox = h.x, oy = h.y;
    h.x = clamp(h.x + dx / d * s, ARENA.minX, ARENA.maxX);
    h.y = clamp(h.y + dy / d * s, ARENA.minY, ARENA.maxY);
    if (Math.abs(h.x - ox) > 0.05) h.facing = h.x > ox ? 1 : -1;
    return Math.abs(h.x - ox) + Math.abs(h.y - oy) > 0.01;
}

// Port of V19 aiTick(): engage the nearest threat, regroup otherwise; plus revive duty (new for co-op).
function stepAI(w, h, leader) {
    h.moving = false;
    if (!alive(h)) return;
    const k = KITS[h.name], speed = h.speed * 0.83;
    let enemy = null, ed = Infinity;
    for (const e of w.enemies) { if (!e.entered) continue; const d = dist(e, h); if (d < ed) { ed = d; enemy = e } }
    const downed = w.heroes.filter(u => u !== h && u.state === 'downed').sort((a, b) => dist(a, h) - dist(b, h))[0];
    if (downed && (ed > 70 || dist(downed, h) < 30)) { // go revive if not under direct attack
        if (dist(downed, h) > RULES.reviveRadius * 0.6) h.moving = moveToward(h, downed.x + 8, downed.y, speed);
        return;
    }
    if (enemy && ed < S(380)) {
        const ideal = k.aiIdeal, dx = enemy.x - h.x;
        if (Math.abs(dx) > 3) h.facing = Math.sign(dx);
        if (ed > ideal + 8) h.moving = moveToward(h, enemy.x - Math.sign(dx || 1) * ideal * 0.7, enemy.y, speed);
        else if (h.name === 'ESPIRIT' && ed < ideal - 25) h.moving = moveToward(h, h.x - Math.sign(dx || 1) * 20, h.y + (enemy.y - h.y) * -0.2, speed * 0.66);
        if (attackTargets(w, h).length) performAttack(w, h);
        const crowd = w.enemies.filter(e => dist(e, h) < k.specialRadius * 0.8).length;
        const hurtAlly = h.name === 'DESTINY' && w.heroes.some(u => alive(u) && u.hp < u.maxHp * 0.4 && dist(u, h) < k.rallyRadius);
        if (crowd >= 3 || (hurtAlly && crowd >= 1)) performSpecial(w, h);
        return;
    }
    if (leader && leader !== h) {
        const i = w.heroes.indexOf(h), tx = leader.x + (i % 2 ? 55 : -55), ty = leader.y + ((i % 3) - 1) * 50;
        if (Math.hypot(tx - h.x, ty - h.y) > 20 && dist(leader, h) > 65) h.moving = moveToward(h, tx, ty, AI_FOLLOW_SPEED);
    }
}
const AI_FOLLOW_SPEED = 2.6; // unchanged from the movement prototype

// ---------------- main step ----------------
// One 50 ms server tick. Human heroes have already moved (inputs are applied on arrival);
// their latched attack/special intents are resolved here so the server alone decides outcomes.
function step(w) {
    w.events = [];
    if (w.over) { w.tick++; w.time += TICK; return w }
    w.tick++;
    w.time += TICK;
    const leader = w.heroes.find(h => !h.ai && alive(h)) || w.heroes.find(alive);
    for (const h of w.heroes) {
        if (h.ai) stepAI(w, h, leader);
        else {
            if (h.wantAttack) performAttack(w, h);
            if (h.wantSpecial) performSpecial(w, h);
        }
        h.wantAttack = h.wantSpecial = false;
    }
    stepEnemies(w);
    stepPassives(w);
    stepWaves(w);
    if (w.heroes.every(h => h.state === 'downed')) {
        w.over = true;
        emit(w, { t: 'over', wave: w.wave, score: w.score, kills: w.kills });
    }
    return w;
}

// Compact per-tick snapshot. Enemies are arrays: [id, type, x, y, hp%, facing, stunned].
function snapshot(w) {
    return {
        tick: w.tick, time: w.time, zone: w.zone, wave: w.wave, ws: w.waveState === 'fighting' ? 1 : 0,
        next: w.waveState === 'intermission' ? Math.max(0, w.nextWaveAt - w.time) : 0, left: w.toSpawn + w.enemies.length,
        score: w.score, kills: w.kills, combo: w.time < w.comboUntil ? w.combo : 0, over: w.over ? 1 : 0,
        heroes: w.heroes.map(h => ({
            name: h.name, x: h.x, y: h.y, facing: h.facing, moving: h.moving, controller: h.controller, seq: h.seq,
            hp: h.hp, maxHp: h.maxHp, state: h.state === 'alive' ? 0 : 1, rv: h.state === 'downed' ? Math.round(h.reviveMs / RULES.reviveMs * 100) : 0,
            attackN: h.attackN, specialN: h.specialN, buff: w.time < h.buffUntil ? 1 : 0, shield: w.time < h.shieldUntil ? 1 : 0,
            cd: Math.max(0, Math.round((h.specialAt + RULES.specialCooldownMs - w.time) / 100)) // special cooldown, 0.1 s
        })),
        enemies: w.enemies.map(e => [e.id, e.type, Math.round(e.x), Math.round(e.y), Math.max(0, Math.round(e.hp / e.max * 100)), e.facing, w.time < e.stunUntil ? 1 : 0]),
        ev: w.events,
    };
}

module.exports = { RULES, ENEMY_TYPES, ENEMY_INDEX, KITS, createBattle, step, snapshot, spawnEnemy, performAttack, performSpecial, damageHero, attackTargets, isBossWave, waveSize, critChance, damageTakenMul, inArc };
