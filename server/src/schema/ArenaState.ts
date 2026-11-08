import { Schema, MapSchema, type } from "@colyseus/schema";
import { MAG_SIZE, PLAYER_MAX_HP, START_RESERVE } from "../../../shared/constants";

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

  /** Rounds in the magazine. */
  @type("number") ammo = MAG_SIZE;
  /** Spare rounds for reloading. */
  @type("number") reserve = START_RESERVE;
  @type("boolean") reloading = false;

  // Server-only timers (not synced).
  nextShotAt = 0;
  reloadEndsAt = 0;
  respawnAt = 0;
}

export class AmmoPickup extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
}

export class ArenaState extends Schema {
  @type("string") roomName = "";
  /** Keyed by the client's sessionId. */
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: AmmoPickup }) pickups = new MapSchema<AmmoPickup>();
}
