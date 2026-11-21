// Rideable vehicles. Walk up to one and press F (touch: the 🚗 button) to ride it, F again
// to get off. Riding gives NO protection: bullets, blasts and blades hit the rider exactly
// like on foot (and the rider can still shoot). Vehicles never get destroyed.

export type VehicleKind = "bike" | "car";

export interface VehicleStats {
  name: string;
  /** Speed compared to walking (PLAYER_SPEED). Heavy weapons and speed boots don't change it. */
  speedMul: number;
  /** Collision circle with walls while riding (and how close you must be to get on). */
  radius: number;
  /** Driving into an enemy hurts them this much (0 = can't ram). */
  ramDamage: number;
  /** Drawn size (length along the heading, width across it). */
  length: number;
  width: number;
}

export const VEHICLES: Record<VehicleKind, VehicleStats> = {
  // Sized so they clearly stick out from under the rider (a soldier is 40px across).
  bike: { name: "Motorbike", speedMul: 2, radius: 24, ramDamage: 0, length: 62, width: 24 },
  car: { name: "Car", speedMul: 1.65, radius: 34, ramDamage: 30, length: 88, width: 48 },
};

/** How close (from the vehicle's edge) you must stand to get on. */
export const VEHICLE_REACH = 26;
/** The same car can hurt the same player at most this often. */
export const RAM_COOLDOWN_MS = 800;
/** A rammed player is shoved this far away from the car. */
export const RAM_PUSH_PX = 40;
/** How fast a vehicle turns to face where it's going (radians per second). */
export const VEHICLE_TURN_PER_SEC = 9;

/** Parked on the roads at the start of every match. Team mode also puts one of each at every base. */
export const ROAD_VEHICLES: Record<"solo" | "teams", Record<VehicleKind, number>> = {
  solo: { bike: 4, car: 3 },
  teams: { bike: 2, car: 2 },
};

export function isVehicleKind(v: unknown): v is VehicleKind {
  return v === "bike" || v === "car";
}
