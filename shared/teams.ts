import { ARENA_SIZE } from "./constants";

// Team mode (Blue vs Red, like a MOBA): each team has a base in an opposite corner with a
// core to defend. Destroy the enemy core to win. Dead players respawn at their base.

/** "solo": last soldier standing (battle royale). "teams": Blue vs Red, destroy the enemy base. */
export type GameMode = "solo" | "teams";
export type Team = "blue" | "red";
export const TEAMS: readonly Team[] = ["blue", "red"];

export const TEAM_NAME: Record<Team, string> = { blue: "Blue", red: "Red" };
/** Uniform color of each team's soldiers. */
export const TEAM_COLOR: Record<Team, number> = { blue: 0x3f86e8, red: 0xe04848 };
/** CSS version of TEAM_COLOR (HUD, minimap). */
export const TEAM_CSS: Record<Team, string> = { blue: "#4f95f0", red: "#ef5a5a" };

export function otherTeam(t: Team): Team {
  return t === "blue" ? "red" : "blue";
}

export function isTeam(v: unknown): v is Team {
  return v === "blue" || v === "red";
}

/** Base centers: Blue bottom-left, Red top-right (inside the corner city blocks). */
export const BASE_INSET = 250;
export const BASES: Record<Team, { x: number; y: number }> = {
  blue: { x: BASE_INSET, y: ARENA_SIZE - BASE_INSET },
  red: { x: ARENA_SIZE - BASE_INSET, y: BASE_INSET },
};

/** Everything solid this close to a base center is removed from the map (open ground). */
export const BASE_CLEAR_RADIUS = 210;
/** The core: a solid round tower in the middle of the base. */
export const CORE_RADIUS = 34;
export const CORE_MAX_HP = 3000;
/** Inside this radius of your own core you heal (the "fountain"). */
export const FOUNTAIN_RADIUS = 190;
export const FOUNTAIN_HEAL_PER_SEC = 30;
/**
 * The core's turret shoots the closest enemy within this range (with a clear line of fire).
 * It outranges rifles (~620px), so you can't just chip the core from safety; snipers can.
 * Its damage and fire rate are the "turret" gun in shared/weapons.ts.
 */
export const TURRET_RANGE = 650;
/** Dead players come back at their base after this long (during a team match). */
export const TEAM_RESPAWN_MS = 5000;

/** Extra room seats for people who only watch (they don't count as players). */
export const MAX_SPECTATORS = 8;
