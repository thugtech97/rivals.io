// Events the server broadcasts. Bullets are not part of the synced state: the server
// announces each shot, both sides fly it in a straight line, and the server says when it ends.

import type { WeaponId } from "./weapons";

/** "shot": a bullet left a gun. */
export interface ShotEvent {
  id: number;
  owner: string; // sessionId of the shooter
  weapon: WeaponId;
  x: number; // muzzle position
  y: number;
  angle: number;
}

/** "bulletEnd": a bullet hit something or ran out of range. */
export interface BulletEndEvent {
  id: number;
  x: number;
  y: number;
  /** sessionId of the player it hit, or "" for a wall / out of range. */
  hit: string;
  /** True if the target's vest took (part of) the hit. */
  armored?: boolean;
}

/** "swing": a melee attack (knife, sword, axe, fists). */
export interface SwingEvent {
  owner: string;
  weapon: WeaponId;
  angle: number;
  /** sessionIds of everyone it hit. */
  hits: string[];
}

/** "kill": someone got eliminated. */
export interface KillEvent {
  killer: string; // sessionId ("" = the zone, "core:blue" / "core:red" = that team's base turret)
  victim: string; // sessionId
  weapon: WeaponId | "zone" | "car";
}

/** "ram": a car ran someone over (damage is already applied). */
export interface RamEvent {
  owner: string;
  victim: string;
  x: number;
  y: number;
}

/** "explosion": a rocket or grenade went off. Damage is already applied (synced state). */
export interface ExplosionEvent {
  x: number;
  y: number;
  radius: number;
  owner: string;
  weapon: WeaponId;
  /** sessionIds of everyone it hurt (the owner too, if they were in it). */
  hits: string[];
}

/** "coreDestroyed": a team's base core went down (team mode). The match ends right after. */
export interface CoreDestroyedEvent {
  team: string;
  x: number;
  y: number;
}
