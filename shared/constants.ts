// Values shared by client and server, so both simulate movement the same way.

/** The arena is a square: ARENA_SIZE x ARENA_SIZE world pixels. */
export const ARENA_SIZE = 2000;

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
export const RESPAWN_MS = 3000;

/** Bullets travel in a straight line until they hit a player, a wall, or run out of range. */
export const BULLET_SPEED = 950; // px per second
export const BULLET_LIFETIME_MS = 650; // range ≈ speed × lifetime ≈ 620px
export const BULLET_DAMAGE = 25; // 4 hits to kill
export const FIRE_INTERVAL_MS = 130; // automatic fire, ~7.7 shots per second

/** Where the gun's muzzle is, relative to the soldier's center when facing right (angle 0). */
export const MUZZLE_FORWARD = 36;
export const MUZZLE_SIDE = 6;

// ---------- Ammo ----------

export const MAG_SIZE = 15;
export const START_RESERVE = 45;
export const MAX_RESERVE = 90;
export const RELOAD_MS = 1500;

/** Ammo crates lying around the arena. */
export const MAX_PICKUPS = 8; // 4× the floor area of the old 1000px arena, so more crates
export const PICKUP_AMMO = 30;
export const PICKUP_RADIUS = 14;
export const PICKUP_RESPAWN_MS = 6000;

export const NAME_MAX_LENGTH = 16;
export const ROOM_NAME_MAX_LENGTH = 24;

/** Room type names registered on the server. */
export const LOBBY_ROOM = "lobby";
export const ARENA_ROOM = "arena";

export const DEFAULT_SERVER_PORT = 2567;
