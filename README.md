# West Coast Heroes — Online Co-op

Online co-op for 1–4 players, built alongside the original V19 game (`/legacy-v19.html`, unchanged). Lobby, unique hero claims, AI filling empty slots, room links, reconnects, and **server-authoritative shared combat**: enemies, waves, hits, damage, specials, downed/revive, AI teammates that fight, and a game-over screen that returns to the lobby. Bosses and upgrades come next (Phase D).

## Run locally

```bash
npm install
npm start
```

Visit `http://localhost:3000`. Run the automated multiplayer checks with `npm test` (starts the server and drives 4 Socket.IO clients). For multiple browser windows, use separate browser sessions (normal/incognito) or different devices. The server must be accessible to every player.

## Deploy

**Netlify Drop cannot host this Node.js/Socket.IO server.** Deploy this entire folder to a Node.js hosting provider that supports long-lived WebSocket connections (for example Render or Railway), with `npm install` and `npm start`. Set `PORT` if required by the host. The provider URL will serve the multiplayer lobby and the legacy V19 game.

For a later split deployment, host `public/` on Netlify and point its Socket.IO client to your backend URL, with explicitly configured CORS and HTTPS/WSS. For this starter, serving both from the Node host is simpler and avoids cross-origin issues.

## Protocol

Client -> server: `room:create {name}`, `room:join {code,name}` (ack includes `playerId` + secret `token`), `session:resume {token}`, `hero:select {hero}`, `player:ready {ready}`, `room:start {}`, `room:lobby {}` (host: back to hero select / play again), `room:leave`, `player:input {seq,x,y,attack,special}` (one per 50 ms, `seq` strictly increasing).

Server -> client: `room:update`, `battle:start`, `battle:state`, `battle:end`, `session:replaced`.

`player:input` is **intent only**: movement plus `attack`/`special` booleans. The server checks cooldowns and resolves every hit; any other field (damage, hp, targets…) is ignored.

`battle:state` (20 Hz, compact) = `{tick, wave, ws (1 = fighting), next (ms to next wave), left, score, kills, combo, over, zone, heroes:[…], enemies:[[id, type, x, y, hp%, facing, flags]…], pk:[[id, kind, x, y, seconds left]…], ev:[…]}`. Pickup kinds: 0 HEAL, 1 FURY, 2 HASTE, 3 WARD.
- heroes (slot order 1P NOAH, 2P DESTINY, 3P MARKIE, 4P ESPIRIT): `name, x, y, vx, vy, facing, aim (0–7, 0 = right, 2 = down, 4 = left, 6 = up), moving, controller, seq (prediction ack), hp, maxHp, state (0 alive, 1 downed), rv (revive %), attackN, specialN, cs (chain stage of last swing, 2 = finisher), cc (Critical Chain: crits in a row), buff, shield, cd (special cooldown, 0.1 s), spd (move speed right now, includes HASTE), pu ([FURY, HASTE, WARD, SYNERGY] time left in 0.1 s)`.
- enemy types: 0 Horned Acolyte (melee), 1 Temple Warden (ground slam). No projectile enemies. Flags: 1 stunned, 2 taunted, 4 winding up (telegraph), 8 just struck.
- events `ev`: `hit {id,d,c (crit),cc (chain count on a crit),f (finisher),h,x,y}`, `pspawn {id,k,x,y}`, `pick {id,k,h,x,y}`, `syn {h,all}`, `kill`, `hurt`, `heal`, `buff`, `spc`, `slam`, `down`, `revive`, `wave`, `clear`, `over`.
- `battle:start` and `session:resume` add `arena` and `enemyTypes`. `battle:end {reason: 'host'|'wipe', wave, score, kills}`.

Bandwidth: ~28 KB/s of JSON per client in a 4-player fight; WebSocket compression (`perMessageDeflate`) brings it to ~3.6 KB/s on the wire (measured with tools/headless-c.js).

## Reconnects, prediction, limits

- **Reconnect-to-slot.** The browser keeps the session token in `localStorage`. If a player drops or refreshes, AI plays their hero but the slot stays reserved for `RECONNECT_GRACE_MS` (default 45000). Coming back within that window (automatic on reload/reconnect) returns the same hero, mid-battle included. After it, the slot is released. A token used from a second tab takes over and the first tab is told (`session:replaced`). If the host drops, host passes to a connected player and does not bounce back.
- **Prediction.** Your own hero moves locally the moment you press a key, using the same rule as the server (`public/js/shared-sim.js`), then reconciles with each snapshot's `seq`. Other heroes are interpolated. URL flags for comparison: `?predict=0`, `?interp=0`.
- **Limits.** Inputs: token bucket (22/s, burst 8); extra inputs are acknowledged but not applied. Room/lobby events: 5/s, burst 15 (`Slow down.`). Non-numeric/infinite values are zeroed, stale or duplicate `seq` ignored. `MAX_ROOMS` (default 500). Socket.IO ping 10 s / timeout 8 s so dead connections hand over to AI quickly.

