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
  killer: string; // sessionId ("" = the zone)
  victim: string; // sessionId
  weapon: WeaponId | "zone";
}
