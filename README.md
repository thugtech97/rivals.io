# rivals.io

A top-down 2D multiplayer shooter. Pick a name, hit **Play** (quick play), practice against bots, create your own room (Solo or Teams) or browse live rooms, then fight in a square arena, or just watch.

**Lobby:** your name and a column of buttons on the left (▶ Play, 🤖 Practice vs bots, ➕ Create room, 🌐 Join rooms with a count of open rooms, ❓ How to play) and a panel on the right that shows How to play by default; the other buttons swap their page into it (`#practice`, `#create`, `#rooms`, so the browser's Back button and Esc return to How to play). On narrow screens the panel goes under the menu and the buttons become a 2×2 grid. Practice and Create share one form (mode, size, plus room name or bot difficulty); the last choices are remembered per browser.

**Controls:** WASD / arrow keys move · mouse aims · left click attacks (hold for auto fire) · 1–5 or mouse wheel switch weapons · R reloads · E picks up / swaps · F gets on / off a vehicle · G drops the weapon in hand · M mutes sound · Q (or the Quality button, top right) switches graphics Low / Medium / High, remembered per device: lower it if the game lags · ⛶ (top right) toggles fullscreen (not on iPhone, which doesn't allow it for websites) · Esc leaves (in fullscreen the first Esc only exits fullscreen). Sounds are synthesized in `client/src/sound.ts` (no audio files).

**Weapons & items:** 5 weapon slots. Guns: pistol (everyone starts with one), rifle, shotgun (8 pellets × 13 damage in a fan: 104 point blank, but short range and the spread opens up fast), machine gun, sniper, and a bazooka (slow rocket that explodes on impact). Grenades (picked up in pairs, carry up to 4) are thrown: they bounce off walls, roll to a stop and explode after 1.6s. Explosions hurt everyone in the blast radius (less further out, walls block it, vests help, your own blasts hurt you at half damage). Melee: knife, sword, axe (fists when the slot is empty). A bulletproof vest (50 armor) soaks up 70% of bullet and melee damage until it breaks (not the zone). Medkits heal +40 HP. Speed boots make you run 35% faster; their charge only drains while you move (20s of running) and they're gone when it runs out (drop on death like a vest). Ammo boxes feed the gun in your hand (a box is 2 magazines' worth, e.g. +50 rifle rounds), and each match places more of them the more players there are (10 + 3 per player). In solo matches loot is placed **once** at match start; after that, items only appear when someone drops them (G) or dies (team matches resupply, see below). Walking over an item picks it up when you have room; with full slots, E swaps it for the weapon in hand. All stats live in `shared/weapons.ts`.

**Matches (last soldier standing):** with 1 player a room is in warmup (practice, you respawn). Other players can keep joining until the room is full; a full room starts a 5s countdown right away (if someone doesn't show up, the host 👑 can press **Start match now** once 2+ players are in; if the host leaves, or is AFK for 60s during warmup, another active player becomes host). Then the match begins: everyone is reset, no new players can join mid-match (spectators still can), and **there are no respawns**. Eliminated players spectate the survivors (click / Space / ← → to switch). The last player alive wins; after an 8s winner banner the room goes back to warmup and the next match starts.

**Team mode (Blue vs Red):** pick *Teams* when creating a room (2 = 1v1 … 10 = 5v5, 16 = 8v8). Players are put on the smaller team when they join and can switch in warmup (**⇄ Join Red/Blue**, while the other team has room). A match needs at least one player per team and evens the teams out at the start (at most one apart). Each team has a base in an opposite corner (Blue bottom-left, Red top-right) on cleared ground: a **core** whose health scales with the match size (150 HP per player, at least 600: 1v1 600, 3v3 900, 5v5 1500, 8v8 2400) with a **turret** that shoots the closest enemy in range (650px, a bit more than a rifle), and a **fountain** around it that heals teammates 30 HP/s. No friendly fire (bullets, blasts and blades pass teammates; your own explosives still hurt you). Dead players respawn at their base after 5s. No shrinking zone. Team matches place extra weapons and medkits for every player (e.g. +½ rifle, +½ grenade, +½ medkit per player). Since players keep coming back, ammo and medkits do too: every 10s, if fewer ammo boxes (or medkits) are lying around than half of what the match started with, a new one drops in somewhere random (never inside a base). **Destroy the enemy core to win** (shoot it, blow it up, or hit it); a team with nobody left loses too. The top of the screen shows each team's kills and base health; the minimap shows both bases and your teammates (not enemies). Rules live in `shared/teams.ts`, the turret's gun in `shared/weapons.ts` (`turret`).

**Practice vs bots:** 🤖 Practice vs bots creates a **private** room (not in the room list) where the server fills every free seat with bots: Solo (you vs 1–9 bots) or Teams (1v1 … 5v5, bots on both sides), at **Easy**, **Medium** or **Hard**. Bots are server-side players (`server/src/bots/`) that send the same input a person does (keys, aim, fire, switch, reload, pick up, drop), so they play by exactly the same rules. They pathfind around walls (A* on a 20px grid rebuilt for every map), loot what they need, pick weapons for the distance, strafe, retreat to heal, run for the safe zone, and can't see you hiding in a tree unless you're close or just gave yourself away. In Teams, some bots guard their base, attackers go up the middle or round either flank, and near the enemy core they shoot the core first. Difficulty changes reaction time, aim wobble and turn speed, sight range, burst fire, strafing, leading moving targets, explosives, grenade dodging and how hard they hunt you. The match starts as soon as you join; a solo match ends as soon as you're out; switching team swaps you with a bot. `BOT_DEBUG=1 npm run dev:server` logs what every bot is doing every 5s.

**Spectators:** every room has 8 extra seats for watchers. Press **👁 Watch** in the room list (works mid-match too), or **👁 Spectate** in game before a match (**🎮 Play** switches back when a seat is free). Spectators can't be hit, don't count as players, see everyone on the minimap, and switch who they follow with click / Space / ← →. Rooms are never locked (so spectators can always get in): the server turns away players in `onAuth`, and the lobby shows the room state from its metadata. Quick play joins the fullest open room, or creates one.

**Vehicles:** motorbikes 🏍️ (2× walking speed) and cars 🚙 (1.65×, and driving into an enemy hurts them 30 HP and shoves them; once per 0.8s per victim). Press **F** (touch: 🚗) next to a free one to get on, F again to get off beside it. Riding gives **no protection**: bullets, blasts and blades hit the rider as on foot, and the rider can still shoot. Heavy weapons and speed boots don't change a vehicle's speed. Vehicles are parked on the roads at match start (solo: 4 bikes + 3 cars; teams: 2 + 2, plus a bike and a car at each base), are never destroyed, and stay where they are when the rider gets off, dies or leaves. Stats in `shared/vehicles.ts`.

**Hiding in trees:** soldiers (and vehicles) walk right into trees; only the trunk in the middle still stops bullets, so trees are hiding spots, not walls. Standing inside one hides you from enemies, but the tree **shakes** (harder while you move), drops leaves and rustles when someone goes in or out. Shooting, swinging or getting hit gives you away for 1.2s. You and your teammates see yourselves faded (and your own tree goes see-through); spectators see everyone. Riders never hide. Hiding is drawn by each client (`GameScene.updateHiding`); trunk size is `TREE_TRUNK_RADIUS` in `shared/map.ts`.

**Random maps:** every match gets a new map from a random seed (synced to clients). The 9 block themes (forest, town, farm, army camp, park, construction, industrial, market, ruins) are shuffled across the 3×3 city grid, each block is rotated/mirrored at random, trees are re-scattered and the crossroads barriers move. Layouts live in `shared/map.ts` (`THEMES`).

**Safe zone:** the zone starts as the whole map. At 2:20 into a match the first safe square is announced (white outline); at 2:30 the red edge closes in slowly from the map border to it, then it holds 10s and shrinks again over 10s, down to a small final square. Touching the red costs 10 HP immediately and 10 more every second. For quick testing: `ZONE_START_MS=20000 npm run dev:server`.

**Rules:** 100 HP (respawn after 3s only in warmup). Weapon damage, fire rate, magazines and ranges are in `shared/weapons.ts`; everything else in `shared/constants.ts`.

**Testing hook:** starting the server with `TEST_HOOKS=1` enables `debugTeleport` and `debugClearItems` messages used by automated tests. Never set it in production.

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
- **Rooms:** `ArenaRoom` is registered with `enableRealtimeListing()`, so the lobby updates live as rooms are created, fill up or close (mode, players, spectators and match phase are in the room's metadata). Empty rooms are disposed automatically.

## Where to change things

| Want to… | Edit |
|---|---|
| Arena size, speed, max players | `shared/constants.ts` |
| Movement rules | `shared/movement.ts` |
| Map layout: obstacles, roads, trees (shared, so collisions match) | `shared/map.ts` |
| Team mode: bases, core HP, turret range, fountain, respawn time, spectator seats | `shared/teams.ts` |
| Map art: grass, roads, buildings, trees… | `client/src/mapRender.ts` |
| What's synced (HP, score, bullets…) | `server/src/schema/ArenaState.ts` |
| Game rules / new messages | `server/src/rooms/ArenaRoom.ts` |
| Practice bots: difficulty levels, behavior, pathfinding | `server/src/bots/BotBrain.ts`, `server/src/bots/navGrid.ts`, `shared/practice.ts` |
| Graphics, camera, controls | `client/src/GameScene.ts` |
| Lobby UI | `client/index.html`, `client/src/main.ts`, `client/src/style.css` |

## Deploying

- Server: run `npm start --prefix server` on any Node host (VPS + PM2, Railway, Fly.io, Colyseus Cloud). Set `PORT` if needed.
- Client: `npm run build` → upload `client/dist/` to any static host. Build with `VITE_SERVER_URL=wss://your-server` so the client knows where the game server is.
