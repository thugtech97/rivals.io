// Every weapon's stats, shared by server (rules) and client (HUD, visuals, sounds).
// Tweak numbers here to balance the game.

export type GunId = "pistol" | "rifle" | "mg" | "sniper" | "bazooka" | "grenade";
export type MeleeId = "knife" | "sword" | "axe" | "fists";
export type WeaponId = GunId | MeleeId;

export interface GunStats {
  kind: "gun";
  name: string;
  damage: number;
  /** Time between shots (hold the mouse for automatic fire). */
  fireMs: number;
  /** Rounds per magazine. */
  mag: number;
  /** Spare rounds a gun lying on the ground comes with. */
  lootReserve: number;
  /** Most spare rounds you can carry for it. */
  maxReserve: number;
  /** Rounds an ammo box gives this gun. */
  boxAmmo: number;
  reloadMs: number;
  bulletSpeed: number; // px/s
  bulletLifeMs: number; // range ≈ speed × life
  /** Random aim wobble per shot, in radians (each way). */
  spread: number;
  /** Movement speed while holding it (1 = normal). */
  moveMul: number;
  /** How far in front of the soldier the barrel ends. */
  muzzle: number;
  /** Explodes (rocket / grenade) instead of hitting one target. */
  splash?: SplashStats;
  /**
   * Thrown (grenades): bulletSpeed is the throw speed, bulletLifeMs the fuse. It bounces off
   * walls, rolls to a stop and goes off. Each "round" is one grenade; no reload sounds.
   */
  thrown?: boolean;
}

/** Explosion: full `damage` at the center down to `minDamage` at the edge of `radius`. Walls block it. */
export interface SplashStats {
  radius: number;
  damage: number;
  minDamage: number;
}

export interface MeleeStats {
  kind: "melee";
  name: string;
  damage: number;
  /** Reach from the edge of your body. */
  range: number;
  /** Total swing width in radians, centered on where you aim. */
  arc: number;
  swingMs: number;
  moveMul: number;
}

export type WeaponStats = GunStats | MeleeStats;

export const WEAPONS: Record<WeaponId, WeaponStats> = {
  pistol: {
    kind: "gun", name: "Pistol", damage: 18, fireMs: 260, mag: 12, lootReserve: 24, maxReserve: 48, boxAmmo: 24,
    reloadMs: 1100, bulletSpeed: 900, bulletLifeMs: 560, spread: 0.03, moveMul: 1, muzzle: 30,
  },
  rifle: {
    kind: "gun", name: "Rifle", damage: 25, fireMs: 130, mag: 25, lootReserve: 50, maxReserve: 100, boxAmmo: 50,
    reloadMs: 1500, bulletSpeed: 950, bulletLifeMs: 650, spread: 0.035, moveMul: 0.95, muzzle: 37,
  },
  mg: {
    kind: "gun", name: "Machine gun", damage: 16, fireMs: 75, mag: 60, lootReserve: 60, maxReserve: 120, boxAmmo: 80,
    reloadMs: 3000, bulletSpeed: 900, bulletLifeMs: 600, spread: 0.09, moveMul: 0.82, muzzle: 40,
  },
  sniper: {
    kind: "gun", name: "Sniper", damage: 80, fireMs: 1100, mag: 5, lootReserve: 10, maxReserve: 20, boxAmmo: 10,
    reloadMs: 2300, bulletSpeed: 2200, bulletLifeMs: 650, spread: 0, moveMul: 0.9, muzzle: 48,
  },
  // Slow rocket that explodes on whatever it hits (or at the end of its range).
  bazooka: {
    kind: "gun", name: "Bazooka", damage: 95, fireMs: 900, mag: 1, lootReserve: 3, maxReserve: 5, boxAmmo: 1,
    reloadMs: 2200, bulletSpeed: 560, bulletLifeMs: 1400, spread: 0.01, moveMul: 0.85, muzzle: 46,
    splash: { radius: 120, damage: 95, minDamage: 25 },
  },
  // Thrown: bounces off walls, rolls to a stop, explodes when the fuse runs out.
  // Ground pickups are 2 grenades (1 + 1 spare); you can carry 4. Ammo boxes don't give grenades.
  grenade: {
    kind: "gun", name: "Grenade", damage: 85, fireMs: 650, mag: 1, lootReserve: 1, maxReserve: 3, boxAmmo: 0,
    reloadMs: 250, bulletSpeed: 760, bulletLifeMs: 1600, spread: 0.04, moveMul: 1, muzzle: 20,
    splash: { radius: 130, damage: 85, minDamage: 20 }, thrown: true,
  },
  knife: { kind: "melee", name: "Knife", damage: 30, range: 26, arc: 1.4, swingMs: 350, moveMul: 1.05 },
  sword: { kind: "melee", name: "Sword", damage: 45, range: 48, arc: 2.2, swingMs: 650, moveMul: 1 },
  axe: { kind: "melee", name: "Axe", damage: 60, range: 38, arc: 1.6, swingMs: 900, moveMul: 0.95 },
  fists: { kind: "melee", name: "Fists", damage: 12, range: 18, arc: 1.4, swingMs: 400, moveMul: 1.05 },
};

