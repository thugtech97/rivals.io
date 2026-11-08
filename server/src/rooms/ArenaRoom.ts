import { Room, type Client } from "colyseus";
import { AmmoPickup, ArenaState, Player } from "../schema/ArenaState";
import {
  ARENA_SIZE,
  BULLET_DAMAGE,
  BULLET_LIFETIME_MS,
  BULLET_SPEED,
  DEFAULT_PLAYERS_PER_ROOM,
  FIRE_INTERVAL_MS,
  MAG_SIZE,
  MAX_PICKUPS,
  MAX_PLAYERS_PER_ROOM,
  MAX_RESERVE,
  MIN_PLAYERS_PER_ROOM,
  NAME_MAX_LENGTH,
  PICKUP_AMMO,
  PICKUP_RADIUS,
  PICKUP_RESPAWN_MS,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  RELOAD_MS,
  RESPAWN_MS,
  ROOM_NAME_MAX_LENGTH,
  START_RESERVE,
  TICK_MS,
} from "../../../shared/constants";
import { applyInput, clamp, muzzlePosition, NO_INPUT, type InputState } from "../../../shared/movement";
import type { BulletEndEvent, KillEvent, ShotEvent } from "../../../shared/messages";
import { findFreeSpot, pointBlocked } from "../../../shared/map";

/** Bullets are checked every few pixels so they can't skip through thin barricades. */
const BULLET_STEP_PX = 8;

/** Shown in the lobby's room list. */
export interface ArenaMetadata {
  roomName: string;
  hostName: string;
}

interface ArenaOptions {
  roomName?: string;
  maxPlayers?: number;
  playerName?: string;
}

interface Bullet {
  id: number;
  owner: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  expiresAt: number;
}

const COLORS = [0xd9534f, 0x3fa7d6, 0xe0b84a, 0x5cb85c, 0x9b6cd1, 0xe8834a, 0x4a6fd9, 0xd65a9b];

export class ArenaRoom extends Room<{ state: ArenaState; metadata: ArenaMetadata }> {
  private heldKeys = new Map<string, InputState>();
  private bullets: Bullet[] = [];
  private nextBulletId = 1;
  private nextPickupId = 1;
  private nextPickupSpawnAt = 0;

  async onCreate(options: ArenaOptions) {
    this.setState(new ArenaState());

    const requested = Math.round(Number(options.maxPlayers) || DEFAULT_PLAYERS_PER_ROOM);
    this.maxClients = clamp(requested, MIN_PLAYERS_PER_ROOM, MAX_PLAYERS_PER_ROOM);

    const hostName = cleanText(options.playerName, NAME_MAX_LENGTH) || "Someone";
    const roomName = cleanText(options.roomName, ROOM_NAME_MAX_LENGTH) || `${hostName}'s arena`;
    this.state.roomName = roomName;
    await this.setMetadata({ roomName, hostName });

    // Clients only send what they're pressing and where they aim; the server decides the rest.
    this.onMessage("input", (client, input: Partial<InputState>) => {
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
      const player = this.state.players.get(client.sessionId);
      if (player) this.startReload(player);
    });

    for (let i = 0; i < MAX_PICKUPS; i++) this.spawnPickup();

    this.setSimulationInterval((dt) => this.tick(dt), TICK_MS);
  }

  onJoin(client: Client, options: ArenaOptions) {
    const player = new Player();
    player.name = cleanText(options?.playerName, NAME_MAX_LENGTH) || `Player ${this.clients.length}`;
    player.color = COLORS[this.state.players.size % COLORS.length];
    this.respawn(player);

    this.state.players.set(client.sessionId, player);
    this.heldKeys.set(client.sessionId, { ...NO_INPUT });
    console.log(`[${this.roomId}] ${player.name} joined (${this.clients.length}/${this.maxClients})`);
  }

  onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.heldKeys.delete(client.sessionId);
    console.log(`[${this.roomId}] ${player?.name ?? client.sessionId} left`);
  }

  // ---------- Game loop ----------

  private tick(dtMs: number) {
    const now = this.clock.currentTime;

    this.state.players.forEach((player, sessionId) => {
      const input = this.heldKeys.get(sessionId) ?? NO_INPUT;

      if (!player.alive) {
        if (now >= player.respawnAt) this.respawn(player);
        return;
      }

      applyInput(player, input, dtMs);
      player.angle = input.angle;

      // Finish a reload.
      if (player.reloading && now >= player.reloadEndsAt) {
        const rounds = Math.min(MAG_SIZE - player.ammo, player.reserve);
        player.ammo += rounds;
        player.reserve -= rounds;
        player.reloading = false;
      }

      // Shoot while the mouse is held.
      if (input.fire && !player.reloading && now >= player.nextShotAt) {
        if (player.ammo > 0) {
          this.fire(sessionId, player, now);
          if (player.ammo === 0) this.startReload(player);
        } else {
          this.startReload(player); // does nothing if the reserve is empty too
        }
      }

      this.collectPickups(player);
    });

    this.moveBullets(dtMs, now);

    if (this.state.pickups.size < MAX_PICKUPS && now >= this.nextPickupSpawnAt) {
      this.spawnPickup();
      this.nextPickupSpawnAt = now + PICKUP_RESPAWN_MS;
    }
  }

  private fire(owner: string, player: Player, now: number) {
    player.ammo--;
    player.nextShotAt = now + FIRE_INTERVAL_MS;

    const muzzle = muzzlePosition(player, player.angle);
    const bullet: Bullet = {
      id: this.nextBulletId++,
      owner,
      x: muzzle.x,
      y: muzzle.y,
      vx: Math.cos(player.angle) * BULLET_SPEED,
      vy: Math.sin(player.angle) * BULLET_SPEED,
      expiresAt: now + BULLET_LIFETIME_MS,
    };

    const shot: ShotEvent = { id: bullet.id, owner, x: bullet.x, y: bullet.y, angle: player.angle };
    this.broadcast("shot", shot);

    // Pressed against a wall? The barrel is inside it, so the shot stops right there
    // (no shooting through cover).
    for (let i = 1; i <= 4; i++) {
      const t = i / 4;
      const x = player.x + (muzzle.x - player.x) * t;
      const y = player.y + (muzzle.y - player.y) * t;
      if (pointBlocked(x, y)) {
        const end: BulletEndEvent = { id: bullet.id, x, y, hit: "" };
        this.broadcast("bulletEnd", end);
        return;
      }
    }

    this.bullets.push(bullet);
  }

  private moveBullets(dtMs: number, now: number) {
    const dt = dtMs / 1000;
    const survivors: Bullet[] = [];

    for (const b of this.bullets) {
      // Move in small sub-steps so fast bullets can't skip over a player or thin cover.
      const steps = Math.ceil((BULLET_SPEED * dt) / BULLET_STEP_PX);
      let hit = "";
      let gone = false;

      for (let s = 0; s < steps && !gone; s++) {
        b.x += (b.vx * dt) / steps;
        b.y += (b.vy * dt) / steps;

        if (b.x < 0 || b.y < 0 || b.x > ARENA_SIZE || b.y > ARENA_SIZE) {
          b.x = clamp(b.x, 0, ARENA_SIZE);
          b.y = clamp(b.y, 0, ARENA_SIZE);
          gone = true;
          break;
        }

        if (pointBlocked(b.x, b.y)) {
          gone = true; // stopped by cover
          break;
        }

        this.state.players.forEach((target, targetId) => {
          if (gone || targetId === b.owner || !target.alive) return;
          if (Math.hypot(target.x - b.x, target.y - b.y) <= PLAYER_RADIUS) {
            hit = targetId;
            gone = true;
            this.damage(target, targetId, b.owner, now);
          }
        });
      }

      if (!gone && now >= b.expiresAt) gone = true;

      if (gone) {
        const end: BulletEndEvent = { id: b.id, x: b.x, y: b.y, hit };
        this.broadcast("bulletEnd", end);
      } else {
        survivors.push(b);
      }
    }

    this.bullets = survivors;
  }

  private damage(target: Player, targetId: string, attackerId: string, now: number) {
    target.hp = Math.max(0, target.hp - BULLET_DAMAGE);
    if (target.hp > 0) return;

    target.alive = false;
    target.deaths++;
    target.reloading = false;
    target.respawnAt = now + RESPAWN_MS;

    const attacker = this.state.players.get(attackerId);
    if (attacker) attacker.kills++;

    const kill: KillEvent = { killer: attackerId, victim: targetId };
    this.broadcast("kill", kill);
  }

  private startReload(player: Player) {
    if (!player.alive || player.reloading || player.ammo >= MAG_SIZE || player.reserve <= 0) return;
    player.reloading = true;
    player.reloadEndsAt = this.clock.currentTime + RELOAD_MS;
  }

  private respawn(player: Player) {
    const spot = findFreeSpot(PLAYER_RADIUS, PLAYER_RADIUS * 3);
    player.x = spot.x;
    player.y = spot.y;
    player.hp = PLAYER_MAX_HP;
    player.alive = true;
    player.ammo = MAG_SIZE;
    player.reserve = START_RESERVE;
    player.reloading = false;
  }

  // ---------- Ammo crates ----------

  private spawnPickup() {
    const pickup = new AmmoPickup();
    // Leave room around the crate so a soldier can actually reach it.
    const spot = findFreeSpot(PICKUP_RADIUS + PLAYER_RADIUS * 2, 60);
    pickup.x = spot.x;
    pickup.y = spot.y;
    this.state.pickups.set(String(this.nextPickupId++), pickup);
  }

  private collectPickups(player: Player) {
    if (player.reserve >= MAX_RESERVE) return;
    this.state.pickups.forEach((pickup, id) => {
      if (Math.hypot(pickup.x - player.x, pickup.y - player.y) <= PLAYER_RADIUS + PICKUP_RADIUS) {
        player.reserve = Math.min(MAX_RESERVE, player.reserve + PICKUP_AMMO);
        this.state.pickups.delete(id);
        this.nextPickupSpawnAt = Math.max(this.nextPickupSpawnAt, this.clock.currentTime + PICKUP_RESPAWN_MS);
      }
    });
  }
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

