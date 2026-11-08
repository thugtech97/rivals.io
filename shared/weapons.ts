// Every weapon's stats, shared by server (rules) and client (HUD, visuals, sounds).
// Tweak numbers here to balance the game.

export type GunId = "pistol" | "rifle" | "mg" | "sniper";
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
    kind: "gun", name: "Pistol", damage: 18, fireMs: 260, mag: 12, lootReserve: 24, maxReserve: 48, boxAmmo: 12,
    reloadMs: 1100, bulletSpeed: 900, bulletLifeMs: 560, spread: 0.03, moveMul: 1, muzzle: 30,
  },
  rifle: {
    kind: "gun", name: "Rifle", damage: 25, fireMs: 130, mag: 25, lootReserve: 50, maxReserve: 100, boxAmmo: 25,
    reloadMs: 1500, bulletSpeed: 950, bulletLifeMs: 650, spread: 0.035, moveMul: 0.95, muzzle: 37,
  },
  mg: {
    kind: "gun", name: "Machine gun", damage: 16, fireMs: 75, mag: 60, lootReserve: 60, maxReserve: 120, boxAmmo: 40,
    reloadMs: 3000, bulletSpeed: 900, bulletLifeMs: 600, spread: 0.09, moveMul: 0.82, muzzle: 40,
  },
  sniper: {
    kind: "gun", name: "Sniper", damage: 80, fireMs: 1100, mag: 5, lootReserve: 10, maxReserve: 20, boxAmmo: 5,
    reloadMs: 2300, bulletSpeed: 2200, bulletLifeMs: 650, spread: 0, moveMul: 0.9, muzzle: 48,
  },
  knife: { kind: "melee", name: "Knife", damage: 30, range: 26, arc: 1.4, swingMs: 350, moveMul: 1.05 },
  sword: { kind: "melee", name: "Sword", damage: 45, range: 48, arc: 2.2, swingMs: 650, moveMul: 1 },
  axe: { kind: "melee", name: "Axe", damage: 60, range: 38, arc: 1.6, swingMs: 900, moveMul: 0.95 },
  fists: { kind: "melee", name: "Fists", damage: 12, range: 18, arc: 1.4, swingMs: 400, moveMul: 1.05 },
};

export const SLOT_COUNT = 3;

/** Bulletproof vest: armor points, and how much of each hit (bullets & melee) it soaks up. */
export const VEST_ARMOR = 50;
export const VEST_ABSORB = 0.7;

/** Medkit: HP restored (up to the max). Only picked up when you're hurt. */
export const MEDKIT_HEAL = 40;

/** What everyone starts a match (and each warmup life) with. */
export const STARTING_WEAPON: GunId = "pistol";

/** Loot placed on the map at the start of each match. Nothing else appears later. */
export const LOOT_TABLE: { item: "weapon" | "vest" | "ammo" | "medkit"; weapon?: WeaponId; count: number }[] = [
  { item: "medkit", count: 8 },
  { item: "weapon", weapon: "rifle", count: 5 },
  { item: "weapon", weapon: "mg", count: 2 },
  { item: "weapon", weapon: "sniper", count: 2 },
  { item: "weapon", weapon: "pistol", count: 3 },
  { item: "weapon", weapon: "knife", count: 3 },
  { item: "weapon", weapon: "sword", count: 2 },
  { item: "weapon", weapon: "axe", count: 2 },
  { item: "vest", count: 5 },
  { item: "ammo", count: 14 },
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