## Combat rules (shared/combat.js)

- **World size.** The server simulates in 960×540 units; V19 drew a 1440×810 world. V19 distances ÷ 1.5; V19 per-frame speeds × 2 per 50 ms tick (Noah 3.7 → 7.4). The canvas is still 1440×810 (×1.5).
- **Heroes** (V19 numbers): NOAH crescent arc + ARCANE NOVA blast; DESTINY spear strike with stun, RALLY STRIKE (team heal 35, +25% damage 5 s, stun) and a healing aura; MARKIE 360° axe cleave (front ×1.5), EARTHSHATTER (×4, taunt 4 s, damage shield 3 s); ESPIRIT long-range single arrow, ARROW STORM. VIT → damage taken (stats from the hero sheets, `public/assets/heroes.json`).
- **Feel.** Attacks aim in 8 directions (the way you last moved; AI aims at its target). Swings chain 1-2-3; the 3rd is a finisher (×1.6 damage, ×1.8 knockback, longer reach, then a short recovery). The chain resets if you pause longer than the cooldown + 450 ms. Movement accelerates and decelerates (full speed in ~200 ms), diagonals are normalized, walls stop velocity. All of it is in the shared modules, so client prediction matches the server exactly.
- **Critical hits.** Every hit has a 14% crit chance (rolled on the server) for ×1.85 damage. Crits in a row by the same hero build a Critical Chain (shown over the hero); any normal hit resets it.
- **Power-ups.** From wave 1, a glowing pickup appears every 10–17 s (at most 2 on the field, each lasts 15 s). Walk over it to collect (the server checks the distance). HEAL: +32% max HP. FURY: +25% crit chance for 10.5 s. HASTE: +50% move speed and attacks 35% sooner for 10.5 s (the snapshot's `spd` keeps client prediction exact). WARD: incoming damage halved for 11 s.
- **SQUAD SYNERGY.** If the squad has any AI teammates, every pickup also gives all living heroes +12% crit chance for 6.5 s (stacks with FURY).
- **AI teammates** circle their target at their preferred range instead of standing still, step back when they overlap an enemy, and sidestep if they get stuck. Espirit keeps about 150 units away, lined up on one of her 8 aim lines.
- **Downed / revive.** At 0 HP a hero is downed (can't move or attack). Stand next to them for 2 s (two helpers = faster) to revive at 40% HP. Everyone downed = game over; after 8 s (`GAME_OVER_RETURN_MS`) the room returns to the lobby, or the host can return earlier.
- **Waves.** Wave n has 5 + 3n enemies, at most 24 alive (`MAX_ENEMIES`). They spawn off-screen and can't leave the arena once inside. +25 HP to living heroes on a clear, 3 s break. Wardens join from wave 3 and grow to about a third of each wave by wave 10. Every 15th wave is flagged as a boss wave and every 10th calls an upgrade hook (both no-ops until Phase D).
- **Level up.** Clearing every 10th wave (10, 20, 30…) levels up every living hero, human or AI, and heals them to full (downed heroes miss that one). Stats come from `shared/levelup-table.js`, adopted from Oracle's soft-capped curve (levels 1–15; past 15 stays on row 15): max HP, damage, move speed, attack cooldown, special-damage scale, and crit growth added on top of the 14% base (total capped at 45% before pickups). Level 1 is the V19 base. The level shows on nameplates and in the HUD.
- **Knockback.** Basic hits push 40% further than V19 (`RULES.basicKnockMul`). Espirit's reach is 2× V19 (`RULES.espiritRangeMul`).
- **Env knobs.** `FIRST_WAVE_DELAY_MS` (3000), `GAME_OVER_RETURN_MS` (8000), `ENEMY_DAMAGE_MUL` (1, difficulty), `COMBAT_SEED` (fixed fights for testing), `WS_DEFLATE=0` (turn compression off).

## Art

- Combat VFX and enemies: Draper's pack (`/workspace/wcheroes-design/`, README + combat-vfx.md + enemies.md), copied to `public/assets/combat/` and drawn with nearest-neighbor scaling. World radii win over sheet sizes; floor rings aren't flipped. Damage numbers: `#FFF2A0` normal, `#FFD36D` crit, `#ADFFCB` heal.
- Portraits and stat fills: Oracle's pack (`/workspace/wcheroes-assets/`, README), copied to `public/assets/portraits/*.png` and `public/assets/heroes.json`.
- Screen shake is small and short, and off when the device asks for reduced motion.
- **Premium overhaul** (Draper's `m-overhaul` groups 1–7, copied to `public/assets/overhaul/`, nearest-neighbor):
  - Noah: 8-way attack sheets per combo hit (Crescent Slash, Reverse Arc, Arcane Breaker) with the tapered crescent sheet on hits 1–2 and shards + shockwave on the Breaker's impact frame. Espirit: 8-way bow cycle (raise, draw, nock/hold, release, recoil) and a glowing arrow that leaves the string on the release frame. Markie: axe smash with sparks + ground crack on frame 6. Destiny: gold sweep, and the gold shield + heal ring on RALLY STRIKE. Markie and Destiny only have E/W art, so up/down/diagonal hits add a rotated crescent layer. Idle/run/hurt sheets for everyone. The procedural pose layer (`hero-anim.js`) is the fallback while sheets load.
  - Impacts show when the weapon connects (or the arrow lands), not when the packet arrives; the enemy holds for a few frames (hit-stop), then recoils away from the hit. Deaths wait for the killing blow and slide back while the die frames play. Damage numbers are smaller and combine per target.
  - Sounds: synthesized WebAudio cues (`sfx.js`, Oracle) for swings, hits, crits, finishers, the bow, pickups, level-ups and wave clears. They start after the first tap/key (iOS rule); other players' sounds are quieter.
  - Battlefield: the Moonlit Temple layers composited once per zone (zones are colour-graded: ember red, verdant teal, celestial violet), ambient mist + embers, soft shadows, a light pool under attacking heroes.
  - Phones: compact HUD, banners in one slim top band, special-move callouts as small tags near the hero, the canvas and controls inside the safe areas (`env(safe-area-inset-*)`), smaller controls that are translucent until touched.
  - Performance: pooled particles (`fx-pool.js` + Oracle's `fx.js`), cached backgrounds/glows/tints, adaptive particle density from frame times (phones start at 75%). Hit-stop only slows cosmetic particles; the server sim and prediction never pause.

## Code layout

- `server.js` — rooms, lobby, sessions; runs `shared/combat.js` in the authoritative 20 Hz tick and broadcasts compact snapshots.
- `shared/combat.js` — DOM-free, seeded combat simulation (enemies, hero kits, chains, downed/revive, AI teammates, waves).
- `public/js/combat-art.js` — loads and plays Draper's sprite sheets.
- `public/js/heroes-config.js` — shared hero roster (slot order, class, colors, STR/AGI/INT/VIT/LUK, V19 combat numbers). Loaded by the server and the browser.
- `public/js/heroes-render.js` — V19's hero/enemy sprites and battlefield, extracted so `legacy-v19.html` and the multiplayer client share one renderer. Optional `theme: 'sheet'` recolors heroes to match the official hero sheets (multiplayer only).
- `public/js/shared-sim.js` — movement rule shared by server and client (acceleration, 8-way aim, prediction).
- `public/js/mp-client.js` — lobby, sessions/reconnect, input + prediction, V19 joystick and touch buttons.
- `public/js/hero-sheets.js` / `hero-anim.js` — hero sprite sheets and the attack timelines (contact frame, hit-stop, effects); `env-fx.js` — battlefield; `fx-pool.js`, `fx.js` (Oracle) — particles; `sfx.js` (Oracle) — sound.
- `public/js/mp-arena.js` — multiplayer canvas: V19 battlefield + heroes, Draper enemies and effects, HUD; interpolates snapshots (`?interp=0` turns smoothing off); larger sprites on small screens.
- `test/` — `npm test`: combat unit tests (deterministic), server combat checks (forged input, downed, wipe → lobby), and the multiplayer checks (lobby, sync, reconnect-to-slot, grace expiry, host migration, prediction acks, rate limits, cooldowns, play again).

Server owns room membership, hero selection, movement, combat and AI. The state is held in memory; restarting the server ends rooms. Disconnects release hero slots, allowing AI to take over mid-battle.

## Next milestone (Phase D)

Bosses (The Void Emperor; sheets are already in `public/assets/combat/`), hero upgrades every 10 waves, pickups, difficulty tuning from real playtests.
