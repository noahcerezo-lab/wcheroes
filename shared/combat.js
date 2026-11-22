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
const LEVELS = require('./levelup-table.js');

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
    // Critical hits (rolled on the server for every hit): 14% base, x1.85 damage. FURY and SQUAD
    // SYNERGY add to the chance. Consecutive crits by the same hero build a Critical Chain.
    critBase: 0.14, critMul: 1.85,
    // LEVEL UP: clearing every 10th wave (10, 20, 30...) levels up every living hero (human and AI) and fully
    // heals them. Stats per level come from shared/levelup-table.js (Oracle's soft-capped curve: HP, damage,
    // move speed, attack cooldown, special-damage scale, crit growth on top of the 14% base, capped at 45%).
    // Downed heroes miss that level-up (they are not "living"); they keep their current level.
    levelEvery: 10,
    espiritRangeMul: 2, // Espirit's arrow reach: about double V19's (Noah's brief, milestone 2)
    // Power-ups: one glowing pickup appears every 10-17 s during a run (max 2 on the field, each lasts
    // 15 s). A living hero collects it by walking over it; the server checks the distance.
    pickupEveryMs: [10000, 17000], pickupLifeMs: 15000, pickupMax: 2, pickupRadius: 26,
    healFrac: 0.32, // HEAL: +32% max HP
    furyMs: 10500, furyCrit: 0.25, // FURY: +25% crit chance (14% -> 39%)
    hasteMs: 10500, hasteSpeedMul: 1.5, hasteCooldownMul: 0.65, // HASTE: +50% move speed, attacks 35% sooner
    wardMs: 11000, wardMul: 0.5, // WARD: incoming damage halved
    // SQUAD SYNERGY: when the squad has AI teammates, any pickup also gives every living hero +12% crit for 6.5 s.
    synergyMs: 6500, synergyCrit: 0.12,
    // Three-hit attack chain (server-timed): a swing within cooldown + chainWindowMs of the previous
    // one continues the chain; the 3rd hit is a finisher, then a short recovery before the next swing.
    chainWindowMs: 450, finisherDamageMul: 1.6, finisherKnockMul: 1.8, finisherRangeMul: 1.15, finisherRecoveryMul: 0.6,
    // Basic hits push enemies 40% further than V19 so every blow visibly lands (Noah's iPhone notes: 'almost no knockback').
    basicKnockMul: 1.4,
    knockPerTick: 2.338 / 1.5, knockDecay: Math.pow(0.76, 3), // V19 kx decays x0.76 per frame
    enemyMargin: S(85), // spawn distance outside the arena
    maxEnemies: 24, // cap on enemies alive (bandwidth + readability)
    intermissionMs: 3000,
    waveClearHeal: 25, // V19 heals 25 HP on wave-up
    downedHp: 0,
};

// Enemy types (art: Draper's /workspace/wcheroes-design/enemies.md). The acolyte is V19's armored
// swordsman (hp 30+8w, speed 1+0.1w per frame, 7+w damage every 850 ms); the warden is new for co-op.
// No projectile enemies (Noah removed the Lantern Wisp and Tomoe Archer): every threat is up close.
//   kind 'melee': walks to `reach`, telegraphs for `windMs`, then strikes if the hero is still in reach.
//   kind 'slam': heavy, telegraphs longest, then hits every hero within `slamR` (shockwave).
// `weight(wave)` is the spawn share; wardens ramp from ~16% at wave 3 to 35% so later waves stay heavy.
const ENEMY_TYPES = [
    { key: 'acolyte', kind: 'melee', from: 1, weight: () => 1, hp: w => 30 + 8 * w, speed: w => Math.min(5.2, (1 + 0.1 * w) * 2), dmg: w => 7 + w, reach: S(29) + 3, atkMs: 850, windMs: 150, knockResist: 0, radius: 12, points: 1 },
    { key: 'warden', kind: 'slam', from: 3, weight: w => Math.min(0.54, (0.1 + 0.03 * w) / (0.9 - 0.03 * w)), hp: w => 90 + 22 * w, speed: w => Math.min(3.4, (0.7 + 0.05 * w) * 2), dmg: w => 14 + 2 * w, reach: S(40) + 3, slamR: 55, atkMs: 1600, windMs: 350, knockResist: 0.6, radius: 18, points: 3 },
    // Boss-only type. Never selected by the normal weighted spawner; one appears every tenth wave.
    { key: 'voidEmperor', kind: 'slam', from: Infinity, weight: () => 0, hp: w => 650 + 55 * w, speed: w => Math.min(3.6, 2.1 + w * 0.035), dmg: w => 17 + Math.round(w * 0.7), reach: 66, slamR: 90, atkMs: 2300, windMs: 900, knockResist: 0.95, radius: 33, points: 20 },
];
const ENEMY_INDEX = Object.fromEntries(ENEMY_TYPES.map((t, i) => [t.key, i]));

