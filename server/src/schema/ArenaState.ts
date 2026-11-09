import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";
import { PLAYER_MAX_HP } from "../../../shared/constants";

/** One inventory slot. weapon "" = empty (you fight with your fists). */
export class WeaponSlot extends Schema {
  @type("string") weapon = "";
  /** Guns only: rounds in the magazine / spare rounds. */
  @type("number") ammo = 0;
  @type("number") reserve = 0;
}

// Only fields marked with @type are sent to clients.

export class Player extends Schema {
  @type("string") name = "";
  @type("number") x = 0;
  @type("number") y = 0;
  /** Aim direction in radians. */
  @type("number") angle = 0;
  /** 0xRRGGBB uniform color. */
  @type("number") color = 0xffffff;

  @type("number") hp = PLAYER_MAX_HP;
  @type("boolean") alive = true;
  @type("number") kills = 0;
  @type("number") deaths = 0;
  /** Finishing place in the current match (1 = winner, 0 = still playing / not ranked). */
  @type("number") place = 0;

  /** Bulletproof vest points (0 = no vest). */
  @type("number") armor = 0;
  /** Speed boots charge left, 0-100 % (0 = no boots). */
  @type("number") boots = 0;
  /** Inventory: SLOT_COUNT weapon slots, and which one is in hand. */
  @type([WeaponSlot]) slots = new ArraySchema<WeaponSlot>(new WeaponSlot(), new WeaponSlot(), new WeaponSlot());
  @type("number") active = 0;
  @type("boolean") reloading = false;

  // Server-only timers (not synced).
  nextShotAt = 0;
  reloadEndsAt = 0;
  respawnAt = 0;
  /** Earliest time the zone may hurt this player again (at most once per second). */
  nextZoneDamageAt = 0;
  /** Last time this player sent any input (for kicking AFK players). */
  lastActiveAt = 0;
  /** Speed boots: ms of running left (`boots` is this as a rounded-up %). */
  bootsMs = 0;
}

/**
 * Something lying on the ground: a weapon, a vest, speed boots, a medkit or an ammo box.
 * Loot is placed once at match start; after that items only appear when someone drops them.
 */
export class GroundItem extends Schema {
  /** "weapon" | "vest" | "ammo" | "medkit" | "boots" */
  @type("string") kind = "ammo";
  @type("string") weapon = "";
  @type("number") ammo = 0;
  @type("number") reserve = 0;
  @type("number") armor = 0;
  /** Speed boots charge, 0-100 %. */
  @type("number") charge = 0;
  @type("number") x = 0;
  @type("number") y = 0;

  // Server-only: whoever dropped it doesn't instantly auto-pick it back up.
  droppedBy = "";
  noAutoPickupUntil = 0;
}

/**
 * The shrinking safe square. Outside it, players take damage.
 * It starts as the whole map, so it never "appears": it closes in from the map edges.
 */
export class Zone extends Schema {
  /** "waiting" (nothing announced yet) | "hold" | "shrink" | "final" */
  @type("string") phase = "waiting";
  /** Whole seconds until the current phase ends. */
  @type("number") secondsLeft = 0;
  /** Current square (top-left corner and side length). */
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") size = 0;
  /** Where it will shrink to next. */
  @type("number") nextX = 0;
  @type("number") nextY = 0;
  @type("number") nextSize = 0;

  // Server-only
  phaseStart = 0;
  phaseEnd = 0;
  fromX = 0;
  fromY = 0;
  fromSize = 0;
}

export class ArenaState extends Schema {
  @type("string") roomName = "";
  /** Room capacity (the lobby's "max players"). */
  @type("number") maxPlayers = 0;
  /** sessionId of the host: the only one who can start the match before the room is full. */
  @type("string") hostId = "";
  /** Clients build the same random map from this seed (see shared/map.ts). */
  @type("number") mapSeed = 0;
  /**
   * "warmup"    practice, dead players respawn; waits for the room to fill
   *             (or for the host to start it with MATCH_MIN_PLAYERS+)
   * "countdown" room full / host started: "Match starts in 5…"
   * "live"      the match: no respawns, the zone runs
   * "ended"     one player left: winner banner, then back to warmup
   */
  @type("string") matchPhase = "warmup";
  /** Whole seconds left in the countdown / winner banner. */
  @type("number") phaseSecondsLeft = 0;
  /** sessionId of the last player alive ("" if nobody survived). */
  @type("string") winner = "";
  @type("number") aliveCount = 0;
  /** Seconds since the match went live. */
  @type("number") matchSeconds = 0;
  @type(Zone) zone = new Zone();
  /** Keyed by the client's sessionId. */
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: GroundItem }) items = new MapSchema<GroundItem>();
}
