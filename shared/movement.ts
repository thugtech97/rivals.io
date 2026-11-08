import { ARENA_SIZE, MUZZLE_FORWARD, MUZZLE_SIDE, PLAYER_RADIUS, PLAYER_SPEED } from "./constants";
import type { GameMap } from "./map";

export interface InputState {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  /** Mouse button held. */
  fire: boolean;
  /** Aim direction in radians (0 = right, PI/2 = down). */
  angle: number;
}

export interface Position {
  x: number;
  y: number;
}

export const NO_INPUT: InputState = { left: false, right: false, up: false, down: false, fire: false, angle: 0 };

export function isMoving(input: InputState): boolean {
  return input.left !== input.right || input.up !== input.down;
}

/**
 * Moves `pos` according to `input` for `dtMs` milliseconds and keeps it inside the arena.
 * Runs on the server (authoritative) and on the client (prediction for your own player).
 */
/** `speedMul` scales walking speed (heavy weapons slow you down). */
export function applyInput(pos: Position, input: InputState, dtMs: number, map: GameMap, speedMul = 1): void {
  let dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  if (dx === 0 && dy === 0) return;

  // Normalize so diagonal movement is not faster.
  const len = Math.hypot(dx, dy);
  dx /= len;
  dy /= len;

  // Move in small steps so a long frame can't carry you through a thin wall.
  const total = (PLAYER_SPEED * speedMul * dtMs) / 1000;
  const steps = Math.max(1, Math.ceil(total / 6));
  const step = total / steps;
  for (let i = 0; i < steps; i++) {
    pos.x = clamp(pos.x + dx * step, PLAYER_RADIUS, ARENA_SIZE - PLAYER_RADIUS);
    pos.y = clamp(pos.y + dy * step, PLAYER_RADIUS, ARENA_SIZE - PLAYER_RADIUS);
    map.resolveCollisions(pos, PLAYER_RADIUS);
  }
  pos.x = clamp(pos.x, PLAYER_RADIUS, ARENA_SIZE - PLAYER_RADIUS);
  pos.y = clamp(pos.y, PLAYER_RADIUS, ARENA_SIZE - PLAYER_RADIUS);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** World position of the gun's muzzle for a soldier at `pos` aiming at `angle`. */
export function muzzlePosition(pos: Position, angle: number, forward = MUZZLE_FORWARD): Position {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: pos.x + cos * forward - sin * MUZZLE_SIDE,
    y: pos.y + sin * forward + cos * MUZZLE_SIDE,
  };
}

/** Smallest signed difference between two angles, in radians (-PI..PI). */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