// Per-hero combat kit. Base numbers come from V19 (heroes-config v19 block); shapes from V19 attack()/special().
const KITS = {
    NOAH: { attack: 'crescent', arc: 1.12, knock: 15, stun: 0, specialName: 'ARCANE NOVA', specialRadius: S(210), specialMul: 3, specialKnock: 15, aiIdeal: S(100) },
    DESTINY: { attack: 'captain', arc: 0.95, knock: 10, stun: 650, specialName: 'RALLY STRIKE', specialRadius: S(180), specialMul: 3, specialStun: 1000, rallyHeal: 35, rallyRadius: S(190), buffMs: 5000, buffMul: 1.25, aiIdeal: S(58) },
    MARKIE: { attack: 'cleave', front: 0.55, frontMul: 1.5, sideMul: 0.7, knock: 19, stun: 140, specialName: 'EARTHSHATTER', specialRadius: S(160), specialMul: 4, specialStun: 600, tauntMs: 4000, shieldMs: 3000, shieldMul: 0.45, aiIdeal: S(48) },
    ESPIRIT: { attack: 'arrow', arc: 0.24, knock: 10, stun: 0, specialName: 'ARROW STORM', specialRadius: S(340), specialMul: 3, aiIdeal: 150 },
    SMITESH: { attack: 'spirit', arc: 0.48, knock: 7, stun: 0, specialName: 'SPIRIT TOTEM', specialRadius: S(200), specialMul: 1.5, aiIdeal: 125 },
    DONNA: { attack: 'nature', arc: 0.5, knock: 6, stun: 0, specialName: 'WILDHEART AWAKENING', specialRadius: S(180), specialMul: 1.2, aiIdeal: 125 },
    DAVE: { attack: 'fourfold', arc: 1.4, knock: 10, stun: 70, specialName: 'BLADE CYCLONE', specialRadius: S(165), specialMul: 3.2, specialKnock: 24, aiIdeal: 48 },
};

// Sheet stats -> small modifiers. LUK = crit chance, VIT = damage taken.
// Crit chance for a hero right now: 14% base + active boosts (FURY, SQUAD SYNERGY; see power-ups).
const critChance = (h, w) => Math.min(0.95, Math.min(LEVELS.CRIT_CAP, RULES.critBase + (h && h.levelCrit || 0)) + (w && h ? critBonus(w, h) : 0));
function critBonus(w, h) { return (w.time < (h.furyUntil || 0) ? RULES.furyCrit : 0) + (w.time < (h.synergyUntil || 0) ? RULES.synergyCrit : 0) }
const PICKUP_KINDS = ['heal', 'fury', 'haste', 'ward']; // index = snapshot kind
// Move speed right now (HASTE: x1.5). Server input handling, AI and client prediction all use this.
const moveSpeed = (w, h) => h.speed * (w.time < (h.hasteUntil || 0) ? RULES.hasteSpeedMul : 1);
const damageTakenMul = st => clamp(1 - (st.VIT - 5) * 0.04, 0.7, 1.2); // Markie (VIT 9): 0.84

function isBossWave(n) { return n > 0 && n % RULES.levelEvery === 0 } // Boss encounter precedes each 10-wave level-up

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
    const selected = (opts.heroIndices || [0, 1, 2, 3]).slice(0, 4);
    if (selected.length !== 4 || new Set(selected).size !== 4 || selected.some(i => !Number.isInteger(i) || i < 0 || i >= ROSTER.HEROES.length)) throw new Error('Battle requires four distinct valid hero indices');
    const world = {
        tick: 0, time: 0, seed: (opts.seed >>> 0) || 1, zone: 0,
        wave: 0, waveState: 'intermission', nextWaveAt: opts.firstWaveDelayMs ?? RULES.intermissionMs,
        toSpawn: 0, spawnTimer: 0, nextEnemyId: 1,
        score: 0, kills: 0, combo: 0, comboUntil: 0, over: false,
        maxEnemies: opts.maxEnemies || RULES.maxEnemies,
        enemyDamageMul: opts.enemyDamageMul || 1, // difficulty knob (server env ENEMY_DAMAGE_MUL)
        heroes: selected.map((heroIndex, i) => { const cfg = ROSTER.HEROES[heroIndex]; return ({
            name: cfg.name, x: spawn[i][0], y: spawn[i][1], facing: i % 2 ? -1 : 1, aim: i % 2 ? 4 : 0, vx: 0, vy: 0, moving: false, chain: 0,
            hp: cfg.v19.hp, maxHp: cfg.v19.hp, damage: cfg.v19.damage, range: S(cfg.v19.range) * (cfg.name === 'ESPIRIT' ? RULES.espiritRangeMul : 1), cool: cfg.v19.cool,
            speed: SIM.speedFromV19(cfg.v19.speed), stats: cfg.stats, level: 1, masteryTier: 0,
            base: { hp: cfg.v19.hp, damage: cfg.v19.damage, speed: SIM.speedFromV19(cfg.v19.speed) },
            state: 'alive', reviveMs: 0, attackAt: -1e9, specialAt: -1e9, healAt: 0, attackN: 0, specialN: 0, destinyComboHits: 0, destinyComboHealAt: -1e9, weaponFlow: 0, weaponFlowAt: -1e9, shamanHealAt: -1e9, totemUntil: 0, totemAt: -1e9, druidHealAt: -1e9, animalUntil: 0, animalAt: -1e9, animalKind: 0, animalBoostUntil: 0,
            buffUntil: 0, shieldUntil: 0, furyUntil: 0, hasteUntil: 0, wardUntil: 0, synergyUntil: 0, awakenUntil: 0, critChain: 0, wantAttack: false, wantSpecial: false, ai: true, controller: null, seq: 0,
        }); }),
        enemies: [],
        pickups: [], nextPickupId: 1, nextPickupAt: null, // set when the first wave starts
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
    let d = base * (w.time < hero.buffUntil ? KITS.DESTINY.buffMul : 1) * (w.time < (hero.awakenUntil || 0) ? 1.25 : 1);
    const crit = rng(w) < critChance(hero, w);
    if (crit) d *= RULES.critMul;
    hero.critChain = crit ? (hero.critChain || 0) + 1 : 0; // consecutive crits; any normal hit breaks it
    d = Math.max(1, Math.round(d));
    e.hp -= d;
    const t = ENEMY_TYPES[e.type];
    // Knockback along the attack direction (8-way aim), or straight away from the hero by default.
    let kv = o.dirVec;
    if (!kv) { const dx = e.x - hero.x, dy = e.y - hero.y, dd = Math.hypot(dx, dy); kv = dd > 0.5 ? { x: dx / dd, y: dy / dd } : { x: hero.facing, y: 0 } }
    const kb = (o.knock ?? 11) * RULES.knockPerTick * (1 - t.knockResist);
    e.kx = kv.x * kb;
    e.ky = kv.y * kb + (rng(w) - 0.5) * 2 * RULES.knockPerTick * (1 - t.knockResist);
    if (o.stun) e.stunUntil = Math.max(e.stunUntil, w.time + o.stun);
    const ev = { t: 'hit', id: e.id, d, c: crit ? 1 : 0, h: w.heroes.indexOf(hero), x: Math.round(e.x), y: Math.round(e.y) };
    if (o.finisher) ev.f = 1;
    if (crit) ev.cc = hero.critChain;
    emit(w, ev);
    if (e.hp <= 0) killEnemy(w, hero, e);
}