export const SLOT_COUNT = 5;

/** Your own rocket / grenade hurts you too, but only this much. */
export const SELF_SPLASH_MUL = 0.5;
/** A thrown grenade slows down by this much (px/s every second) as it rolls. */
export const GRENADE_FRICTION = 900;
/** Speed kept (and reversed) when a grenade bounces off a wall. */
export const GRENADE_BOUNCE = 0.45;

/** Bulletproof vest: armor points, and how much of each hit (bullets & melee) it soaks up. */
export const VEST_ARMOR = 50;
export const VEST_ABSORB = 0.7;

/**
 * Speed boots: walk this much faster. Their charge only drains while you move, and they're
 * gone once it's used up (BOOTS_DURATION_MS of running in total).
 */
export const BOOTS_SPEED_MUL = 1.35;
export const BOOTS_DURATION_MS = 20_000;

/** Medkit: HP restored (up to the max). Only picked up when you're hurt. */
export const MEDKIT_HEAL = 40;

/** What everyone starts a match (and each warmup life) with. */
export const STARTING_WEAPON: GunId = "pistol";

/**
 * Loot placed on the map at the start of each match. Nothing else appears later.
 * `perPlayer` adds that many more for every player in the match (more players, more ammo).
 */
export const LOOT_TABLE: {
  item: "weapon" | "vest" | "ammo" | "medkit" | "boots";
  weapon?: WeaponId;
  count: number;
  perPlayer?: number;
}[] = [
  { item: "medkit", count: 8 },
  { item: "weapon", weapon: "rifle", count: 5 },
  { item: "weapon", weapon: "mg", count: 2 },
  { item: "weapon", weapon: "sniper", count: 2 },
  { item: "weapon", weapon: "pistol", count: 3 },
  { item: "weapon", weapon: "knife", count: 3 },
  { item: "weapon", weapon: "sword", count: 2 },
  { item: "weapon", weapon: "axe", count: 2 },
  { item: "weapon", weapon: "bazooka", count: 2 },
  { item: "weapon", weapon: "grenade", count: 6 },
  { item: "vest", count: 5 },
  { item: "boots", count: 4 },
  { item: "ammo", count: 10, perPlayer: 3 }, // 2 players: 16 boxes, 4: 22, 8: 34, 16: 58
];

export function isGun(id: string): id is GunId {
  return WEAPONS[id as WeaponId]?.kind === "gun";
}

export function gunStats(id: string): GunStats | null {
  const w = WEAPONS[id as WeaponId];
  return w?.kind === "gun" ? w : null;
}

/** Stats for whatever is in hand ("" = empty slot = fists). */
export function heldStats(id: string): WeaponStats {
  return WEAPONS[(id || "fists") as WeaponId] ?? WEAPONS.fists;
}
