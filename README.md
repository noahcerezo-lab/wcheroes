# West Coast Heroes — Multiplayer Starter (Lobby + Movement)

This is the first **real online co-op milestone** built alongside the existing V19 game. It is **not yet multiplayer combat**. The lobby, unique hero claims, 1–4 human players, AI filling empty slots, room links, ready checks, host-controlled start, and synchronized movement are implemented.

## Run locally

```bash
npm install
npm start
```

Visit `http://localhost:3000`. For multiple browser windows, use separate browser sessions (normal/incognito) or different devices. The server must be accessible to every player.

## Deploy

**Netlify Drop cannot host this Node.js/Socket.IO server.** Deploy this entire folder to a Node.js hosting provider that supports long-lived WebSocket connections (for example Render or Railway), with `npm install` and `npm start`. Set `PORT` if required by the host. The provider URL will serve the multiplayer lobby and the legacy V19 game.

For a later split deployment, host `public/` on Netlify and point its Socket.IO client to your backend URL, with explicitly configured CORS and HTTPS/WSS. For this starter, serving both from the Node host is simpler and avoids cross-origin issues.

## Protocol

Client -> server: `room:create {name}`, `room:join {code,name}`, `hero:select {hero}`, `player:ready {ready}`, `room:start {}`, `player:input {x,y}`.

Server -> client: `room:update`, `battle:start`, `battle:state`.

Server owns room membership, unique hero selection, authoritative movement, and AI following. The state is held in memory; restarting the server ends rooms. Disconnects release hero slots, allowing AI to take over mid-battle.

## Next milestone

Port V19 combat to the server-authoritative simulation: enemies, hitboxes, damage, waves, boss battles, cooldowns, abilities, pickups, and state reconciliation. Do not treat the current movement prototype as the completed co-op game.
