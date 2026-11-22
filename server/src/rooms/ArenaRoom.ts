import { Room, type Client } from "colyseus";
import { ArenaState, Core, Grenade, GroundItem, Player, Vehicle, WeaponSlot } from "../schema/ArenaState";
import {
  ARENA_SIZE,
  DEFAULT_PLAYERS_PER_ROOM,
  MAX_PLAYERS_PER_ROOM,
  MIN_PLAYERS_PER_ROOM,
  NAME_MAX_LENGTH,
  PICKUP_RADIUS,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  RESPAWN_MS,
  ROOM_NAME_MAX_LENGTH,
  TICK_MS,
  MATCH_COUNTDOWN_MS,
  MATCH_END_MS,
  MATCH_MIN_PLAYERS,
  ZONE_DAMAGE_PER_SEC,
  ZONE_HOLD_MS,
  ZONE_MIN_SIZE,
  ZONE_SHRINK_FACTOR,
  ZONE_SHRINK_MS,
  ZONE_START_MS,
  ZONE_START_SIZE,
  HOST_IDLE_MS,
  IDLE_KICK_CODE,
  IDLE_KICK_MS,
} from "../../../shared/constants";
import { angleDelta, applyInput, clamp, isMoving, muzzlePosition, NO_INPUT, type InputState } from "../../../shared/movement";
import type {
  BulletEndEvent,
  CoreDestroyedEvent,
  ExplosionEvent,
  KillEvent,
  RamEvent,
  ShotEvent,
  SupplyDropEvent,
  SwingEvent,
} from "../../../shared/messages";
import {
  isVehicleKind,
  RAM_COOLDOWN_MS,
  RAM_PUSH_PX,
  ROAD_VEHICLES,
  VEHICLE_REACH,
  VEHICLE_TURN_PER_SEC,
  VEHICLES,
  type VehicleKind,
} from "../../../shared/vehicles";
import {
  BASE_CLEAR_RADIUS,
  BASES,
  coreMaxHp,
  CORE_RADIUS,
  FOUNTAIN_HEAL_PER_SEC,
  FOUNTAIN_RADIUS,
  isTeam,
  MAX_SPECTATORS,
  otherTeam,
  RESUPPLY_ITEMS,
  RESUPPLY_MIN_FRACTION,
  RESUPPLY_MS,
  TEAM_COLOR,
  TEAM_NAME,
  TEAM_RESPAWN_MS,
  TEAMS,
  TURRET_RANGE,
  type GameMode,
  type Team,
} from "../../../shared/teams";
import { GameMap, newMapSeed, ROADS } from "../../../shared/map";
import { BOT_LEVEL_NAME, BOT_NAMES, isBotLevel, type BotLevel } from "../../../shared/practice";
import { BotBrain, type BotWorld } from "../bots/BotBrain";
import { NavGrid } from "../bots/navGrid";
import {
  BOOTS_DURATION_MS,
  BOOTS_SPEED_MUL,
  GRENADE_BOUNCE,
  GRENADE_FRICTION,
  gunStats,
  heldStats,
  LOOT_TABLE,
  MEDKIT_HEAL,
  SELF_SPLASH_MUL,
  SLOT_COUNT,
  STARTING_WEAPON,
  VEST_ABSORB,
  VEST_ARMOR,
  WEAPONS,
  type GunStats,
  type MeleeStats,
  type SplashStats,
  type WeaponId,
} from "../../../shared/weapons";

/** How often the synced state is sent to clients (ms). */
const PATCH_MS = 1000 / 30;
/** Bullets are checked every few pixels so they can't skip through thin barricades. */
const BULLET_STEP_PX = 8;
/** How close you must be to an item to pick it up. */
const ITEM_REACH = PLAYER_RADIUS + PICKUP_RADIUS + 4;
/** Something you just dropped isn't auto-picked up again for this long (E still works). */
const DROP_BLOCK_MS = 2500;
/** A base turret with nobody in sight looks for a target this often (not every tick). */
const TURRET_SCAN_MS = 200;
/** Switching weapons takes a moment before you can attack. */
const SWITCH_DELAY_MS = 180;
/** Shooting / getting hit gives away a tree hiding spot this long (same as the client's REVEAL_MS). */
const REVEAL_MS = 1200;
/** Bots' session ids start with this (real ones never do). */
const BOT_ID_PREFIX = "bot-";

// Zone timings. The env vars are only for quick local testing, e.g.
// ZONE_START_MS=20000 npm run dev:server  → the zone starts shrinking after 20 seconds.
const zoneStartMs = Number(process.env.ZONE_START_MS) || ZONE_START_MS;
const zoneHoldMs = Number(process.env.ZONE_HOLD_MS) || ZONE_HOLD_MS;
const zoneShrinkMs = Number(process.env.ZONE_SHRINK_MS) || ZONE_SHRINK_MS;
/** AFK kick timeout (IDLE_KICK_MS env var is only for quick local testing). */
const idleKickMs = Number(process.env.IDLE_KICK_MS) || IDLE_KICK_MS;
/** AFK host hand-over (HOST_IDLE_MS env var is only for quick local testing). */
const hostIdleMs = Number(process.env.HOST_IDLE_MS) || HOST_IDLE_MS;
/** TEST_HOOKS=1 enables a "debugTeleport" message for automated tests. Never set it in production. */
const TEST_HOOKS = process.env.TEST_HOOKS === "1";
/** BOT_DEBUG=1 logs what every practice bot is up to, every 5 seconds. */
const BOT_DEBUG = process.env.BOT_DEBUG === "1";

/** Shown in the lobby's room list (kept up to date as people join, leave and matches start). */
export interface ArenaMetadata {
  roomName: string;
  hostName: string;
  mode: GameMode;
  /** Playing seats taken / available (spectators have their own seats). */
  players: number;
  maxPlayers: number;
  spectators: number;
  /** ArenaState.matchPhase: players can only join during "warmup" / "countdown". */
  phase: string;
}

interface ArenaOptions {
  roomName?: string;
  maxPlayers?: number;
  playerName?: string;
  /** "teams" for Blue vs Red (set when creating the room). */
  mode?: string;
  /** Join only to watch. */
  spectate?: boolean;
  /** Create a private practice room with bots of this difficulty ("easy" | "medium" | "hard"). */
  practice?: string;
}

interface Bullet {
  id: number;
  /** sessionId of the shooter, or "core:<team>" for a base turret. */
  owner: string;
  /** Shooter's team ("" in solo mode): bullets fly through teammates. */
  team: string;
  weapon: WeaponId;
  damage: number;
  speed: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  expiresAt: number;
  /** Rockets explode instead of hitting one target. */
  splash?: SplashStats;
}

const SLOT_INDEXES = Array.from({ length: SLOT_COUNT }, (_, i) => i);

const COLORS = [0xd9534f, 0x3fa7d6, 0xe0b84a, 0x5cb85c, 0x9b6cd1, 0xe8834a, 0x4a6fd9, 0xd65a9b];

export class ArenaRoom extends Room<{ state: ArenaState; metadata: ArenaMetadata }> {
  private heldKeys = new Map<string, InputState>();
  /** Last real input per player (unlike Player.lastActiveAt, joining doesn't count). */
  private lastInputAt = new Map<string, number>();
  private bullets: Bullet[] = [];
  private nextBulletId = 1;
  private nextItemId = 1;
  private nextVehicleId = 1;
  /** Team matches: when the server next checks whether the map needs more ammo / medkits. */
  private nextResupplyAt = 0;
  /** How many of each item kind the current loot started with (the resupply target). */
  private lootStartCount = new Map<string, number>();
  /** Ramming cooldown: "<car id>:<victim id>" → earliest time it can hurt them again. */
  private ramReadyAt = new Map<string, number>();
  private matchStart = 0;
  /** When the countdown / winner banner ends. */
  private phaseEndsAt = 0;
  /** This room's map. A new random one is generated for every match. */
  private map!: GameMap;
  /** Last lobby listing sent (only re-sent when something in it changed). */
  private listingKey = "";
  /** Practice rooms: the bots' difficulty (null = a normal room, no bots). */
  private practice: BotLevel | null = null;
  /** Practice rooms: every bot's brain, keyed by its (fake) session id. */
  private bots = new Map<string, BotBrain>();
  private nextBotId = 1;
  private botDebugAt = 0;
  /** What bots know about the current map (rebuilt with every new map). */
  private nav!: NavGrid;
  private botWorld!: BotWorld;

