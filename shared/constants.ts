// Values shared by client and server, so both simulate movement the same way.

/** The arena is a square: ARENA_SIZE x ARENA_SIZE world pixels. */
export const ARENA_SIZE = 3060; // 3×3 blocks of 940px with two 120px roads each way (see shared/map.ts)

export const PLAYER_RADIUS = 20;

/** Movement speed in pixels per second. */
export const PLAYER_SPEED = 260;

/** Server simulation step (ms). 1000/60 = 60 ticks per second. */
export const TICK_MS = 1000 / 60;

export const MIN_PLAYERS_PER_ROOM = 2;
export const MAX_PLAYERS_PER_ROOM = 16;
export const DEFAULT_PLAYERS_PER_ROOM = 8;

// ---------- Combat ----------

export const PLAYER_MAX_HP = 100;
export const RESPAWN_MS = 3000; // warmup only

// Weapon stats (damage, fire rate, magazines, ranges…), the vest and the loot list
// live in shared/weapons.ts.

/** Where a gun's muzzle is, relative to the soldier's center when facing right (angle 0). */
export const MUZZLE_FORWARD = 36; // default; each gun sets its own length
export const MUZZLE_SIDE = 6;

/** Items on the ground (weapons, vests, ammo boxes): pickup size. */
export const PICKUP_RADIUS = 14;

// ---------- Match (last player alive wins) ----------

/** A match starts once this many players are in the room. */
export const MATCH_MIN_PLAYERS = 2;
/** "Match starts in 5…" */
export const MATCH_COUNTDOWN_MS = 5000;
/** How long the winner banner shows before the room goes back to warmup. */
export const MATCH_END_MS = 8000;

// ---------- Shrinking safe zone ----------

/** The zone starts shrinking this long after the room starts. */
export const ZONE_START_MS = 3 * 60_000; // 3 minutes
/** After appearing (and after each shrink) the zone holds still this long... */
export const ZONE_HOLD_MS = 20_000;
/** ...then shrinks slowly over this long. */
export const ZONE_SHRINK_MS = 10_000;
/** First zone: a square this big (smaller than the whole map), placed at random. */
export const ZONE_START_SIZE = 2200;
/** Each shrink keeps this fraction of the side length. */
export const ZONE_SHRINK_FACTOR = 0.7;
/** The zone stops shrinking at this size. */
export const ZONE_MIN_SIZE = 220;
/** Damage per second while outside the zone. */
export const ZONE_DAMAGE_PER_SEC = 10;

export const NAME_MAX_LENGTH = 16;
export const ROOM_NAME_MAX_LENGTH = 24;

/** Room type names registered on the server. */
export const LOBBY_ROOM = "lobby";
export const ARENA_ROOM = "arena";

export const DEFAULT_SERVER_PORT = 2567;