function killEnemy(w, hero, e) {
    w.enemies.splice(w.enemies.indexOf(e), 1);
    e.dead = true;
    w.combo = w.time < w.comboUntil ? Math.min(20, w.combo + 1) : 1;
    w.comboUntil = w.time + RULES.comboWindowMs;
    const mult = Math.min(5, 1 + Math.floor(w.combo / 4));
    const pts = 10 * Math.max(1, w.wave) * mult * ENEMY_TYPES[e.type].points;
    w.score += pts;
    w.kills++;
    emit(w, { t: 'kill', id: e.id, h: w.heroes.indexOf(hero), x: Math.round(e.x), y: Math.round(e.y), combo: w.combo, mult, pts });
}

function damageHero(w, h, amount, by) {
    if (!alive(h) || w.over) return;
    let d = amount * damageTakenMul(h.stats);
    if (w.time < h.shieldUntil) d *= KITS.MARKIE.shieldMul;
    if (w.time < h.wardUntil) d *= RULES.wardMul;
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

// Aim as a unit vector: 8 directions from the last movement (shared-sim stepHero) or the AI's target.
const aimOf = h => SIM.DIR8[h.aim ?? (h.facing === -1 ? 4 : 0)];
// V19 inArc(), generalised from left/right to the hero's 8-way aim. y is stretched by 1.2 for V19's
// fake perspective, on both the offset and the aim, so the cone looks the same in every direction.
function inArc(h, e, range, half) {
    const dx = e.x - h.x, dy = (e.y - h.y) * 1.2, d = Math.hypot(dx, dy);
    if (d > range || d < 0.5) return d < 0.5;
    const a = aimOf(h), ay = a.y * 1.2, al = Math.hypot(a.x, ay);
    return (dx * a.x + dy * ay) / (d * al) >= Math.cos(half);
}
const inReach = (h, e, range) => Math.hypot(e.x - h.x, (e.y - h.y) * 1.2) <= range;

// Targets a basic attack would hit right now (used by attack + AI decisions). `rangeMul` widens the
// reach for the chain finisher.
function attackTargets(w, h, rangeMul = 1) {
    const k = KITS[h.name], range = h.range * rangeMul;
    if (h.name === 'ESPIRIT' || h.name === 'SMITESH' || h.name === 'DONNA') {
        const lane = w.enemies.filter(e => inArc(h, e, range, k.arc)).sort((a, b) => dist(a, h) - dist(b, h));
        return lane.slice(0, 1); // single arrow, nearest in the lane
    }
    if (h.name === 'MARKIE' || h.name === 'DAVE') return w.enemies.filter(e => inReach(h, e, range));
    return w.enemies.filter(e => inArc(h, e, range, k.arc));
}

// Next chain stage (0, 1, 2) if the hero swung now. The 3rd swing (stage 2) is the finisher.
function nextChainStage(w, h, cool) {
    return h.attackN > 0 && h.chain < 2 && w.time - h.attackAt <= cool + RULES.chainWindowMs ? h.chain + 1 : 0;
}

function performAttack(w, h) {
    if (!alive(h) || w.over) return false;
    const flow = h.name === 'DAVE' ? Math.max(.72, 1 - Math.min(5, h.weaponFlow || 0) * .055) : 1;
    const cool = (h.ai ? h.cool * RULES.aiAttackCooldownMul : h.cool) * flow * (w.time < h.hasteUntil ? RULES.hasteCooldownMul : 1);
    const recovery = h.chain === 2 ? cool * RULES.finisherRecoveryMul : 0; // brief pause after a finisher
    if (w.time - h.attackAt < cool + recovery) return false;
    const stage = nextChainStage(w, h, cool + recovery);
    const fin = stage === 2;
    h.chain = stage;
    h.attackAt = w.time;
    h.attackN++;
    const k = KITS[h.name];
    const targets = attackTargets(w, h, fin ? RULES.finisherRangeMul : 1);
    const a = aimOf(h);
    // Mastery volleys acquire additional distinct targets in a wider arrow fan.
    if (h.name === 'ESPIRIT' && h.masteryTier > 0) {
        const count = Math.min(3, 1 + h.masteryTier);
        const candidates = w.enemies.filter(e => e.hp > 0 && !targets.includes(e) &&
            inArc(h, e, h.range * (fin ? RULES.finisherRangeMul : 1), 0.68))
            .sort((x, y) => Math.hypot(x.x - h.x, x.y - h.y) - Math.hypot(y.x - h.x, y.y - h.y));
        targets.push(...candidates.slice(0, Math.max(0, count - targets.length)));
    }
    if (h.name === 'DAVE' && w.time - h.weaponFlowAt > 1300) h.weaponFlow = 0;
    // No 'atk' event: clients animate swings from attackN + chain stage in the snapshot (saves bandwidth).
    let connectedHits = 0;
    for (const e of [...targets]) {
        let dmg = h.damage;
        if (h.name === 'MARKIE') dmg = Math.round(h.damage * (inArc(h, e, h.range * 1.2, k.front) ? k.frontMul : k.sideMul));
        if (h.name === 'DAVE') dmg = Math.round(h.damage * 1.12);
        if (fin) dmg = Math.round(dmg * RULES.finisherDamageMul);
        const tier = Math.min(2, h.masteryTier || 0);
        const stun = h.name === 'MARKIE' ? k.stun + tier * 130
            : h.name === 'DESTINY' ? k.stun + tier * 90 : k.stun;
        const knock = k.knock * RULES.basicKnockMul * (fin ? RULES.finisherKnockMul : 1)
            * (h.name === 'NOAH' ? 1 + tier * .18 : 1);
        damageEnemy(w, h, e, dmg, { knock, stun, dirVec: h.name === 'MARKIE' ? null : a, finisher: fin });
        connectedHits++;
        if (h.name === 'DAVE') { h.weaponFlow = Math.min(5, (h.weaponFlow || 0) + 1); h.weaponFlowAt = w.time; }
    }
    // Destiny: every third successful basic-attack swing heals her for 5% max HP.
    // Multiple enemies hit by a sweep count as one swing, not multiple triggers.
    // The 1.5s internal cooldown prevents fast attack-speed buffs from spamming heals.
    if (h.name === 'DESTINY' && connectedHits > 0) {
        h.destinyComboHits = (h.destinyComboHits || 0) + 1;
        if (h.destinyComboHits >= 3 && w.time - h.destinyComboHealAt >= 1500) {
            h.destinyComboHits = 0;
            h.destinyComboHealAt = w.time;
            const n = healHero(w, h, Math.max(1, Math.round(h.maxHp * .05)), h);
            if (n > 0) emit(w, { t: 'comboHeal', h: w.heroes.indexOf(h), n });
        }
    }
    return true;
}

function performSpecial(w, h) {
    if (!alive(h) || w.over) return false;
    const cd = h.ai ? RULES.aiSpecialCooldownMs : RULES.specialCooldownMs;
    if (w.time - h.specialAt < cd) return false;
    h.specialAt = w.time;
    h.specialN++;
    // Every ultimate grants a short anime-style awakening. Damage stays server-authoritative.
    h.awakenUntil = w.time + 8000;
    const k = KITS[h.name], i = w.heroes.indexOf(h);
    emit(w, { t: 'spc', h: i, k: k.specialName, r: Math.round(k.specialRadius) });
    emit(w, { t: 'awaken', h: i, until: h.awakenUntil });
    for (const e of [...w.enemies]) {
        if (dist(e, h) < k.specialRadius) damageEnemy(w, h, e, h.damage * k.specialMul * (h.skillScale || 1), { knock: k.specialKnock ?? 12, stun: k.specialStun || 0 });
    }
    if (h.name === 'DESTINY') { // team heal + damage buff (leadership)
        for (const u of w.heroes) if (alive(u) && dist(u, h) < k.rallyRadius) { healHero(w, u, k.rallyHeal, h); u.buffUntil = w.time + k.buffMs; emit(w, { t: 'buff', h: w.heroes.indexOf(u) }) }
    }
    if (h.name === 'DAVE') emit(w, { t: 'cyclone', h: i, x: Math.round(h.x), y: Math.round(h.y) });
    if (h.name === 'DONNA') {
        // Her permanent companion is empowered for eight seconds; never creates a player slot.
        h.animalBoostUntil = w.time + 8000;
        for (const u of w.heroes) if (alive(u) && dist(u, h) < 145) {
            healHero(w, u, 22, h);
            u.buffUntil = Math.max(u.buffUntil || 0, w.time + 5000);
        }
        emit(w, { t: 'druidAwaken', h: i, kind: Math.min(3, Math.floor(((h.level || 1) - 1) / 10)), ms: 8000 });
    }
    if (h.name === 'SMITESH') {
        h.totemUntil = w.time + 6000;
        h.totemAt = w.time - 1000;
        emit(w, { t: 'totem', h: i, x: Math.round(h.x), y: Math.round(h.y), ms: 6000 });
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
    const total = avail.reduce((s, t) => s + t.weight(w.wave), 0);
    let r = rng(w) * total;
    for (const t of avail) { if ((r -= t.weight(w.wave)) <= 0) return ENEMY_INDEX[t.key] }
    return 0;
}

function spawnEnemy(w, typeIndex = pickEnemyType(w)) {
    // Off-screen entry: mostly the left/right edges, sometimes from below. Not from the top: the top of
    // the 960x540 scene is the temple backdrop, so enemies there would appear to walk out of the sky.
    const t = ENEMY_TYPES[typeIndex], m = RULES.enemyMargin, r = rng(w), side = r < 0.4 ? 0 : r < 0.8 ? 1 : 3;
    const x = side === 0 ? -m : side === 1 ? ARENA.width + m : ARENA.minX + rng(w) * (ARENA.maxX - ARENA.minX);
    const y = side === 3 ? ARENA.height + m : ARENA.minY + 20 + rng(w) * (ARENA.maxY - ARENA.minY - 20);
    const e = { id: w.nextEnemyId++, type: typeIndex, x, y, hp: t.hp(w.wave), max: t.hp(w.wave), speed: t.speed(w.wave), dmg: Math.round(t.dmg(w.wave) * w.enemyDamageMul), at: -1e9, windUntil: 0, strikeAt: -1e9, aim: null, kx: 0, ky: 0, stunUntil: 0, facing: -1, entered: false, tauntBy: -1, tauntUntil: 0 };
    if (typeIndex === ENEMY_INDEX.voidEmperor) {
        e.x = ARENA.width / 2; e.y = ARENA.minY + 55; e.entered = true;
        e.entranceUntil = w.time + 1400; e.attackCount = 0; e.attackMode = 'slam';
        emit(w, { t: 'boss:enter', id: e.id, x: Math.round(e.x), y: Math.round(e.y), name: 'VOID EMPEROR' });
    }
    w.enemies.push(e);
    return e;
}

const insideArena = e => e.x >= ARENA.minX && e.x <= ARENA.maxX && e.y >= ARENA.minY && e.y <= ARENA.maxY;
function keepInside(e) {
    if (!e.entered && insideArena(e)) e.entered = true;
    if (e.entered) { e.x = clamp(e.x, ARENA.minX, ARENA.maxX); e.y = clamp(e.y, ARENA.minY, ARENA.maxY) }
    else { const m = RULES.enemyMargin + 10; e.x = clamp(e.x, -m, ARENA.width + m); e.y = clamp(e.y, -m, ARENA.height + m) } // still walking in: never knocked far away
}

function strike(w, e, t, target) {
    e.strikeAt = w.time;
    if (e.type === ENEMY_INDEX.voidEmperor && e.attackMode === 'target') {
        const aim = e.aim;
        if (aim) {
            emit(w, { t: 'slam', id: e.id, x: Math.round(aim.x), y: Math.round(aim.y), r: 58 });
            for (const h of w.heroes) if (alive(h) && Math.hypot(h.x - aim.x, h.y - aim.y) <= 58) damageHero(w, h, e.dmg, e);
        }
        e.aim = null;
        return;
    }
    if (t.kind === 'slam') {
        emit(w, { t: 'slam', id: e.id, x: Math.round(e.x), y: Math.round(e.y), r: t.slamR });
        for (const h of w.heroes) if (alive(h) && dist(h, e) <= t.slamR) damageHero(w, h, e.dmg, e);
        return;
    }
    if (alive(target) && dist(target, e) <= t.reach * 1.35) damageHero(w, target, e.dmg, e); // stepped away during the windup = dodged
}

function stepEnemies(w) {
    const living = w.heroes.filter(alive);
    for (const e of w.enemies) {
        const t = ENEMY_TYPES[e.type];
        e.x += e.kx; e.y += e.ky;
        e.kx *= RULES.knockDecay; e.ky *= RULES.knockDecay;
        keepInside(e);
        if (w.time < e.stunUntil) { e.windUntil = 0; e.aim = null; continue } // stuns cancel a windup
        if (e.entranceUntil && w.time < e.entranceUntil) continue; // cinematic entrance, sim continues
        if (!living.length) continue;
        let target = e.tauntUntil > w.time && alive(w.heroes[e.tauntBy]) ? w.heroes[e.tauntBy] : null;
        if (!target) { let best = Infinity; for (const h of living) { const d = dist(h, e); if (d < best) { best = d; target = h } } }
        if (e.windUntil) { // telegraphing: hold still, then resolve
            if (w.time >= e.windUntil) { e.windUntil = 0; strike(w, e, t, target) }
            continue;
        }
        const d = dist(target, e) || 1;
        e.facing = Math.sign(target.x - e.x) || -1;
        const want = t.reach, inRange = d <= t.reach;
        if (d > want) {
            e.x += (target.x - e.x) / d * Math.min(e.speed, d - want + 0.5);
            e.y += (target.y - e.y) / d * Math.min(e.speed, d - want + 0.5);
            keepInside(e);
        }
        if (e.type === ENEMY_INDEX.voidEmperor && !e.phaseTwo && e.hp <= e.max * .5) {
            e.phaseTwo = true;
            e.windUntil = 0;
            e.aim = null;
            e.at = w.time;
            emit(w, { t: 'boss:phase', id: e.id, x: Math.round(e.x), y: Math.round(e.y), phase: 2 });
        }
        const bossCooldown = e.type === ENEMY_INDEX.voidEmperor && e.phaseTwo ? t.atkMs * .78 : t.atkMs;
        if (e.type === ENEMY_INDEX.voidEmperor && w.time - e.at >= bossCooldown && d <= 250) {
            e.at = w.time;
            e.attackCount = (e.attackCount || 0) + 1;
            e.attackMode = e.attackCount % 2 === 0 ? 'target' : 'slam';
            e.windUntil = w.time + (e.attackMode === 'target' ? (e.phaseTwo ? 850 : 1100) : (e.phaseTwo ? Math.round(t.windMs * .8) : t.windMs));
            if (e.attackMode === 'slam') emit(w, { t: 'boss:warning', id: e.id, x: Math.round(e.x), y: Math.round(e.y), r: t.slamR, ms: e.windUntil - w.time });
            if (e.attackMode === 'target') {
                e.aim = { x: Math.round(target.x), y: Math.round(target.y) };
                emit(w, { t: 'boss:target', id: e.id, x: e.aim.x, y: e.aim.y, r: 58, ms: e.windUntil - w.time });
            }
        } else if (e.type !== ENEMY_INDEX.voidEmperor && inRange && w.time - e.at >= t.atkMs) { e.at = w.time; e.windUntil = w.time + t.windMs }
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
    w.bossWave = isBossWave(w.wave);
    w.toSpawn = w.bossWave ? 1 : waveSize(w.wave);
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
        spawnEnemy(w, w.bossWave ? ENEMY_INDEX.voidEmperor : pickEnemyType(w));
        w.toSpawn--;
        w.spawnTimer = spawnIntervalTicks(w.wave);
    }
    if (w.toSpawn === 0 && w.enemies.length === 0) {
        w.waveState = 'intermission';
        w.nextWaveAt = w.time + RULES.intermissionMs;
        for (const h of w.heroes) if (alive(h)) h.hp = Math.min(h.maxHp, h.hp + RULES.waveClearHeal);
        emit(w, { t: 'clear', n: w.wave });
        w.hooks.onWaveCleared?.(w, w.wave);
        // Level every two cleared waves starting at wave 4:
        // wave 10 -> Lv 5, wave 20 -> Lv 10, wave 40 -> Lv 20.
        // Keep RULES.levelEvery=10 for boss encounters.
        if (w.wave >= 4 && w.wave % 2 === 0) {
            levelUp(w);
            w.hooks.onUpgrade?.(w, w.wave);
        }
    }
}

// LEVEL UP (every second cleared wave from wave 4): living heroes gain a level, stats and a full heal.
function levelUp(w) {
    const got = [];
    w.heroes.forEach((h, i) => {
        if (!alive(h)) return;
        h.level = (h.level || 1) + 1;
        h.masteryTier = Math.min(2, Math.floor(h.level / 10));
        const L = LEVELS.levelStats(h.name, h.level);
        h.maxHp = L.hp; h.damage = L.damage; h.speed = L.speed; h.cool = L.cool;
        h.skillScale = L.skill; h.levelCrit = L.crit;
        h.hp = h.maxHp;
        got.push(i);
    });
    if (got.length) emit(w, { t: 'lvl', all: got, n: w.wave, lv: Math.max(...got.map(i => w.heroes[i].level)), mastery: Math.max(0, ...got.filter(i => w.heroes[i].level % 10 === 0).map(i => w.heroes[i].masteryTier)) });
}

// ---------------- power-ups ----------------
function stepPickups(w) {
    if (w.wave < 1) return; // nothing before the first wave
    const [lo, hi] = RULES.pickupEveryMs;
    if (w.nextPickupAt === null) w.nextPickupAt = w.time + lo + rng(w) * (hi - lo);
    for (let j = w.pickups.length - 1; j >= 0; j--) if (w.time >= w.pickups[j].until) w.pickups.splice(j, 1);
    if (w.time >= w.nextPickupAt) {
        w.nextPickupAt = w.time + lo + rng(w) * (hi - lo);
        if (w.pickups.length < RULES.pickupMax) {
            const kind = Math.floor(rng(w) * PICKUP_KINDS.length);
            const p = { id: w.nextPickupId++, kind, x: Math.round(ARENA.minX + 60 + rng(w) * (ARENA.maxX - ARENA.minX - 120)), y: Math.round(ARENA.minY + 40 + rng(w) * (ARENA.maxY - ARENA.minY - 70)), at: w.time, until: w.time + RULES.pickupLifeMs };
            w.pickups.push(p);
            emit(w, { t: 'pspawn', id: p.id, k: kind, x: p.x, y: p.y });
        }
    }
    for (let j = w.pickups.length - 1; j >= 0; j--) {
        const p = w.pickups[j];
        let best = null, bd = RULES.pickupRadius;
        for (const h of w.heroes) if (alive(h)) { const d = dist(h, p); if (d <= bd) { bd = d; best = h } }
        if (best) { w.pickups.splice(j, 1); collectPickup(w, best, p) }
    }
}

function collectPickup(w, h, p) {
    const i = w.heroes.indexOf(h), kind = PICKUP_KINDS[p.kind];
    if (kind === 'heal') healHero(w, h, Math.round(h.maxHp * RULES.healFrac), h);
    else if (kind === 'fury') h.furyUntil = w.time + RULES.furyMs;
    else if (kind === 'haste') h.hasteUntil = w.time + RULES.hasteMs;
    else if (kind === 'ward') h.wardUntil = w.time + RULES.wardMs;
    emit(w, { t: 'pick', id: p.id, k: p.kind, h: i, x: p.x, y: p.y });
    // SQUAD SYNERGY: only when playing alongside AI teammates.
    if (w.heroes.some(u => u.ai)) {
        const got = [];
        w.heroes.forEach((u, j) => { if (alive(u)) { u.synergyUntil = w.time + RULES.synergyMs; got.push(j) } });
        emit(w, { t: 'syn', h: i, all: got });
    }
}

// ---------------- heroes: passives, revive, AI ----------------
function stepPassives(w) {
    for (const h of w.heroes) {
        if (h.name === 'DESTINY' && alive(h) && w.time - h.healAt >= RULES.destinyAuraMs) {
            h.healAt = w.time;
            for (const u of w.heroes) if (dist(u, h) <= RULES.destinyAuraRadius) healHero(w, u, RULES.destinyAuraHeal, h);
        }
        if (h.name === 'DONNA' && alive(h)) {
            if (w.time - (h.druidHealAt || -1e9) >= 4500) {
                h.druidHealAt = w.time;
                const allies = w.heroes.filter(u => alive(u) && u.hp < u.maxHp && dist(u, h) < 145);
                allies.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
                if (allies.length) healHero(w, allies[0], 9, h);
            }
            // Permanent companion, evolves automatically every ten levels.
            const kind = Math.min(3, Math.floor(((h.level || 1) - 1) / 10));
            h.animalKind = kind;
            const intervals = [1500, 1300, 1800, 1600];
            if (w.time - h.animalAt >= intervals[kind]) {
                h.animalAt = w.time;
                const reach = [150, 170, 145, 195][kind];
                const targets = w.enemies.filter(e => e.hp > 0 && dist(e, h) < reach).sort((a, b) => dist(a, h) - dist(b, h));
                const boosted = w.time < (h.animalBoostUntil || 0);
                for (const e of targets.slice(0, kind === 2 || kind === 3 ? 2 : 1))
                    damageEnemy(w, h, e, [4, 7, 11, 14][kind] * (boosted ? 2 : 1), { knock: kind === 2 ? 12 : 4 });
                if (kind === 3) for (const u of w.heroes) if (alive(u) && dist(u, h) < 115) healHero(w, u, 3, h);
                if (targets.length) for (const e of targets.slice(0, kind === 2 || kind === 3 ? 2 : 1)) emit(w, { t: 'druidAnimal', h: w.heroes.indexOf(h), kind, x: Math.round(h.x), y: Math.round(h.y), tx: Math.round(e.x), ty: Math.round(e.y), boosted });
            }
        }
        if (h.name === 'SMITESH' && alive(h)) {
            if (w.time - h.shamanHealAt >= 4500) {
                h.shamanHealAt = w.time;
                const allies = w.heroes.filter(u => alive(u) && u.hp < u.maxHp && dist(u, h) <= 145);
                allies.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
                if (allies.length) {
                    const target = allies[0], n = healHero(w, target, 10, h);
                    if (n) emit(w, { t: 'shamanHeal', h: w.heroes.indexOf(target), from: w.heroes.indexOf(h), n });
                }
            }
            if (w.time < h.totemUntil && w.time - h.totemAt >= 1000) {
                h.totemAt = w.time;
                for (const u of w.heroes) if (alive(u) && dist(u, h) <= 135) healHero(w, u, 7, h);
                for (const e of [...w.enemies]) if (dist(e, h) <= 95) damageEnemy(w, h, e, Math.round(h.damage * .45), { knock: 3 });
                emit(w, { t: 'totemPulse', h: w.heroes.indexOf(h), x: Math.round(h.x), y: Math.round(h.y) });
            }
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
    if (Math.abs(h.x - ox) + Math.abs(h.y - oy) > 0.05) h.aim = SIM.dir8Of(h.x - ox, h.y - oy);
    h.vx = h.x - ox; h.vy = h.y - oy;
    return Math.abs(h.x - ox) + Math.abs(h.y - oy) > 0.01;
}

// AI combat movement: never stand still against a threat.
//  - approach to the hero's ideal range, then ORBIT the target (circle around it, flipping direction now and then);
//  - BACK OFF when overlapping any enemy body;
//  - STUCK (wanted to move but barely did for 8 ticks): sidestep perpendicular for ~0.45 s and flip orbit;
//  - Espirit keeps her distance and lines up on one of the 8 aim lines so her arrows connect, hopping lines.
function aiCombatMove(w, h, k, enemy, ed, speed) {
    const i = w.heroes.indexOf(h), ox = h.x, oy = h.y;
    if (h.orbitDir === undefined) h.orbitDir = i % 2 ? 1 : -1;
    if (w.time >= (h.orbitFlipAt || 0)) { h.orbitFlipAt = w.time + 2200 + rng(w) * 1800; if (h.orbitFlipAt > 0 && rng(w) < 0.45) h.orbitDir *= -1 }
    let tx, ty, spd = speed;
    // overlap check against every entered enemy
    let ax = 0, ay = 0, over = false;
    for (const e of w.enemies) {
        if (!e.entered) continue;
        const r = (ENEMY_TYPES[e.type].radius || 12) + 16, d = dist(e, h);
        if (d < r) { over = true; const dd = d || 0.01; ax += (h.x - e.x) / dd * (r - d + 1); ay += (h.y - e.y) / dd * (r - d + 1) }
    }
    if (w.time < (h.escapeUntil || 0)) { tx = h.x + h.escX * 40; ty = h.y + h.escY * 40 }
    else if (over) { const m = Math.hypot(ax, ay) || 1; tx = h.x + ax / m * 30; ty = h.y + ay / m * 30 }
    else {
        const ideal = k.aiIdeal;
        let phi = Math.atan2(h.y - enemy.y, h.x - enemy.x), rad = ideal;
        if (h.name === 'ESPIRIT') {
            if (h.lane === undefined || w.time >= (h.laneAt || 0)) { h.lane = Math.round(phi / (Math.PI / 4)) + (h.lane === undefined ? 0 : h.orbitDir); h.laneAt = w.time + 2400 }
            phi = h.lane * Math.PI / 4;
            rad = ideal + 18 * Math.sin(w.time / 600 + i); // drift in and out along the lane
            if (ed < ideal * 0.6) spd = speed * 1.05; // too close: retreat at full pace
        } else if (ed <= ideal + 14) { phi += h.orbitDir * 0.55; spd = speed * 0.7 } // orbit at ~70% pace
        tx = enemy.x + Math.cos(phi) * rad; ty = enemy.y + Math.sin(phi) * rad;
        const cx = clamp(tx, ARENA.minX + 6, ARENA.maxX - 6), cy = clamp(ty, ARENA.minY + 6, ARENA.maxY - 6);
        if (Math.abs(cx - tx) + Math.abs(cy - ty) > 12) { h.orbitDir *= -1; if (h.name === 'ESPIRIT') h.laneAt = 0 } // walled in: go round the other way
        tx = cx; ty = cy;
    }
    const want = Math.hypot(tx - h.x, ty - h.y);
    h.moving = moveToward(h, tx, ty, spd);
    const moved = Math.hypot(h.x - ox, h.y - oy);
    h.stuckN = want > 2 && moved < Math.min(0.4, want * 0.5) ? (h.stuckN || 0) + 1 : 0;
    if (h.stuckN >= 8) { // sideways escape, perpendicular to where we were trying to go
        const ux = (tx - h.x) / (want || 1), uy = (ty - h.y) / (want || 1), side = rng(w) < 0.5 ? 1 : -1;
        h.escX = -uy * side; h.escY = ux * side; h.escapeUntil = w.time + 450; h.stuckN = 0; h.orbitDir *= -1;
    }
}

// Port of V19 aiTick(): engage the nearest threat, regroup otherwise; plus revive duty (new for co-op).
function stepAI(w, h, leader) {
    h.moving = false;
    if (!alive(h)) return;
    const k = KITS[h.name], speed = moveSpeed(w, h) * 0.83;
    let enemy = null, ed = Infinity;
    for (const e of w.enemies) { if (!e.entered) continue; const d = dist(e, h); if (d < ed) { ed = d; enemy = e } }
    const downed = w.heroes.filter(u => u !== h && u.state === 'downed').sort((a, b) => dist(a, h) - dist(b, h))[0];
    if (downed && (ed > 70 || dist(downed, h) < 30)) { // go revive if not under direct attack
        if (dist(downed, h) > RULES.reviveRadius * 0.6) h.moving = moveToward(h, downed.x + 8, downed.y, speed);
        return;
    }
    if (enemy && ed < S(380)) {
        aiCombatMove(w, h, k, enemy, ed, speed);
        h.aim = SIM.dir8Of(enemy.x - h.x, enemy.y - h.y); // AI aims (8-way) at its target
        if (Math.abs(SIM.DIR8[h.aim].x) > 0.01) h.facing = SIM.DIR8[h.aim].x > 0 ? 1 : -1;
        if (attackTargets(w, h).length) performAttack(w, h);
        const crowd = w.enemies.filter(e => dist(e, h) < k.specialRadius * 0.8).length;
        const hurtAlly = (h.name === 'DESTINY' || h.name === 'SMITESH') && w.heroes.some(u => alive(u) && u.hp < u.maxHp * 0.6 && dist(u, h) < 135);
        if (crowd >= 3 || (hurtAlly && (crowd >= 1 || h.name === 'SMITESH'))) performSpecial(w, h);
        return;
    }
    if (enemy && (!leader || leader === h || leader.ai)) { // no human to follow: go find the fight
        h.moving = moveToward(h, enemy.x, enemy.y, speed);
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
    stepPickups(w);
    if (w.heroes.every(h => h.state === 'downed')) {
        w.over = true;
        emit(w, { t: 'over', wave: w.wave, score: w.score, kills: w.kills });
    }
    return w;
}

// Enemy flag bits in snapshots: 1 stunned, 2 taunted, 4 winding up (telegraph), 8 just struck (< 250 ms).
function enemyFlags(w, e) {
    return (w.time < e.stunUntil ? 1 : 0) | (w.time < e.tauntUntil ? 2 : 0) | (e.windUntil ? 4 : 0) | (w.time - e.strikeAt < 250 ? 8 : 0);
}

// Compact per-tick snapshot. Enemies are arrays: [id, type, x, y, hp%, facing, flags].
const left = (w, until) => Math.max(0, Math.ceil(((until || 0) - w.time) / 100));
function snapshot(w) {
    return {
        tick: w.tick, time: w.time, zone: w.zone, wave: w.wave, ws: w.waveState === 'fighting' ? 1 : 0,
        next: w.waveState === 'intermission' ? Math.max(0, w.nextWaveAt - w.time) : 0, left: w.toSpawn + w.enemies.length,
        score: w.score, kills: w.kills, combo: w.time < w.comboUntil ? w.combo : 0, over: w.over ? 1 : 0,
        boss: w.bossWave && w.waveState === 'fighting' ? (() => { const e = w.enemies.find(e => e.type === ENEMY_INDEX.voidEmperor); return e ? { id: e.id, hp: Math.max(0, e.hp), max: e.max, name: 'VOID EMPEROR', mode: e.attackMode, entering: w.time < (e.entranceUntil || 0) ? 1 : 0 } : null })() : null,
        heroes: w.heroes.map(h => ({
            name: h.name, x: h.x, y: h.y, vx: h.vx, vy: h.vy, facing: h.facing, aim: h.aim, moving: h.moving, controller: h.controller, seq: h.seq,
            cs: h.chain, // chain stage of the last swing (2 = finisher)
            cc: h.critChain || 0, // Critical Chain: consecutive crits
            lv: h.level || 1, // hero level (LEVEL UP every 10th wave)
            mastery: h.masteryTier || 0,
            pet: h.name === 'DONNA' && h.state === 'alive' ? Math.min(3, Math.floor(((h.level || 1) - 1) / 10)) : -1,
            petBoost: h.name === 'DONNA' && w.time < (h.animalBoostUntil || 0) ? 1 : 0,
            hp: h.hp, maxHp: h.maxHp, state: h.state === 'alive' ? 0 : 1, rv: h.state === 'downed' ? Math.round(h.reviveMs / RULES.reviveMs * 100) : 0,
            awake: left(w, h.awakenUntil),
            comboHealHits: h.destinyComboHits || 0,
            attackN: h.attackN, specialN: h.specialN, buff: w.time < h.buffUntil ? 1 : 0, shield: w.time < h.shieldUntil ? 1 : 0,
            cd: Math.max(0, Math.round((h.specialAt + RULES.specialCooldownMs - w.time) / 100)), // special cooldown, 0.1 s
            spd: moveSpeed(w, h), // effective move speed (HASTE) so client prediction matches the server exactly
            // power-up time left in 0.1 s (0 = off): FURY, HASTE, WARD, SQUAD SYNERGY
            pu: [left(w, h.furyUntil), left(w, h.hasteUntil), left(w, h.wardUntil), left(w, h.synergyUntil)],
        })),
        pk: w.pickups.map(p => [p.id, p.kind, p.x, p.y, Math.ceil((p.until - w.time) / 1000)]),
        enemies: w.enemies.map(e => [e.id, e.type, Math.round(e.x), Math.round(e.y), Math.max(0, Math.round(e.hp / e.max * 100)), e.facing, enemyFlags(w, e)]),
        ev: w.events,
    };
}

module.exports = { levelUp, PICKUP_KINDS, moveSpeed, stepPickups, collectPickup, damageEnemy, nextChainStage, aimOf, RULES, ENEMY_TYPES, ENEMY_INDEX, KITS, createBattle, step, snapshot, spawnEnemy, performAttack, performSpecial, damageHero, attackTargets, isBossWave, waveSize, critChance, damageTakenMul, inArc };