  async onCreate(options: ArenaOptions) {
    this.setState(new ArenaState());
    this.state.mode = options.mode === "teams" ? "teams" : "solo";
    if (isBotLevel(options.practice)) {
      this.practice = options.practice;
      this.state.practice = options.practice;
      this.botWorld = this.makeBotWorld();
      await this.setPrivate(true); // not in the lobby's room list
    }
    this.newMap();
    this.resetZone();
    this.resetCores();
    this.spawnLoot(MATCH_MIN_PLAYERS); // warmup loot; each match spawns its own for its player count
    this.spawnVehicles();

    const requested = Math.round(Number(options.maxPlayers) || DEFAULT_PLAYERS_PER_ROOM);
    const maxPlayers = clamp(requested, MIN_PLAYERS_PER_ROOM, MAX_PLAYERS_PER_ROOM);
    this.state.maxPlayers = maxPlayers;
    // Spectators get seats of their own on top of the playing seats.
    this.maxClients = maxPlayers + MAX_SPECTATORS;

    const hostName = cleanText(options.playerName, NAME_MAX_LENGTH) || "Someone";
    const roomName = this.practice
      ? `Practice · ${BOT_LEVEL_NAME[this.practice]} bots`
      : cleanText(options.roomName, ROOM_NAME_MAX_LENGTH) || `${hostName}'s arena`;
    this.state.roomName = roomName;
    await this.setMetadata({ roomName, hostName, mode: this.mode, players: 0, maxPlayers, spectators: 0, phase: "warmup" });

    // Clients only send what they're pressing and where they aim; the server decides the rest.
    this.onMessage("input", (client, input: Partial<InputState>) => {
      this.markActive(client.sessionId);
      const angle = Number(input?.angle);
      this.heldKeys.set(client.sessionId, {
        left: !!input?.left,
        right: !!input?.right,
        up: !!input?.up,
        down: !!input?.down,
        fire: !!input?.fire,
        angle: Number.isFinite(angle) ? angle : 0,
      });
    });

    this.onMessage("reload", (client) => {
      this.markActive(client.sessionId);
      const player = this.state.players.get(client.sessionId);
      if (player) this.startReload(player);
    });

    // Switch weapon slot (1-5 or mouse wheel)
    this.onMessage("slot", (client, index: number) => {
      this.markActive(client.sessionId);
      this.selectSlot(client.sessionId, index);
    });

    // G: drop the weapon in your hand
    this.onMessage("drop", (client) => {
      this.markActive(client.sessionId);
      const p = this.state.players.get(client.sessionId);
      if (p?.alive) this.dropSlot(p, client.sessionId, p.active);
    });

    // F: get on the closest free vehicle in reach, or off the one you're riding.
    this.onMessage("ride", (client) => {
      this.markActive(client.sessionId);
      const p = this.state.players.get(client.sessionId);
      if (!p?.alive || p.spectator) return;
      if (p.vehicle) this.dismount(p, client.sessionId);
      else this.mount(p, client.sessionId);
    });

    // E: pick up / swap the item you're standing on
    this.onMessage("pickup", (client) => {
      this.markActive(client.sessionId);
      const p = this.state.players.get(client.sessionId);
      if (p?.alive) this.manualPickup(p, client.sessionId);
    });

    // Host: start now with whoever is here (someone didn't show up).
    this.onMessage("startMatch", (client) => {
      this.markActive(client.sessionId);
      const s = this.state;
      if (client.sessionId !== s.hostId || s.matchPhase !== "warmup" || !this.enoughPlayers()) return;
      this.startCountdown(this.clock.currentTime);
      console.log(`[${this.roomId}] host started the match early (${this.playerCount()}/${s.maxPlayers})`);
    });

    // Team mode, before the match: switch to the other team (if it has room).
    this.onMessage("team", (client, wanted: string) => {
      this.markActive(client.sessionId);
      const p = this.state.players.get(client.sessionId);
      const phase = this.state.matchPhase;
      if (!p || p.spectator || this.mode !== "teams" || !isTeam(wanted) || p.team === wanted) return;
      if (phase !== "warmup" && phase !== "countdown") return;
      if (this.teamSize(wanted) >= this.teamCapacity()) {
        // Practice: the other team is full of bots, so one of them swaps sides with you.
        const bot = this.practice ? this.botOnTeam(wanted) : undefined;
        if (!bot) return;
        this.setTeam(bot, otherTeam(wanted));
        this.respawn(bot);
      }
      this.setTeam(p, wanted);
      this.respawn(p); // over to the new team's base
      this.assignBotRoles();
    });

    // Watch instead of playing (any time), or start playing again (before a match only).
    this.onMessage("spectate", (client, on: boolean) => {
      this.markActive(client.sessionId);
      const p = this.state.players.get(client.sessionId);
      if (!p || p.spectator === !!on) return;
      if (on) {
        this.makeSpectator(p, client.sessionId);
      } else {
        const phase = this.state.matchPhase;
        if ((phase !== "warmup" && phase !== "countdown") || this.playerCount() >= this.state.maxPlayers) return;
        p.spectator = false;
        if (this.mode === "teams") this.setTeam(p, this.smallerTeam());
        this.respawn(p);
        this.ensureHost();
        this.assignBotRoles();
      }
    });

    if (TEST_HOOKS) {
      this.onMessage("debugTeleport", (client, pos: { x: number; y: number }) => {
        const p = this.state.players.get(client.sessionId);
        if (p) {
          p.x = Number(pos.x);
          p.y = Number(pos.y);
        }
      });
      // Empty the map of loot (e.g. to test the team-mode ammo resupply).
      this.onMessage("debugClearItems", () => this.state.items.clear());
    }

    this.setSimulationInterval((dt) => this.tick(dt), TICK_MS);
    // Send state 30×/s (Colyseus default is 20×/s): other players' positions arrive fresher,
    // so they look less behind. Costs ~1.5× the (small) state bandwidth.
    this.patchRate = PATCH_MS;
  }

  /**
   * Spectators can come in any time (while there are spectator seats). Players only before a
   * match starts, and only while there are playing seats. (Rooms are never locked, or
   * spectators couldn't join a match in progress.)
   */
  onAuth(_client: Client, options: ArenaOptions) {
    if (options?.spectate) {
      if (this.spectatorCount() >= MAX_SPECTATORS) throw new Error("No spectator seats left in this room.");
      return true;
    }
    const phase = this.state.matchPhase;
    if (phase === "live" || phase === "ended") throw new Error("A match is in progress: you can watch it, or try again in a moment.");
    if (this.playerCount() >= this.state.maxPlayers) throw new Error("This room is full: you can still watch.");
    return true;
  }

  onJoin(client: Client, options: ArenaOptions) {
    const player = new Player();
    player.name = cleanText(options?.playerName, NAME_MAX_LENGTH) || `Player ${this.clients.length}`;
    player.joinedAt = this.clock.currentTime;
    player.lastActiveAt = this.clock.currentTime;
    // Two people grabbing the last seat at once: the second one watches instead.
    const phase = this.state.matchPhase;
    const canPlay = (phase === "warmup" || phase === "countdown") && this.playerCount() < this.state.maxPlayers;
    if (options?.spectate || !canPlay) {
      player.spectator = true;
      player.alive = false;
      player.slots.forEach((s) => setSlot(s, ""));
    } else {
      if (this.mode === "teams") this.setTeam(player, this.smallerTeam());
      else player.color = COLORS[this.state.players.size % COLORS.length];
      this.respawn(player);
    }

    this.state.players.set(client.sessionId, player);
    this.heldKeys.set(client.sessionId, { ...NO_INPUT });
    this.ensureHost();
    this.fillBots();
    const as = player.spectator ? "spectator" : player.team ? `${player.team} team` : "player";
    console.log(`[${this.roomId}] ${player.name} joined as ${as} (${this.playerCount()}/${this.state.maxPlayers} players)`);
  }

  onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) this.dismount(player, client.sessionId, false);
    // Leaving mid-match: your gear stays on the ground for others.
    if (player?.alive && this.state.matchPhase === "live") this.dropEverything(player);
    this.state.players.delete(client.sessionId);
    this.heldKeys.delete(client.sessionId);
    this.lastInputAt.delete(client.sessionId);
    console.log(`[${this.roomId}] ${player?.name ?? client.sessionId} left`);
    // The host left: the player who has been here longest takes over.
    this.ensureHost();
    this.fillBots();
  }

  /** Bots are players without a client (practice rooms only). */
  private isBot(sessionId: string): boolean {
    return sessionId.startsWith(BOT_ID_PREFIX);
  }

  /** Hold a weapon slot (the "slot" message, and bots). */
  private selectSlot(sessionId: string, index: number) {
    const p = this.state.players.get(sessionId);
    const i = Math.floor(Number(index));
    if (!p?.alive || !(i >= 0 && i < SLOT_COUNT) || p.active === i) return;
    p.active = i;
    p.reloading = false;
    p.nextShotAt = Math.max(p.nextShotAt, this.clock.currentTime + SWITCH_DELAY_MS);
  }

  // ---------- Practice bots ----------

  /** What bots can see and do: the same actions a client's messages trigger. */
  private makeBotWorld(): BotWorld {
    const room = this;
    const withPlayer = (id: string, fn: (p: Player) => void) => {
      const p = room.state.players.get(id);
      if (p?.alive) fn(p);
    };
    return {
      get state() {
        return room.state;
      },
      get map() {
        return room.map;
      },
      get nav() {
        return room.nav;
      },
      get teams() {
        return room.mode === "teams";
      },
      get now() {
        return room.clock.currentTime;
      },
      isOutsideZone: (x, y) => room.isOutsideZone(x, y),
      selectSlot: (id, index) => room.selectSlot(id, index),
      reload: (id) => withPlayer(id, (p) => room.startReload(p)),
      pickup: (id) => withPlayer(id, (p) => room.manualPickup(p, id)),
      dropSlot: (id, index) => withPlayer(id, (p) => room.dropSlot(p, id, index)),
    };
  }

  /**
   * Practice rooms: bots take every playing seat that people don't (a person who goes to
   * watch keeps their seat, so "🎮 Play" still works). Team mode keeps the sides even.
   * Only between matches: mid-match the line-up stays as it is.
   */
  private fillBots() {
    if (!this.practice) return;
    const phase = this.state.matchPhase;
    if (phase !== "warmup" && phase !== "countdown") return;
    let people = 0;
    this.state.players.forEach((_p, id) => {
      if (!this.isBot(id)) people++;
    });
    const wanted = people === 0 ? 0 : Math.max(0, this.state.maxPlayers - people);
    const teams = this.mode === "teams";
    while (this.bots.size > wanted) {
      // Take one off the bigger team (any bot in solo).
      const from = teams ? (this.teamSize("blue") >= this.teamSize("red") ? "blue" : "red") : "";
      const id = [...this.bots.keys()].reverse().find((b) => !teams || this.state.players.get(b)?.team === from) ?? [...this.bots.keys()].pop()!;
      this.removeBot(id);
    }
    while (this.bots.size < wanted) this.addBot();
    this.assignBotRoles();
  }

  private addBot() {
    const id = `${BOT_ID_PREFIX}${this.nextBotId++}`;
    const taken = new Set<string>();
    this.state.players.forEach((p) => taken.add(p.name));
    const free = BOT_NAMES.filter((n) => !taken.has(`Bot ${n}`));
    const name = free.length ? free[Math.floor(Math.random() * free.length)] : String(this.nextBotId);
    const p = new Player();
    p.name = `Bot ${name}`;
    p.joinedAt = this.clock.currentTime;
    p.lastActiveAt = this.clock.currentTime;
    if (this.mode === "teams") this.setTeam(p, this.smallerTeam());
    else p.color = COLORS[this.state.players.size % COLORS.length];
    this.respawn(p);
    this.state.players.set(id, p);
    this.heldKeys.set(id, { ...NO_INPUT });
    this.bots.set(id, new BotBrain(id, this.practice!));
  }

  private removeBot(id: string) {
    const p = this.state.players.get(id);
    if (p) this.dismount(p, id, false);
    this.state.players.delete(id);
    this.heldKeys.delete(id);
    this.bots.delete(id);
  }

  private botOnTeam(team: Team): Player | undefined {
    for (const id of this.bots.keys()) {
      const p = this.state.players.get(id);
      if (p && p.team === team) return p;
    }
    return undefined;
  }

  /**
   * Team mode: in teams of 3+, every third bot guards the base instead of attacking; the
   * attackers take turns going up the middle or round either flank.
   */
  private assignBotRoles() {
    if (this.mode !== "teams") return;
    for (const team of TEAMS) {
      const size = this.teamSize(team);
      let n = 0;
      for (const [id, brain] of this.bots) {
        if (this.state.players.get(id)?.team !== team) continue;
        brain.role = size >= 3 && n % 3 === 2 ? "defend" : "attack";
        brain.route = (["mid", "left", "right"] as const)[n % 3 === 2 ? 0 : n % 3 === 1 ? 1 : (Math.floor(n / 3) % 2) * 2];
        n++;
      }
    }
  }

  /** Every tick: each bot decides what it's pressing, just like a client's "input" message. */
  private updateBots(dtMs: number) {
    for (const [id, brain] of this.bots) {
      const p = this.state.players.get(id);
      if (!p) continue;
      p.lastActiveAt = this.clock.currentTime; // bots are never AFK
      this.heldKeys.set(id, { ...brain.update(this.botWorld, p, dtMs) });
    }
    if (BOT_DEBUG && this.clock.currentTime >= this.botDebugAt) {
      this.botDebugAt = this.clock.currentTime + 5000;
      const line = [...this.bots].map(([id, b]) => {
        const p = this.state.players.get(id)!;
        return `${p.name.slice(4)}${p.team ? "/" + p.team[0] : ""}@${Math.round(p.x)},${Math.round(p.y)} ${p.alive ? b.goal : "dead"}`;
      });
      console.log(`[${this.roomId}] bots: ${line.join(" | ")}`);
    }
  }

  /** Practice solo match: every person in it is out (no point making them watch the bots finish). */
  private peopleAllOut(): boolean {
    if (!this.practice) return false;
    let inMatch = false;
    for (const [id, p] of this.state.players) {
      if (this.isBot(id) || p.spectator) continue;
      if (p.alive) return false;
      inMatch = true;
    }
    return inMatch;
  }

  private setHost(sessionId: string) {
    this.state.hostId = sessionId;
    const name = this.state.players.get(sessionId)?.name;
    if (name) void this.setMetadata({ ...this.metadata, hostName: name });
  }

  /** The host must be a player (not a spectator): if not, the longest-here player takes over. */
  private ensureHost() {
    const host = this.state.players.get(this.state.hostId);
    if (host && !host.spectator) return;
    for (const [id, p] of this.state.players) {
      if (!p.spectator && !this.isBot(id)) return this.setHost(id);
    }
    if (!host) this.state.hostId = ""; // only spectators left: a spectator host is better than none
  }

  // ---------- Players, spectators and teams ----------

  private get mode(): GameMode {
    return this.state.mode === "teams" ? "teams" : "solo";
  }

  /** People playing (not spectating). */
  private playerCount(): number {
    let n = 0;
    this.state.players.forEach((p) => {
      if (!p.spectator) n++;
    });
    return n;
  }

  private spectatorCount(): number {
    let n = 0;
    this.state.players.forEach((p) => {
      if (p.spectator) n++;
    });
    return n;
  }

  private teamSize(team: Team): number {
    let n = 0;
    this.state.players.forEach((p) => {
      if (!p.spectator && p.team === team) n++;
    });
    return n;
  }

  /** Each team can have half the room (rounded up). */
  private teamCapacity(): number {
    return Math.ceil(this.state.maxPlayers / 2);
  }

  private smallerTeam(): Team {
    const blue = this.teamSize("blue");
    const red = this.teamSize("red");
    if (blue !== red) return blue < red ? "blue" : "red";
    return Math.random() < 0.5 ? "blue" : "red";
  }

  /** Join a team: its color, and (on the next respawn) its base. */
  private setTeam(p: Player, team: Team) {
    p.team = team;
    p.color = TEAM_COLOR[team];
  }

  /** Same side? (Never true in solo mode, or for yourself vs. yourself: that's handled separately.) */
  private sameTeam(teamA: string, teamB: string): boolean {
    return this.mode === "teams" && teamA !== "" && teamA === teamB;
  }

  /** Enough players for a match: 2+, and in team mode at least one on each side. */
  private enoughPlayers(): boolean {
    if (this.playerCount() < MATCH_MIN_PLAYERS) return false;
    return this.mode !== "teams" || (this.teamSize("blue") > 0 && this.teamSize("red") > 0);
  }

  /** Stop playing and just watch. Mid-match, your gear drops where you stood. */
  private makeSpectator(p: Player, sessionId: string) {
    this.dismount(p, sessionId, false);
    if (p.alive && this.state.matchPhase === "live") this.dropEverything(p);
    p.spectator = true;
    p.alive = false;
    p.hp = PLAYER_MAX_HP;
    p.armor = 0;
    setBoots(p, 0);
    p.reloading = false;
    p.place = 0;
    p.team = "";
    p.slots.forEach((s) => setSlot(s, ""));
    this.heldKeys.set(sessionId, { ...NO_INPUT });
    this.ensureHost();
  }

  /**
   * Team mode, at match start: even out the teams (at most one apart), moving whoever
   * joined last. Those players respawn at their new base with everyone else.
   */
  private balanceTeams() {
    if (this.mode !== "teams") return;
    for (;;) {
      const blue = this.teamSize("blue");
      const red = this.teamSize("red");
      if (Math.abs(blue - red) <= 1) return;
      const from: Team = blue > red ? "blue" : "red";
      let newest: Player | undefined;
      this.state.players.forEach((p) => {
        if (!p.spectator && p.team === from && (!newest || p.joinedAt > newest.joinedAt)) newest = p;
      });
      if (!newest) return;
      this.setTeam(newest, otherTeam(from));
    }
  }

  /** Keep the lobby's room list up to date (only sends when something changed). */
  private syncListing() {
    const s = this.state;
    const meta = {
      ...this.metadata,
      mode: this.mode,
      players: this.playerCount(),
      maxPlayers: s.maxPlayers,
      spectators: this.spectatorCount(),
      phase: s.matchPhase,
    };
    const key = `${meta.players}:${meta.spectators}:${meta.phase}:${meta.hostName}`;
    if (key === this.listingKey) return;
    this.listingKey = key;
    void this.setMetadata(meta);
  }

  /**
   * Warmup: an AFK host would leave everyone waiting for a full room. After hostIdleMs
   * without input (counted from joining), the player who has been here longest *and* has
   * actually played in that time becomes host. (If nobody else has, the host stays.)
   */
  private replaceIdleHost(now: number) {
    const s = this.state;
    const host = s.players.get(s.hostId);
    if (!host || now - host.lastActiveAt < hostIdleMs) return;
    for (const [id, p] of s.players) {
      if (id !== s.hostId && !p.spectator && !this.isBot(id) && now - (this.lastInputAt.get(id) ?? -Infinity) < hostIdleMs) {
        console.log(`[${this.roomId}] ${host.name} is AFK, ${p.name} is the host now`);
        this.setHost(id);
        return;
      }
    }
  }

  // ---------- Game loop ----------

  private tick(dtMs: number) {
    const now = this.clock.currentTime;
    this.updateMatch(now);
    const live = this.state.matchPhase === "live";
    const teams = this.mode === "teams";
    if (live) {
      this.state.matchSeconds = Math.floor((now - this.matchStart) / 1000);
      if (!teams) this.updateZone(now); // team matches have no shrinking zone
    }
    const practice = this.state.matchPhase === "warmup" || this.state.matchPhase === "countdown";
    if (this.bots.size) this.updateBots(dtMs);

    this.state.players.forEach((player, sessionId) => {
      if (player.spectator) return;
      const input = this.heldKeys.get(sessionId) ?? NO_INPUT;

      if (!player.alive) {
        // Warmup: everyone respawns. Solo match: dead means out. Team match: back at your base.
        if ((practice || (live && teams)) && now >= player.respawnAt) this.respawn(player);
        return;
      }

      // Team mode: standing at your own base heals you (the "fountain").
      if (teams && isTeam(player.team) && player.hp < PLAYER_MAX_HP) {
        const base = BASES[player.team];
        if (Math.hypot(player.x - base.x, player.y - base.y) <= FOUNTAIN_RADIUS) {
          player.healCarry += (FOUNTAIN_HEAL_PER_SEC * dtMs) / 1000;
          const whole = Math.floor(player.healCarry);
          if (whole > 0) {
            player.healCarry -= whole;
            player.hp = Math.min(PLAYER_MAX_HP, player.hp + whole);
          }
        }
      }

      const slot = player.slots[player.active];
      const held = heldStats(slot.weapon);
      const vehicle = player.vehicle ? this.state.vehicles.get(player.vehicle) : undefined;
      if (vehicle && isVehicleKind(vehicle.kind)) {
        // Riding: the vehicle's speed and size (weapons and boots don't matter), it goes where you go.
        const stats = VEHICLES[vehicle.kind];
        applyInput(player, input, dtMs, this.map, stats.speedMul, stats.radius);
        vehicle.x = player.x;
        vehicle.y = player.y;
        if (isMoving(input)) {
          const want = Math.atan2((input.down ? 1 : 0) - (input.up ? 1 : 0), (input.right ? 1 : 0) - (input.left ? 1 : 0));
          const turn = angleDelta(vehicle.heading, want);
          const max = (VEHICLE_TURN_PER_SEC * dtMs) / 1000;
          vehicle.heading += Math.max(-max, Math.min(max, turn));
          if (stats.ramDamage > 0) this.ram(player.vehicle, vehicle, sessionId, player, now);
          if (!player.alive) return;
        }
      } else {
        applyInput(player, input, dtMs, this.map, held.moveMul * (player.boots > 0 ? BOOTS_SPEED_MUL : 1));
        // Speed boots wear out while you run (only while moving), then they're gone.
        if (player.boots > 0 && isMoving(input)) setBoots(player, player.bootsMs - dtMs);
      }
      player.angle = input.angle;

      // In the red: lose ZONE_DAMAGE_PER_SEC the moment you touch it, then again every second.
      // (Stepping in and out can't hurt you faster than once per second. Vests don't help.)
      if (this.isOutsideZone(player.x, player.y) && now >= player.nextZoneDamageAt) {
        player.nextZoneDamageAt = now + 1000;
        this.hurt(player, sessionId, "", ZONE_DAMAGE_PER_SEC, now, "zone");
        if (!player.alive) return;
      }

      // Finish a reload.
      const gun = gunStats(slot.weapon);
      if (player.reloading && now >= player.reloadEndsAt) {
        if (gun) {
          const rounds = Math.min(gun.mag - slot.ammo, slot.reserve);
          slot.ammo += rounds;
          slot.reserve -= rounds;
        }
        player.reloading = false;
      }

      // Attack while the mouse is held: shoot, or swing a melee weapon / fists.
      if (input.fire && !player.reloading && now >= player.nextShotAt) {
        if (gun) {
          if (slot.ammo > 0) {
            if (gun.thrown) this.throwGrenade(sessionId, player, slot, gun, now);
            else this.fire(sessionId, player, slot, gun, now);
            if (slot.ammo === 0 && slot.reserve === 0 && gun.thrown) setSlot(slot, ""); // last grenade thrown
            else if (slot.ammo === 0) this.startReload(player);
          } else {
            this.startReload(player); // does nothing if there are no spare rounds either
          }
        } else {
          this.swing(sessionId, player, (slot.weapon || "fists") as WeaponId, held as MeleeStats, now);
        }
      }

      this.autoPickup(player, sessionId, now);
    });

    if (teams && this.state.matchPhase === "live") {
      this.fireTurrets(now); // warmup is free practice
      this.resupply(now);
    }
    this.moveBullets(dtMs, now);
    this.moveGrenades(dtMs, now);
    this.kickIdlePlayers(now);
    if (this.state.matchPhase === "warmup") this.replaceIdleHost(now);
    this.syncListing();
  }

  // ---------- Team bases ----------

  /** Both cores back to full health (team mode), or no cores at all (solo). Health scales with the player count. */
  private resetCores() {
    const cores = this.state.cores;
    if (this.mode !== "teams") {
      cores.clear();
      return;
    }
    const maxHp = coreMaxHp(this.playerCount());
    for (const team of TEAMS) {
      const core = cores.get(team) ?? new Core();
      core.team = team;
      core.x = BASES[team].x;
      core.y = BASES[team].y;
      core.maxHp = maxHp;
      core.hp = maxHp;
      core.nextShotAt = 0;
      if (!cores.has(team)) cores.set(team, core);
    }
  }

  /** Each core shoots the closest enemy in range that it can see. */
  private fireTurrets(now: number) {
    const gun = gunStats("turret")!;
    this.state.cores.forEach((core) => {
      if (core.hp <= 0 || now < core.nextShotAt) return;
      let target: Player | undefined;
      let best = TURRET_RANGE;
      this.state.players.forEach((p) => {
        if (p.spectator || !p.alive || p.team === core.team) return;
        const d = Math.hypot(p.x - core.x, p.y - core.y) - PLAYER_RADIUS;
        if (d <= best && this.clearLine(core.x, core.y, p.x, p.y, CORE_RADIUS + 2)) {
          best = d;
          target = p;
        }
      });
      if (!target) {
        // Nobody in sight: look again in a moment (line-of-sight checks are the costly part).
        core.nextShotAt = now + TURRET_SCAN_MS;
        return;
      }
      core.nextShotAt = now + gun.fireMs;
      const aim = Math.atan2(target.y - core.y, target.x - core.x);
      const angle = aim + (Math.random() * 2 - 1) * gun.spread;
      const start = CORE_RADIUS + 6; // from the edge of the tower, not inside it
      const bullet: Bullet = {
        id: this.nextBulletId++,
        owner: `core:${core.team}`,
        team: core.team,
        weapon: "turret",
        damage: gun.damage,
        speed: gun.bulletSpeed,
        x: core.x + Math.cos(angle) * start,
        y: core.y + Math.sin(angle) * start,
        vx: Math.cos(angle) * gun.bulletSpeed,
        vy: Math.sin(angle) * gun.bulletSpeed,
        expiresAt: now + gun.bulletLifeMs,
      };
      const shot: ShotEvent = { id: bullet.id, owner: bullet.owner, weapon: "turret", x: bullet.x, y: bullet.y, angle };
      this.broadcast("shot", shot);
      this.bullets.push(bullet);
    });
  }

  /** The enemy core at (x, y), if a point there is inside one. */
  private coreAt(x: number, y: number, pad = 1): Core | undefined {
    for (const core of this.state.cores.values()) {
      if (Math.hypot(core.x - x, core.y - y) <= CORE_RADIUS + pad) return core;
    }
    return undefined;
  }

  /** Damage a core (enemies only). At 0 the match is over: that team lost. */
  private hurtCore(core: Core, attackerTeam: string, amount: number, now: number) {
    if (this.state.matchPhase !== "live" || core.hp <= 0 || attackerTeam === core.team || !attackerTeam) return;
    core.hp = Math.max(0, core.hp - Math.round(amount));
    if (core.hp > 0) return;
    const ev: CoreDestroyedEvent = { team: core.team, x: core.x, y: core.y };
    this.broadcast("coreDestroyed", ev);
    console.log(`[${this.roomId}] ${TEAM_NAME[core.team as Team] ?? core.team} base destroyed`);
    this.endMatch(now, otherTeam(core.team as Team));
  }

  private fire(owner: string, player: Player, slot: WeaponSlot, gun: GunStats, now: number) {
    slot.ammo--;
    player.nextShotAt = now + gun.fireMs;
    player.revealedUntil = now + REVEAL_MS;

    const muzzle = muzzlePosition(player, player.angle, gun.muzzle);
    // Pressed against a wall? The barrel is inside it, so the shot stops right there
    // (no shooting through cover). A rocket goes off in your face.
    let freeX = player.x;
    let freeY = player.y;
    let blocked: { x: number; y: number } | null = null;
    for (let i = 1; i <= 5; i++) {
      const t = i / 5;
      const x = player.x + (muzzle.x - player.x) * t;
      const y = player.y + (muzzle.y - player.y) * t;
      if (this.map.pointBlocked(x, y, true)) {
        blocked = { x, y };
        break;
      }
      freeX = x;
      freeY = y;
    }

    // A shotgun fires a fan of pellets (evenly spread with a little jitter); other guns one bullet.
    const pellets = gun.pellets ?? 1;
    for (let k = 0; k < pellets; k++) {
      const angle =
        pellets > 1
          ? player.angle + gun.spread * (((k + 0.5) / pellets) * 2 - 1) + ((Math.random() * 2 - 1) * gun.spread) / pellets
          : player.angle + (Math.random() * 2 - 1) * gun.spread;
      const bullet: Bullet = {
        id: this.nextBulletId++,
        owner,
        team: player.team,
        weapon: slot.weapon as WeaponId,
        damage: gun.damage,
        speed: gun.bulletSpeed,
        x: muzzle.x,
        y: muzzle.y,
        vx: Math.cos(angle) * gun.bulletSpeed,
        vy: Math.sin(angle) * gun.bulletSpeed,
        expiresAt: now + gun.bulletLifeMs,
        splash: gun.splash,
      };
      const shot: ShotEvent = { id: bullet.id, owner, weapon: bullet.weapon, x: bullet.x, y: bullet.y, angle };
      if (k > 0) shot.pellet = true;
      this.broadcast("shot", shot);

      if (blocked) {
        const end: BulletEndEvent = { id: bullet.id, x: blocked.x, y: blocked.y, hit: "" };
        this.broadcast("bulletEnd", end);
        if (bullet.splash) this.explode(freeX, freeY, owner, bullet.weapon, bullet.splash, now, player.team);
        else {
          // Point-blank against the enemy core still counts.
          const core = this.coreAt(blocked.x, blocked.y);
          if (core) this.hurtCore(core, player.team, bullet.damage, now);
        }
      } else {
        this.bullets.push(bullet);
      }
    }
  }

  private moveBullets(dtMs: number, now: number) {
    const dt = dtMs / 1000;
    const survivors: Bullet[] = [];

    for (const b of this.bullets) {
      // Move in small sub-steps so fast bullets can't skip over a player or thin cover.
      const steps = Math.ceil((b.speed * dt) / BULLET_STEP_PX);
      let hit = "";
      let armored = false;
      let gone = false;
      // Last spot not inside a wall (a rocket explodes there, not inside the wall).
      let freeX = b.x;
      let freeY = b.y;

      for (let s = 0; s < steps && !gone; s++) {
        freeX = b.x;
        freeY = b.y;
        b.x += (b.vx * dt) / steps;
        b.y += (b.vy * dt) / steps;

        if (b.x < 0 || b.y < 0 || b.x > ARENA_SIZE || b.y > ARENA_SIZE) {
          b.x = clamp(b.x, 0, ARENA_SIZE);
          b.y = clamp(b.y, 0, ARENA_SIZE);
          gone = true;
          break;
        }

        if (this.map.pointBlocked(b.x, b.y)) {
          gone = true; // stopped by cover (or a core: the enemy's takes the hit)
          const core = b.splash ? undefined : this.coreAt(b.x, b.y);
          if (core) this.hurtCore(core, b.team, b.damage, now);
          break;
        }

        this.state.players.forEach((target, targetId) => {
          // Bullets fly through teammates (no friendly fire) and spectators.
          if (gone || targetId === b.owner || !target.alive || target.spectator || this.sameTeam(b.team, target.team)) return;
          if (Math.hypot(target.x - b.x, target.y - b.y) <= PLAYER_RADIUS) {
            gone = true;
            if (b.splash) return; // the explosion below does the damage
            hit = targetId;
            armored = this.hurt(target, targetId, b.owner, b.damage, now, b.weapon);
          }
        });
      }

      if (!gone && now >= b.expiresAt) gone = true;

      if (gone) {
        const end: BulletEndEvent = { id: b.id, x: b.x, y: b.y, hit, armored };
        this.broadcast("bulletEnd", end);
        if (b.splash) {
          const inWall = this.map.pointBlocked(b.x, b.y) || b.x <= 0 || b.y <= 0 || b.x >= ARENA_SIZE || b.y >= ARENA_SIZE;
          this.explode(inWall ? freeX : b.x, inWall ? freeY : b.y, b.owner, b.weapon, b.splash, now, b.team);
        }
      } else {
        survivors.push(b);
      }
    }

    this.bullets = survivors;
  }

  // ---------- Explosives ----------

  /** Throw a grenade from your hand in the direction you aim. */
  private throwGrenade(owner: string, player: Player, slot: WeaponSlot, gun: GunStats, now: number) {
    slot.ammo--;
    player.nextShotAt = now + gun.fireMs;
    player.revealedUntil = now + REVEAL_MS;
    const angle = player.angle + (Math.random() * 2 - 1) * gun.spread;
    const hand = muzzlePosition(player, player.angle, gun.muzzle);
    const g = new Grenade();
    // Up against a wall: it drops at your feet instead of inside the wall.
    const start = this.map.pointBlocked(hand.x, hand.y, true) ? { x: player.x, y: player.y } : hand;
    g.x = start.x;
    g.y = start.y;
    g.owner = owner;
    g.vx = Math.cos(angle) * gun.bulletSpeed;
    g.vy = Math.sin(angle) * gun.bulletSpeed;
    g.explodesAt = now + gun.bulletLifeMs;
    this.state.grenades.set(String(this.nextBulletId++), g);
  }

  /** Grenades roll, slow down, bounce off walls and the map edge, then go off. */
  private moveGrenades(dtMs: number, now: number) {
    const dt = dtMs / 1000;
    const stats = gunStats("grenade")!;
    this.state.grenades.forEach((g, id) => {
      if (now >= g.explodesAt) {
        this.state.grenades.delete(id);
        this.explode(g.x, g.y, g.owner, "grenade", stats.splash!, now, this.state.players.get(g.owner)?.team ?? "");
        return;
      }
      const speed = Math.hypot(g.vx, g.vy);
      if (speed <= 0) return;
      const slowed = Math.max(0, speed - GRENADE_FRICTION * dt) / speed;
      g.vx *= slowed;
      g.vy *= slowed;
      const steps = Math.max(1, Math.ceil((speed * dt) / 6));
      for (let i = 0; i < steps; i++) {
        const nx = g.x + (g.vx * dt) / steps;
        if (nx < 4 || nx > ARENA_SIZE - 4 || this.map.pointBlocked(nx, g.y)) g.vx = -g.vx * GRENADE_BOUNCE;
        else g.x = nx;
        const ny = g.y + (g.vy * dt) / steps;
        if (ny < 4 || ny > ARENA_SIZE - 4 || this.map.pointBlocked(g.x, ny)) g.vy = -g.vy * GRENADE_BOUNCE;
        else g.y = ny;
      }
    });
  }

  /**
   * Boom: hurts everyone in the radius who isn't behind a wall (less the further away).
   * `team` is the thrower's team: teammates are spared (the thrower isn't), and an enemy
   * core caught in the blast takes the damage too.
   */
  private explode(x: number, y: number, owner: string, weapon: WeaponId, splash: SplashStats, now: number, team = "") {
    const hurtList: { target: Player; id: string; damage: number }[] = [];
    const falloff = (dist: number) => splash.damage - (splash.damage - splash.minDamage) * (dist / splash.radius);
    this.state.players.forEach((target, id) => {
      if (!target.alive || target.spectator) return;
      if (id !== owner && this.sameTeam(team, target.team)) return;
      const dist = Math.max(0, Math.hypot(target.x - x, target.y - y) - PLAYER_RADIUS);
      if (dist > splash.radius || !this.clearLine(x, y, target.x, target.y)) return;
      let damage = falloff(dist);
      if (id === owner) damage *= SELF_SPLASH_MUL;
      hurtList.push({ target, id, damage: Math.round(damage) });
    });
    // Tell clients first so the blast shows before any "kill" messages it causes.
    const ev: ExplosionEvent = { x, y, radius: splash.radius, owner, weapon, hits: hurtList.map((h) => h.id) };
    this.broadcast("explosion", ev);
    for (const h of hurtList) this.hurt(h.target, h.id, owner, h.damage, now, weapon);
    this.state.cores.forEach((core) => {
      const dist = Math.max(0, Math.hypot(core.x - x, core.y - y) - CORE_RADIUS);
      if (dist <= splash.radius && this.clearLine(x, y, core.x, core.y, 0, CORE_RADIUS + 2)) this.hurtCore(core, team, falloff(dist), now);
    });
  }

  /**
   * Nothing solid between two points (sampled every few pixels). `skipStart` / `skipEnd`
   * ignore that many pixels at either end (e.g. the core a turret shot starts from).
   */
  private clearLine(x0: number, y0: number, x1: number, y1: number, skipStart = 0, skipEnd = 0): boolean {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.ceil(len / 10);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (t * len < skipStart || (1 - t) * len < skipEnd) continue;
      if (this.map.pointBlocked(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
    }
    return true;
  }

  /** Melee: hits everyone in reach, inside the swing's arc, with nothing solid in between. */
  private swing(owner: string, player: Player, weapon: WeaponId, stats: MeleeStats, now: number) {
    player.nextShotAt = now + stats.swingMs;
    player.revealedUntil = now + REVEAL_MS;
    const hits: string[] = [];

    this.state.players.forEach((target, targetId) => {
      if (targetId === owner || !target.alive || target.spectator || this.sameTeam(player.team, target.team)) return;
      const dx = target.x - player.x;
      const dy = target.y - player.y;
      const dist = Math.hypot(dx, dy);
      // Reach is measured edge to edge (both soldiers are PLAYER_RADIUS wide).
      if (dist - PLAYER_RADIUS * 2 > stats.range) return;
      // Inside the arc? (a little extra for the target's body width)
      const slack = Math.asin(Math.min(1, PLAYER_RADIUS / Math.max(dist, PLAYER_RADIUS)));
      if (Math.abs(angleDelta(player.angle, Math.atan2(dy, dx))) > stats.arc / 2 + slack) return;
      // No hitting through walls.
      for (let t = 0.25; t < 1; t += 0.25) {
        if (this.map.pointBlocked(player.x + dx * t, player.y + dy * t, true)) return;
      }
      this.hurt(target, targetId, owner, stats.damage, now, weapon);
      hits.push(targetId);
    });

    const ev: SwingEvent = { owner, weapon, angle: player.angle, hits };
    this.broadcast("swing", ev);

    // Smacking the enemy core works too (it's big: reach is measured to its edge).
    this.state.cores.forEach((core) => {
      const dx = core.x - player.x;
      const dy = core.y - player.y;
      const dist = Math.hypot(dx, dy);
      if (dist - PLAYER_RADIUS - CORE_RADIUS > stats.range) return;
      const slack = Math.asin(Math.min(1, CORE_RADIUS / Math.max(dist, CORE_RADIUS)));
      if (Math.abs(angleDelta(player.angle, Math.atan2(dy, dx))) > stats.arc / 2 + slack) return;
      this.hurtCore(core, player.team, stats.damage, now);
    });
  }

  /**
   * Damage a player. `attackerId` is "" for the zone. A vest soaks up most of a bullet or
   * melee hit until it runs out (not zone damage). Returns true if the vest took some.
   */
  private hurt(target: Player, targetId: string, attackerId: string, amount: number, now: number, weapon: WeaponId | "zone" | "car"): boolean {
    if (this.state.matchPhase === "ended") return false; // the match is decided: no more damage
    target.revealedUntil = now + REVEAL_MS;

    let armored = false;
    if (weapon !== "zone" && target.armor > 0) {
      const absorbed = Math.min(target.armor, Math.round(amount * VEST_ABSORB));
      target.armor -= absorbed;
      amount -= absorbed;
      armored = absorbed > 0;
    }

    target.hp = Math.max(0, target.hp - amount);
    if (target.hp > 0) return armored;

    const live = this.state.matchPhase === "live";
    const teams = this.mode === "teams";
    if (live && !teams) target.place = this.countAlive(); // e.g. 5 left → 5th place
    this.dismount(target, targetId, false); // the vehicle stays where it was
    target.alive = false;
    target.deaths++;
    target.reloading = false;
    target.respawnAt = now + (live && teams ? TEAM_RESPAWN_MS : RESPAWN_MS);
    this.dropEverything(target);

    const attacker = this.state.players.get(attackerId);
    if (attacker && attackerId !== targetId) attacker.kills++; // blowing yourself up isn't a kill
    // Team score: every enemy taken down (by a player or the base turret) counts for the team.
    if (live && teams) {
      const killerTeam = attacker?.team ?? (attackerId.startsWith("core:") ? attackerId.slice(5) : "");
      if (killerTeam && killerTeam !== target.team) {
        if (killerTeam === "blue") this.state.blueKills++;
        else if (killerTeam === "red") this.state.redKills++;
      }
    }

    const kill: KillEvent = { killer: attackerId, victim: targetId, weapon };
    this.broadcast("kill", kill);
    return armored;
  }

  private startReload(player: Player) {
    const slot = player.slots[player.active];
    const gun = gunStats(slot.weapon);
    if (!gun || !player.alive || player.reloading || slot.ammo >= gun.mag || slot.reserve <= 0) return;
    player.reloading = true;
    player.reloadEndsAt = this.clock.currentTime + gun.reloadMs;
  }

  /** Back in the game: full health, no vest, just the starting pistol. Team mode: at your base. */
  private respawn(player: Player) {
    if (player.spectator) return;
    if (player.vehicle) {
      const v = this.state.vehicles.get(player.vehicle);
      if (v) v.rider = "";
      player.vehicle = "";
    }
    const spot = this.map.findFreeSpot(PLAYER_RADIUS, PLAYER_RADIUS * 2, Math.random, this.spawnArea(player));
    player.x = spot.x;
    player.y = spot.y;
    player.hp = PLAYER_MAX_HP;
    player.armor = 0;
    setBoots(player, 0);
    player.alive = true;
    player.reloading = false;
    player.nextShotAt = 0;
    player.slots.forEach((s) => setSlot(s, ""));
    const start = gunStats(STARTING_WEAPON)!;
    setSlot(player.slots[0], STARTING_WEAPON, start.mag, start.mag * 2);
    player.active = 0;
  }

  // ---------- Vehicles ----------

  /** Park this match's vehicles: some on the roads, and (team mode) a bike and a car at each base. */
  private spawnVehicles() {
    this.state.players.forEach((p) => (p.vehicle = "")); // everyone is on foot again
    this.state.vehicles.clear();
    this.ramReadyAt.clear();
    const add = (kind: VehicleKind, x: number, y: number, heading: number) => {
      const v = new Vehicle();
      v.kind = kind;
      v.x = x;
      v.y = y;
      v.heading = heading;
      this.state.vehicles.set(String(this.nextVehicleId++), v);
    };
    const counts = ROAD_VEHICLES[this.mode];
    for (const kind of ["bike", "car"] as VehicleKind[]) {
      for (let i = 0; i < counts[kind]; i++) {
        const road = ROADS[Math.floor(Math.random() * ROADS.length)];
        const along = road.w > road.h ? 0 : Math.PI / 2; // parked along the road
        const spot = this.map.findFreeSpot(VEHICLES[kind].radius + 6, 4, Math.random, road);
        add(kind, spot.x, spot.y, along + (Math.random() < 0.5 ? 0 : Math.PI));
      }
    }
    if (this.mode === "teams") {
      for (const team of TEAMS) {
        const b = BASES[team];
        // Toward the middle of the map, beside the core.
        const sx = b.x < ARENA_SIZE / 2 ? 1 : -1;
        const sy = b.y < ARENA_SIZE / 2 ? 1 : -1;
        add("bike", b.x + sx * 130, b.y, sx > 0 ? 0 : Math.PI);
        add("car", b.x, b.y + sy * 135, sy > 0 ? Math.PI / 2 : -Math.PI / 2);
      }
    }
  }

  /** Get on the closest free vehicle in reach. You sit in the middle of it. */
  private mount(p: Player, sessionId: string) {
    let best: { v: Vehicle; id: string; d: number } | undefined;
    this.state.vehicles.forEach((v, id) => {
      if (v.rider || !isVehicleKind(v.kind)) return;
      const d = Math.hypot(v.x - p.x, v.y - p.y) - VEHICLES[v.kind].radius;
      if (d <= PLAYER_RADIUS + VEHICLE_REACH && (!best || d < best.d)) best = { v, id, d };
    });
    if (!best) return;
    best.v.rider = sessionId;
    p.vehicle = best.id;
    p.x = best.v.x;
    p.y = best.v.y;
    this.map.resolveCollisions(p, VEHICLES[best.v.kind as VehicleKind].radius);
    best.v.x = p.x;
    best.v.y = p.y;
  }

  /** Get off: the vehicle stays put, you step out beside it (`stepOut` false: you stay where you are). */
  private dismount(p: Player, _sessionId: string, stepOut = true) {
    if (!p.vehicle) return;
    const v = this.state.vehicles.get(p.vehicle);
    p.vehicle = "";
    if (!v) return;
    v.rider = "";
    if (!stepOut || !isVehicleKind(v.kind)) return;
    // Out to the side (left or right of the heading), wherever there's room.
    const out = VEHICLES[v.kind].width / 2 + PLAYER_RADIUS + 4;
    for (const side of [Math.PI / 2, -Math.PI / 2, Math.PI, 0]) {
      const a = v.heading + side;
      const x = clamp(v.x + Math.cos(a) * out, PLAYER_RADIUS, ARENA_SIZE - PLAYER_RADIUS);
      const y = clamp(v.y + Math.sin(a) * out, PLAYER_RADIUS, ARENA_SIZE - PLAYER_RADIUS);
      const pos = { x, y };
      this.map.resolveCollisions(pos, PLAYER_RADIUS);
      if (Math.hypot(pos.x - x, pos.y - y) < 1) {
        p.x = x;
        p.y = y;
        return;
      }
    }
  }

  /** A car driving into an enemy: damage and a shove (at most once per RAM_COOLDOWN_MS per victim). */
  private ram(vehicleId: string, v: Vehicle, driverId: string, driver: Player, now: number) {
    const stats = VEHICLES[v.kind as VehicleKind];
    this.state.players.forEach((target, targetId) => {
      if (targetId === driverId || !target.alive || target.spectator || this.sameTeam(driver.team, target.team)) return;
      const dx = target.x - v.x;
      const dy = target.y - v.y;
      const dist = Math.hypot(dx, dy);
      if (dist > stats.radius + PLAYER_RADIUS) return;
      const key = `${vehicleId}:${targetId}`;
      if (now < (this.ramReadyAt.get(key) ?? 0)) return;
      this.ramReadyAt.set(key, now + RAM_COOLDOWN_MS);
      // Shoved out of the way (a rider stays on their own vehicle, so move that too).
      const nx = dist > 0.01 ? dx / dist : Math.cos(v.heading);
      const ny = dist > 0.01 ? dy / dist : Math.sin(v.heading);
      const theirs = target.vehicle ? this.state.vehicles.get(target.vehicle) : undefined;
      const radius = theirs && isVehicleKind(theirs.kind) ? VEHICLES[theirs.kind].radius : PLAYER_RADIUS;
      target.x = clamp(target.x + nx * RAM_PUSH_PX, radius, ARENA_SIZE - radius);
      target.y = clamp(target.y + ny * RAM_PUSH_PX, radius, ARENA_SIZE - radius);
      this.map.resolveCollisions(target, radius);
      if (theirs) {
        theirs.x = target.x;
        theirs.y = target.y;
      }
      const ev: RamEvent = { owner: driverId, victim: targetId, x: target.x, y: target.y };
      this.broadcast("ram", ev);
      this.hurt(target, targetId, driverId, stats.ramDamage, now, "car");
    });
  }

  // ---------- Items on the ground ----------

  /**
   * Scatter the match's loot. `players`: how many are in the match (ammo scales with it, and
   * in team matches weapons and medkits too). Solo: nothing else appears by itself later.
   */
  private spawnLoot(players: number) {
    this.state.items.clear();
    this.lootStartCount.clear();
    const teams = this.mode === "teams";
    for (const entry of LOOT_TABLE) {
      const count =
        entry.count + (entry.perPlayer ?? 0) * players + (teams ? Math.round((entry.teamPerPlayer ?? 0) * players) : 0);
      this.lootStartCount.set(entry.item, (this.lootStartCount.get(entry.item) ?? 0) + count);
      for (let i = 0; i < count; i++) {
        const spot = this.map.findFreeSpot(PICKUP_RADIUS + PLAYER_RADIUS * 2, 60);
        const item = new GroundItem();
        item.kind = entry.item;
        item.x = spot.x;
        item.y = spot.y;
        if (entry.item === "weapon" && entry.weapon) {
          item.weapon = entry.weapon;
          const gun = gunStats(entry.weapon);
          if (gun) {
            item.ammo = gun.mag;
            item.reserve = gun.lootReserve;
          }
        }
        if (entry.item === "vest") item.armor = VEST_ARMOR;
        if (entry.item === "boots") item.charge = 100;
        this.state.items.set(String(this.nextItemId++), item);
      }
    }
  }

  /**
   * Team matches never end by running out of players, so ammo and medkits would run out
   * instead: every RESUPPLY_MS, for each of those kinds with fewer lying around than half of
   * what the match started with, drop a new one somewhere random (never inside a base, so
   * nobody camps a stash).
   */
  private resupply(now: number) {
    if (now < this.nextResupplyAt) return;
    this.nextResupplyAt = now + RESUPPLY_MS;
    const onMap = new Map<string, number>();
    this.state.items.forEach((it) => onMap.set(it.kind, (onMap.get(it.kind) ?? 0) + 1));
    for (const kind of RESUPPLY_ITEMS) {
      const start = this.lootStartCount.get(kind) ?? 0;
      if ((onMap.get(kind) ?? 0) < Math.ceil(start * RESUPPLY_MIN_FRACTION)) this.dropSupply(kind);
    }
  }

  /** One supply item drops in somewhere random outside the bases (with a drop-in effect on clients). */
  private dropSupply(kind: (typeof RESUPPLY_ITEMS)[number]) {
    let spot = this.map.findFreeSpot(PICKUP_RADIUS + PLAYER_RADIUS * 2, 60);
    for (let i = 0; i < 20 && TEAMS.some((t) => Math.hypot(spot.x - BASES[t].x, spot.y - BASES[t].y) < BASE_CLEAR_RADIUS + 60); i++) {
      spot = this.map.findFreeSpot(PICKUP_RADIUS + PLAYER_RADIUS * 2, 60);
    }
    const item = new GroundItem();
    item.kind = kind;
    item.x = spot.x;
    item.y = spot.y;
    const id = String(this.nextItemId++);
    // Announce first, so clients know to animate the box when it shows up in the state.
    const ev: SupplyDropEvent = { id, x: spot.x, y: spot.y };
    this.broadcast("supplyDrop", ev);
    this.state.items.set(id, item);
  }

  /** Put an item on the ground near (x, y), somewhere not inside a wall. */
  private placeItem(item: GroundItem, x: number, y: number, droppedBy = "") {
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = i === 0 ? 0 : 18 + Math.random() * 22;
      const px = clamp(x + Math.cos(a) * d, 20, ARENA_SIZE - 20);
      const py = clamp(y + Math.sin(a) * d, 20, ARENA_SIZE - 20);
      if (!this.map.pointBlocked(px, py)) {
        item.x = px;
        item.y = py;
        break;
      }
      item.x = x;
      item.y = y;
    }
    item.droppedBy = droppedBy;
    item.noAutoPickupUntil = droppedBy ? this.clock.currentTime + DROP_BLOCK_MS : 0;
    this.state.items.set(String(this.nextItemId++), item);
  }

  /** G: drop a slot's weapon at your feet (with whatever ammo it has). */
  private dropSlot(player: Player, playerId: string, index: number) {
    const slot = player.slots[index];
    if (!slot?.weapon) return;
    const item = new GroundItem();
    item.kind = "weapon";
    item.weapon = slot.weapon;
    item.ammo = slot.ammo;
    item.reserve = slot.reserve;
    const ahead = 26;
    this.placeItem(item, player.x + Math.cos(player.angle) * ahead, player.y + Math.sin(player.angle) * ahead, playerId);
    setSlot(slot, "");
    if (index === player.active) {
      player.reloading = false;
      // Hold the next weapon you still have, if any.
      for (let k = 1; k < SLOT_COUNT; k++) {
        const j = (index + k) % SLOT_COUNT;
        if (player.slots[j].weapon) {
          player.active = j;
          break;
        }
      }
    }
  }

  /** On death (or leaving mid-match): everything you carried falls on the ground. */
  private dropEverything(player: Player) {
    player.slots.forEach((slot) => {
      if (!slot.weapon) return;
      const item = new GroundItem();
      item.kind = "weapon";
      item.weapon = slot.weapon;
      item.ammo = slot.ammo;
      item.reserve = slot.reserve;
      this.placeItem(item, player.x, player.y);
      setSlot(slot, "");
    });
    if (player.armor > 0) {
      const vest = new GroundItem();
      vest.kind = "vest";
      vest.armor = player.armor;
      this.placeItem(vest, player.x, player.y);
      player.armor = 0;
    }
    if (player.boots > 0) {
      const boots = new GroundItem();
      boots.kind = "boots";
      boots.charge = player.boots;
      this.placeItem(boots, player.x, player.y);
      setBoots(player, 0);
    }
  }

  /** Walking over items: take what fits without a choice. Full slots need E. */
  private autoPickup(player: Player, playerId: string, now: number) {
    this.state.items.forEach((item, id) => {
      if (Math.hypot(item.x - player.x, item.y - player.y) > ITEM_REACH) return;
      if (item.droppedBy === playerId && now < item.noAutoPickupUntil) return;
      this.take(player, playerId, item, id, false);
    });
  }

  /** E: the closest item in reach, swapping with the weapon in your hand if your slots are full. */
  private manualPickup(player: Player, playerId: string) {
    let best: { item: GroundItem; id: string; d: number } | null = null;
    this.state.items.forEach((item, id) => {
      const d = Math.hypot(item.x - player.x, item.y - player.y);
      if (d <= ITEM_REACH + 10 && (!best || d < best.d)) best = { item, id, d };
    });
    if (best) {
      const { item, id } = best;
      this.take(player, playerId, item, id, true);
    }
  }

  /** Try to take one item. `swap` = allowed to swap it with the weapon in hand (E). */
  private take(player: Player, playerId: string, item: GroundItem, itemId: string, swap: boolean) {
    if (item.kind === "medkit") {
      // Heals right away; left on the ground if you're already at full health.
      if (player.hp >= PLAYER_MAX_HP) return;
      player.hp = Math.min(PLAYER_MAX_HP, player.hp + MEDKIT_HEAL);
      this.state.items.delete(itemId);
      return;
    }

    if (item.kind === "ammo") {
      // Ammo box: feeds the gun in your hand, or else the first gun that needs it.
      const order = [player.active, ...SLOT_INDEXES.filter((i) => i !== player.active)];
      for (const i of order) {
        const slot = player.slots[i];
        const gun = gunStats(slot.weapon);
        if (gun && gun.boxAmmo > 0 && slot.reserve < gun.maxReserve) {
          slot.reserve = Math.min(gun.maxReserve, slot.reserve + gun.boxAmmo);
          this.state.items.delete(itemId);
          return;
        }
      }
      return;
    }

    if (item.kind === "vest") {
      if (item.armor <= player.armor && !swap) return; // only auto-take a better vest
      if (player.armor > 0) {
        const old = new GroundItem();
        old.kind = "vest";
        old.armor = player.armor;
        this.placeItem(old, player.x, player.y, playerId);
      }
      player.armor = item.armor;
      this.state.items.delete(itemId);
      return;
    }

    if (item.kind === "boots") {
      if (item.charge <= player.boots && !swap) return; // only auto-take fresher boots
      if (player.boots > 0) {
        const old = new GroundItem();
        old.kind = "boots";
        old.charge = player.boots;
        this.placeItem(old, player.x, player.y, playerId);
      }
      setBoots(player, (item.charge / 100) * BOOTS_DURATION_MS);
      this.state.items.delete(itemId);
      return;
    }

    // A weapon
    const owned = player.slots.find((s) => s.weapon === item.weapon);
    const gun = gunStats(item.weapon);
    if (owned) {
      // Same gun again: take its rounds as spare ammo.
      if (!gun) return;
      const space = gun.maxReserve - owned.reserve;
      const take = Math.min(space, item.ammo + item.reserve);
      if (take <= 0) return;
      owned.reserve += take;
      const fromReserve = Math.min(item.reserve, take);
      item.reserve -= fromReserve;
      item.ammo -= take - fromReserve;
      if (item.ammo + item.reserve <= 0) this.state.items.delete(itemId);
      return;
    }

    // A free slot? Prefer the one in hand if it's empty (fists).
    const free = player.slots[player.active].weapon ? player.slots.findIndex((s) => !s.weapon) : player.active;
    if (free >= 0) {
      setSlot(player.slots[free], item.weapon, item.ammo, item.reserve);
      if (!player.slots[player.active].weapon) player.active = free; // empty hands: hold it
      this.state.items.delete(itemId);
      return;
    }
    if (!swap) return; // slots full: only E swaps
    // Swap: drop what's in hand, put the new weapon in that same slot, and hold it.
    const hand = player.active;
    this.dropSlot(player, playerId, hand);
    setSlot(player.slots[hand], item.weapon, item.ammo, item.reserve);
    player.active = hand;
    player.reloading = false;
    this.state.items.delete(itemId);
  }

  // ---------- Idle players ----------

  private markActive(sessionId: string) {
    const p = this.state.players.get(sessionId);
    if (p) p.lastActiveAt = this.clock.currentTime;
    this.lastInputAt.set(sessionId, this.clock.currentTime);
  }

  /**
   * No input for idleKickMs (forgotten tab, AFK in the final zone…): send them back to
   * the lobby, so an empty server can go to sleep instead of running (and costing) forever.
   */
  private kickIdlePlayers(now: number) {
    this.state.players.forEach((p, id) => {
      if (this.isBot(id) || now - p.lastActiveAt < idleKickMs) return;
      p.lastActiveAt = now; // only try once
      console.log(`[${this.roomId}] ${p.name} kicked for being idle`);
      this.clients.getById(id)?.leave(IDLE_KICK_CODE, "idle");
    });
  }

  // ---------- Match flow ----------
  //
  //  warmup ──(room full, or host starts with 2+)──▶ countdown 5s ──▶ live (no respawns, zone runs)
  //     ▲                        │ (someone left, <2)          │ (≤1 alive)
  //     └────────────────────────┘                              ▼
  //     └──────────────── 8s winner banner ◀──────────────── ended

  private updateMatch(now: number) {
    const s = this.state;
    const players = this.playerCount();
    s.aliveCount = this.countAlive();

    switch (s.matchPhase) {
      case "warmup":
        // Keep the room open until it's full (the host can also start early: "startMatch").
        if (players >= s.maxPlayers && this.enoughPlayers()) this.startCountdown(now);
        break;

      case "countdown":
        if (!this.enoughPlayers()) {
          s.matchPhase = "warmup";
        } else if (now >= this.phaseEndsAt) {
          this.startMatch(now);
        }
        break;

      case "live":
        if (this.mode === "teams") {
          // A side with nobody left (everyone quit or went to watch) loses.
          const blue = this.teamSize("blue");
          const red = this.teamSize("red");
          if (blue === 0 || red === 0) this.endMatch(now, blue > 0 ? "blue" : red > 0 ? "red" : "");
        } else if (s.aliveCount <= 1 || this.peopleAllOut()) {
          this.endMatch(now);
        }
        break;

      case "ended":
        if (now >= this.phaseEndsAt) this.backToWarmup();
        break;
    }

    s.phaseSecondsLeft =
      s.matchPhase === "countdown" || s.matchPhase === "ended" ? Math.max(0, Math.ceil((this.phaseEndsAt - now) / 1000)) : 0;
  }

  /** "Match starts in 5…" (players can still join during it, up to the room size). */
  private startCountdown(now: number) {
    this.state.matchPhase = "countdown";
    this.phaseEndsAt = now + MATCH_COUNTDOWN_MS;
  }

  private startMatch(now: number) {
    const s = this.state;
    s.matchPhase = "live";
    s.winner = "";
    s.winnerTeam = "";
    s.blueKills = 0;
    s.redKills = 0;
    this.matchStart = now;
    s.matchSeconds = 0;
    this.resetZone();
    this.resetCores();
    this.balanceTeams();
    this.assignBotRoles();
    this.nextResupplyAt = now + RESUPPLY_MS;
    this.bullets = [];
    this.state.grenades.clear();
    this.newMap(); // a brand-new random map for every match
    this.spawnLoot(this.playerCount()); // and fresh loot (solo: placed once; teams: ammo and medkits resupply)
    this.spawnVehicles();
    // Everyone starts equal
    s.players.forEach((p) => {
      p.kills = 0;
      p.deaths = 0;
      p.place = 0;
      this.respawn(p);
    });
    s.aliveCount = this.countAlive();
    // (No lock: new players are turned away in onAuth, but spectators can still come and watch.)
    const teams = this.mode === "teams" ? ` (blue ${this.teamSize("blue")} vs red ${this.teamSize("red")})` : "";
    console.log(`[${this.roomId}] match started with ${this.playerCount()} players${teams}`);
  }

  /** `winnerTeam`: team mode only (the team whose enemy core fell, or who still has players). */
  private endMatch(now: number, winnerTeam: Team | "" = "") {
    const s = this.state;
    let winnerId = "";
    if (this.mode === "teams") {
      s.winnerTeam = winnerTeam;
      s.players.forEach((p) => {
        if (!p.spectator) p.place = winnerTeam && p.team === winnerTeam ? 1 : 2;
      });
    } else if (s.aliveCount <= 1) {
      // (A practice match can end with several bots still standing: then nobody wins.)
      s.players.forEach((p, id) => {
        if (p.alive && !p.spectator) {
          winnerId = id;
          p.place = 1;
        }
      });
    }
    s.winner = winnerId;
    s.matchPhase = "ended";
    this.phaseEndsAt = now + MATCH_END_MS;
    this.bullets = [];
    this.state.grenades.clear();
    const who = this.mode === "teams" ? (winnerTeam ? `${TEAM_NAME[winnerTeam]} team` : "nobody") : (s.players.get(winnerId)?.name ?? "nobody");
    console.log(`[${this.roomId}] match over, winner: ${who}`);
  }

  private backToWarmup() {
    const s = this.state;
    s.matchPhase = "warmup";
    s.winner = "";
    s.winnerTeam = "";
    s.matchSeconds = 0;
    this.resetZone();
    this.resetCores();
    s.players.forEach((p) => {
      p.place = 0;
      this.respawn(p);
    });
    this.fillBots(); // practice: someone left or joined mid-match
  }

  /** Generate a random map and tell clients (they rebuild it from the same seed). */
  private newMap() {
    const seed = newMapSeed();
    this.map = new GameMap(seed, this.mode);
    this.state.mapSeed = seed;
    if (this.practice) this.nav = new NavGrid(this.map);
    console.log(`[${this.roomId ?? "new room"}] ${this.mode} map ${seed}: ${this.map.blockThemes.join(", ")}`);
  }

  private countAlive(): number {
    let n = 0;
    this.state.players.forEach((p) => {
      if (p.alive && !p.spectator) n++;
    });
    return n;
  }

  /** Zone back to "the whole map, nothing announced". */
  private resetZone() {
    const z = this.state.zone;
    z.phase = "waiting";
    z.x = 0;
    z.y = 0;
    z.size = ARENA_SIZE;
    z.nextX = 0;
    z.nextY = 0;
    z.nextSize = 0;
    z.secondsLeft = Math.ceil(zoneStartMs / 1000);
  }

  // ---------- Shrinking safe zone ----------
  //
  //  0:00 waiting (zone = whole map)
  //  2:20 hold: first square announced (white outline), zone still the whole map
  //  2:30 shrink: edges close in from the map border to that square, slowly
  //       → hold 10s → shrink 10s → … → final

  private updateZone(now: number) {
    const z = this.state.zone;
    const elapsed = now - this.matchStart;
    this.state.matchSeconds = Math.floor(elapsed / 1000);

    if (z.phase === "waiting") {
      if (elapsed < zoneStartMs - zoneHoldMs) {
        z.secondsLeft = Math.ceil((zoneStartMs - elapsed) / 1000);
        return;
      }
      // Announce the first square; the shrink itself starts at zoneStartMs.
      z.phase = "hold";
      z.phaseStart = now;
      z.phaseEnd = this.matchStart + zoneStartMs;
      this.announceNext(Math.min(ZONE_START_SIZE, ARENA_SIZE));
      console.log(`[${this.roomId}] first zone announced`);
    }

    if (z.phase === "hold" && now >= z.phaseEnd) {
      // Start shrinking toward the already-announced next square.
      z.phase = "shrink";
      z.phaseStart = now;
      z.phaseEnd = now + zoneShrinkMs;
      z.fromX = z.x;
      z.fromY = z.y;
      z.fromSize = z.size;
    }

    if (z.phase === "shrink") {
      const t = Math.min(1, (now - z.phaseStart) / zoneShrinkMs);
      z.x = z.fromX + (z.nextX - z.fromX) * t;
      z.y = z.fromY + (z.nextY - z.fromY) * t;
      z.size = z.fromSize + (z.nextSize - z.fromSize) * t;
      if (t >= 1) this.startHold(now);
    }

    z.secondsLeft = z.phase === "final" ? 0 : Math.max(0, Math.ceil((z.phaseEnd - now) / 1000));
  }

  /** Hold still for a while, and pick (and announce) the next, smaller square inside this one. */
  private startHold(now: number) {
    const z = this.state.zone;
    if (z.size <= ZONE_MIN_SIZE + 0.5) {
      z.phase = "final";
      z.nextX = z.x;
      z.nextY = z.y;
      z.nextSize = z.size;
      return;
    }
    z.phase = "hold";
    z.phaseStart = now;
    z.phaseEnd = now + zoneHoldMs;
    this.announceNext(Math.max(ZONE_MIN_SIZE, z.size * ZONE_SHRINK_FACTOR));
  }

  /** Pick the next square (of `size`) at a random spot inside the current one. */
  private announceNext(size: number) {
    const z = this.state.zone;
    z.nextSize = size;
    z.nextX = z.x + Math.random() * (z.size - size);
    z.nextY = z.y + Math.random() * (z.size - size);
  }

  private isOutsideZone(x: number, y: number): boolean {
    const z = this.state.zone;
    return x < z.x || y < z.y || x > z.x + z.size || y > z.y + z.size;
  }

  /** Where players respawn: their team's base, or (solo) inside the next safe square once one is announced. */
  private spawnArea(player: Player) {
    if (this.mode === "teams" && isTeam(player.team)) {
      const b = BASES[player.team];
      const r = BASE_CLEAR_RADIUS * 0.8; // the square inside the cleared circle
      return { x: b.x - r, y: b.y - r, w: r * 2, h: r * 2 };
    }
    const z = this.state.zone;
    if (z.phase === "waiting") return { x: 0, y: 0, w: ARENA_SIZE, h: ARENA_SIZE };
    return { x: z.nextX, y: z.nextY, w: z.nextSize, h: z.nextSize };
  }
}

function setSlot(slot: WeaponSlot, weapon: string, ammo = 0, reserve = 0) {
  slot.weapon = weapon;
  slot.ammo = ammo;
  slot.reserve = reserve;
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

// Make sure every weapon in the loot table exists (catches typos at startup).
for (const e of LOOT_TABLE) if (e.weapon && !WEAPONS[e.weapon]) throw new Error(`Unknown weapon in LOOT_TABLE: ${e.weapon}`);

/** Speed boots: set the ms of running left (and the synced %, 0 = no boots). */
function setBoots(player: Player, ms: number) {
  player.bootsMs = Math.max(0, ms);
  player.boots = Math.ceil((player.bootsMs / BOOTS_DURATION_MS) * 100);
}
