# West Coast Heroes — Multiplayer Starter (Lobby + Movement)

This is the first **real online co-op milestone** built alongside the existing V19 game. It is **not yet multiplayer combat**. The lobby, unique hero claims, 1–4 human players, AI filling empty slots, room links, ready checks, host-controlled start, and synchronized movement are implemented.

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

`battle:state` (20 Hz) = `{tick, serverTime, arena:{minX,maxX,minY,maxY}, zone, heroes:[{name, x, y, hp, maxHp, facing, moving, controller, seq, attackN, specialN}]}` — `seq` is the last input the server applied for that hero (prediction ack); `attackN`/`specialN` count cooldown-validated presses (animation only for now)` in hero-sheet slot order (1P NOAH, 2P DESTINY, 3P MARKIE, 4P ESPIRIT).

## Reconnects, prediction, limits

- **Reconnect-to-slot.** The browser keeps the session token in `localStorage`. If a player drops or refreshes, AI plays their hero but the slot stays reserved for `RECONNECT_GRACE_MS` (default 45000). Coming back within that window (automatic on reload/reconnect) returns the same hero, mid-battle included. After it, the slot is released. A token used from a second tab takes over and the first tab is told (`session:replaced`). If the host drops, host passes to a connected player and does not bounce back.
- **Prediction.** Your own hero moves locally the moment you press a key, using the same rule as the server (`public/js/shared-sim.js`), then reconciles with each snapshot's `seq`. Other heroes are interpolated. URL flags for comparison: `?predict=0`, `?interp=0`.
- **Limits.** Inputs: token bucket (22/s, burst 8); extra inputs are acknowledged but not applied. Room/lobby events: 5/s, burst 15 (`Slow down.`). Non-numeric/infinite values are zeroed, stale or duplicate `seq` ignored. `MAX_ROOMS` (default 500). Socket.IO ping 10 s / timeout 8 s so dead connections hand over to AI quickly.

## Code layout

- `server.js` — rooms, lobby, authoritative 20 Hz movement + AI followers.
- `public/js/heroes-config.js` — shared hero roster (slot order, class, colors, STR/AGI/INT/VIT/LUK, V19 combat numbers). Loaded by the server and the browser.
- `public/js/heroes-render.js` — V19's hero/enemy sprites and battlefield, extracted so `legacy-v19.html` and the multiplayer client share one renderer. Optional `theme: 'sheet'` recolors heroes to match the official hero sheets (multiplayer only).
- `public/js/shared-sim.js` — movement rule shared by server and client (prediction).
- `public/js/mp-client.js` — lobby, sessions/reconnect, input + prediction, V19 joystick and touch buttons.
- `public/js/mp-arena.js` — multiplayer canvas: draws snapshots with V19 art and interpolates between them (`?interp=0` turns smoothing off); larger sprites on small screens.
- `test/` — `npm test` headless multiplayer checks (lobby, sync, reconnect-to-slot, grace expiry, host migration, prediction acks, rate limits, cooldowns, play again).

Server owns room membership, unique hero selection, authoritative movement, and AI following. The state is held in memory; restarting the server ends rooms. Disconnects release hero slots, allowing AI to take over mid-battle.

## Next milestone

Port V19 combat to the server-authoritative simulation: enemies, hitboxes, damage, waves, boss battles, cooldowns, abilities, pickups, and state reconciliation. Do not treat the current movement prototype as the completed co-op game.
