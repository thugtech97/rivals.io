# rivals.io

A top-down 2D multiplayer shooter. Pick a name, browse live rooms, create your own room or Quick play, then fight in a square arena.

**Controls:** WASD / arrow keys move · mouse aims · left click shoots (hold for auto fire) · R reloads · Esc leaves.

**Rules:** 100 HP, 25 damage per bullet, 3s respawn. 15-round magazine, 45 spare rounds (max 90). Ammo crates (+30) spawn around the arena. All tunable in `shared/constants.ts`.

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
