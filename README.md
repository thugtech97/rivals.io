# rivals.io

A top-down 2D multiplayer shooter. Pick a name, browse live rooms, create your own room or Quick play, then fight in a square arena.

**Controls:** WASD / arrow keys move · mouse aims · left click attacks (hold for auto fire) · 1 / 2 / 3 or mouse wheel switch weapons · R reloads · E picks up / swaps · G drops the weapon in hand · M mutes sound · Esc leaves. Sounds are synthesized in `client/src/sound.ts` (no audio files).

**Weapons & items:** 3 weapon slots. Guns: pistol (everyone starts with one), rifle, machine gun, sniper. Melee: knife, sword, axe (fists when the slot is empty). A bulletproof vest (50 armor) soaks up 70% of bullet and melee damage until it breaks (not the zone). Medkits heal +40 HP. Speed boots make you run 35% faster; their charge only drains while you move (20s of running) and they're gone when it runs out (drop on death like a vest). Ammo boxes feed the gun in your hand (a box is 2 magazines' worth, e.g. +50 rifle rounds), and each match places more of them the more players there are (10 + 3 per player). Loot is placed **once** at match start; after that, items only appear when someone drops them (G) or dies. Walking over an item picks it up when you have room; with full slots, E swaps it for the weapon in hand. All stats live in `shared/weapons.ts`.

**Matches (last soldier standing):** with 1 player a room is in warmup (practice, you respawn). Other players can keep joining until the room is full; a full room starts a 5s countdown right away (if someone doesn't show up, the host 👑 can press **Start match now** once 2+ players are in; if the host leaves, or is AFK for 60s during warmup, another active player becomes host). Then the match begins: everyone is reset, the room locks (no joining mid-match), and **there are no respawns**. Eliminated players spectate the survivors (click / Space / ← → to switch). The last player alive wins; after an 8s winner banner the room goes back to warmup and the next match starts.

**Random maps:** every match gets a new map from a random seed (synced to clients). The 9 block themes (forest, town, farm, army camp, park, construction, industrial, market, ruins) are shuffled across the 3×3 city grid, each block is rotated/mirrored at random, trees are re-scattered and parked cars and barriers move. Layouts live in `shared/map.ts` (`THEMES`).

**Safe zone:** the zone starts as the whole map. At 2:40 into a match the first safe square is announced (white outline); at 3:00 the red edge closes in slowly from the map border to it, then it holds 20s and shrinks again over 10s, down to a small final square. Touching the red costs 10 HP immediately and 10 more every second. For quick testing: `ZONE_START_MS=20000 npm run dev:server`.

**Rules:** 100 HP (respawn after 3s only in warmup). Weapon damage, fire rate, magazines and ranges are in `shared/weapons.ts`; everything else in `shared/constants.ts`.

**Testing hook:** starting the server with `TEST_HOOKS=1` enables a `debugTeleport` message used by automated tests. Never set it in production.

**Stack:** TypeScript · [Phaser 4](https://phaser.io) (rendering/input) · [Colyseus 0.18](https://colyseus.io) (rooms, matchmaking, state sync) · Vite

## Run it

```bash
npm run setup   # first time only: installs root, server and client deps
npm run dev     # starts the game server (:2567) and the client (:5173)
```

Open http://localhost:5173 in two browser windows to play against yourself.
Friends on the same Wi-Fi can open `http://<your-PC-ip>:5173` (allow Node through Windows Firewall when asked).

## How it fits together

```
client/ (browser)                           server/ (Node + Colyseus)
  main.ts      lobby UI: room list,  ◄────►   LobbyRoom   live list of arena rooms
               create / join / quick play
  GameScene.ts Phaser scene          ◄────►   ArenaRoom   one game room = one arena
               sends held keys,               60 Hz simulation, authoritative positions
               predicts own movement,         state synced to clients at 20 Hz
               interpolates others
shared/        constants + movement code used by both sides
```

- **Server-authoritative:** clients only send which keys are held (`"input"` message). The server moves everyone in `ArenaRoom.tick()`.
- **Prediction:** your own player moves instantly using the same `applyInput()` from `shared/movement.ts`, and is gently corrected toward the server position.
- **Rooms:** `ArenaRoom` is registered with `enableRealtimeListing()`, so the lobby updates live as rooms are created, fill up or close. Empty rooms are disposed automatically.

## Where to change things

| Want to… | Edit |
|---|---|
| Arena size, speed, max players | `shared/constants.ts` |
| Movement rules | `shared/movement.ts` |
| Map layout: obstacles, roads, trees (shared, so collisions match) | `shared/map.ts` |
| Map art: grass, roads, buildings, cars… | `client/src/mapRender.ts` |
| What's synced (HP, score, bullets…) | `server/src/schema/ArenaState.ts` |
| Game rules / new messages | `server/src/rooms/ArenaRoom.ts` |
| Graphics, camera, controls | `client/src/GameScene.ts` |
| Lobby UI | `client/index.html`, `client/src/main.ts`, `client/src/style.css` |

## Deploying

- Server: run `npm start --prefix server` on any Node host (VPS + PM2, Railway, Fly.io, Colyseus Cloud). Set `PORT` if needed.
- Client: `npm run build` → upload `client/dist/` to any static host. Build with `VITE_SERVER_URL=wss://your-server` so the client knows where the game server is.
