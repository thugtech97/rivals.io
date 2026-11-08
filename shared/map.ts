import { ARENA_SIZE } from "./constants";

// The arena layout. Client and server both import this file, so collisions are identical.
// Everything here is generated once at load time from a fixed seed: same map for everyone.
//
//            x: 0 ─────────── 940 ─ road ─ 1060 ─────────── 2000
//   y: 0     ┌─────────────────┬─────────┬─────────────────┐
//            │  NW: forest      │  road   │  NE: town       │
//    940     ├──── road ───────┼─ cross ─┼──── road ───────┤
//   1060     │  SW: army camp   │  road   │  SE: park       │
//   2000     └─────────────────┴─────────┴─────────────────┘

export type RectStyle =
  | "building"
  | "car"
  | "barrier" // concrete jersey barrier
  | "sandbag"
  | "container"
  | "crate"
  | "dumpster"
  | "brick"
  | "hedge"
  | "stone"
  | "log";

export type CircleStyle = "tree" | "rock" | "barrel" | "fountain";

export interface RectObstacle {
  kind: "rect";
  style: RectStyle;
  x: number; // top-left
  y: number;
  w: number;
  h: number;
  color?: number;
}

export interface CircleObstacle {
  kind: "circle";
  style: CircleStyle;
  x: number; // center
  y: number;
  r: number;
}

export type Obstacle = RectObstacle | CircleObstacle;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------- Roads (visual only, no collision) ----------

export const ROAD_WIDTH = 120;
export const SIDEWALK_WIDTH = 16;
const MID = ARENA_SIZE / 2;
const ROAD_A = MID - ROAD_WIDTH / 2; // 940
const ROAD_B = MID + ROAD_WIDTH / 2; // 1060

export const ROADS: Rect[] = [
  { x: 0, y: ROAD_A, w: ARENA_SIZE, h: ROAD_WIDTH }, // east-west
  { x: ROAD_A, y: 0, w: ROAD_WIDTH, h: ARENA_SIZE }, // north-south
];

// ---------- Seeded random (same numbers on every machine) ----------

export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Hand-placed obstacles ----------

const rect = (style: RectStyle, x: number, y: number, w: number, h: number, color?: number): RectObstacle => ({
  kind: "rect",
  style,
  x,
  y,
  w,
  h,
  color,
});
const circle = (style: CircleStyle, x: number, y: number, r: number): CircleObstacle => ({
  kind: "circle",
  style,
  x,
  y,
  r,
});

const HAND_PLACED: Obstacle[] = [
  // Streets: parked cars and staggered concrete barriers around the crossroads
  rect("car", 600, 950, 86, 40, 0xc0392b),
  rect("car", 300, 1012, 86, 40, 0x2e6fb7),
  rect("car", 1400, 1012, 86, 40, 0xe8e8e8),
  rect("car", 1750, 950, 86, 40, 0xf1c40f),
  rect("car", 950, 350, 40, 86, 0x27ae60),
  rect("car", 1012, 1600, 40, 86, 0x7f8c8d),
  rect("car", 1012, 180, 40, 86, 0x8e44ad),
  rect("barrier", 850, 948, 18, 52),
  rect("barrier", 1132, 1000, 18, 52),
  rect("barrier", 948, 850, 52, 18),
  rect("barrier", 1000, 1132, 52, 18),
  rect("barrier", 200, 948, 18, 52),
  rect("barrier", 1800, 1000, 18, 52),

  // NW forest: rocks and a fallen log (trees are scattered below)
  circle("rock", 220, 300, 24),
  circle("rock", 640, 180, 20),
  circle("rock", 520, 700, 26),
  rect("log", 300, 560, 120, 22),

  // NE town: houses, dumpsters, a brick wall, crates
  rect("building", 1160, 110, 280, 200, 0xa5432f),
  rect("building", 1560, 90, 320, 180, 0x56606e),
  rect("building", 1180, 520, 220, 280, 0xb59a6d),
  rect("building", 1580, 500, 260, 220, 0x3f6b4f),
  rect("dumpster", 1470, 350, 50, 30),
  rect("dumpster", 1860, 760, 50, 30),
  rect("brick", 1440, 820, 200, 18),
  rect("crate", 1460, 560, 36, 36),
  rect("crate", 1498, 572, 36, 36),

  // SW army camp: sandbag bunkers, shipping containers, crates, barrels
  rect("sandbag", 200, 1250, 140, 22), // bunker 1 (opens south)
  rect("sandbag", 200, 1272, 22, 88),
  rect("sandbag", 318, 1272, 22, 88),
  rect("sandbag", 540, 1800, 140, 22), // bunker 2 (opens north)
  rect("sandbag", 540, 1712, 22, 88),
  rect("sandbag", 658, 1712, 22, 88),
  rect("sandbag", 240, 1880, 200, 22),
  rect("container", 520, 1200, 180, 64, 0xb03a2e),
  rect("container", 120, 1580, 64, 180, 0x2c5f8a),
  rect("container", 770, 1420, 64, 170, 0x3e7b3a),
  rect("crate", 400, 1500, 40, 40),
  rect("crate", 442, 1500, 40, 40),
  rect("crate", 421, 1458, 40, 40),
  circle("barrel", 690, 1330, 14),
  circle("barrel", 718, 1352, 14),
  circle("barrel", 300, 1700, 14),

  // SE park: fountain, hedges, ruined stone walls
  circle("fountain", 1500, 1500, 60),
  rect("hedge", 1300, 1300, 160, 22),
  rect("hedge", 1540, 1300, 160, 22),
  rect("hedge", 1300, 1680, 160, 22),
  rect("hedge", 1540, 1680, 160, 22),
  rect("hedge", 1300, 1322, 22, 110),
  rect("hedge", 1678, 1570, 22, 110),
  rect("stone", 1800, 1200, 22, 160),
  rect("stone", 1822, 1200, 110, 22),
  rect("stone", 1180, 1820, 140, 22),
];

// ---------- Geometry helpers ----------

/** Distance from point (x, y) to the obstacle's edge. 0 or less means the point is inside. */
export function distanceTo(o: Obstacle, x: number, y: number): number {
  if (o.kind === "circle") return Math.hypot(x - o.x, y - o.y) - o.r;
  const dx = Math.max(o.x - x, 0, x - (o.x + o.w));
  const dy = Math.max(o.y - y, 0, y - (o.y + o.h));
  if (dx === 0 && dy === 0) {
    // Inside: negative distance to the nearest edge.
    return -Math.min(x - o.x, o.x + o.w - x, y - o.y, o.y + o.h - y);
  }
  return Math.hypot(dx, dy);
}

function nearRoad(x: number, y: number, pad: number): boolean {
  return ROADS.some((r) => x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h + pad);
}

// ---------- Scattered trees ----------

function scatterTrees(existing: Obstacle[], area: Rect, count: number, rng: () => number): CircleObstacle[] {
  const trees: CircleObstacle[] = [];
  const GAP = 52; // leave room for a soldier (40px wide) to walk between things
  for (let tries = 0; trees.length < count && tries < count * 60; tries++) {
    const r = 22 + rng() * 10;
    const x = area.x + r + rng() * (area.w - r * 2);
    const y = area.y + r + rng() * (area.h - r * 2);
    if (nearRoad(x, y, SIDEWALK_WIDTH + r + 10)) continue;
    if ([...existing, ...trees].some((o) => distanceTo(o, x, y) < r + GAP)) continue;
    trees.push(circle("tree", x, y, r));
  }
  return trees;
}

function buildMap(): Obstacle[] {
  const rng = seededRandom(1337);
  const map = [...HAND_PLACED];
  map.push(...scatterTrees(map, { x: 40, y: 40, w: 860, h: 860 }, 30, rng)); // NW forest
  map.push(...scatterTrees(map, { x: 1100, y: 1100, w: 860, h: 860 }, 12, rng)); // SE park
  map.push(...scatterTrees(map, { x: 1100, y: 40, w: 860, h: 860 }, 5, rng)); // NE town
  map.push(...scatterTrees(map, { x: 40, y: 1100, w: 860, h: 860 }, 6, rng)); // SW camp
  return map;
}

export const OBSTACLES: Obstacle[] = buildMap();

// ---------- Collision queries ----------

/** True if a point is inside any obstacle (used for bullets). */
export function pointBlocked(x: number, y: number): boolean {
  for (const o of OBSTACLES) if (distanceTo(o, x, y) <= 0) return true;
  return false;
}

/** Push a circle (a soldier) out of any obstacle it overlaps. Lets you slide along walls. */
export function resolveCollisions(pos: { x: number; y: number }, radius: number): void {
  for (let pass = 0; pass < 2; pass++) {
    for (const o of OBSTACLES) {
      if (o.kind === "circle") {
        const dx = pos.x - o.x;
        const dy = pos.y - o.y;
        const min = o.r + radius;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 0.0001;
        pos.x = o.x + (dx / d) * min;
        pos.y = o.y + (dy / d) * min;
      } else {
        const cx = Math.max(o.x, Math.min(pos.x, o.x + o.w));
        const cy = Math.max(o.y, Math.min(pos.y, o.y + o.h));
        const dx = pos.x - cx;
        const dy = pos.y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 >= radius * radius) continue;
        if (d2 > 1e-6) {
          const d = Math.sqrt(d2);
          pos.x = cx + (dx / d) * radius;
          pos.y = cy + (dy / d) * radius;
        } else {
          // Center ended up inside the rectangle: push out through the nearest side.
          const left = pos.x - o.x;
          const right = o.x + o.w - pos.x;
          const top = pos.y - o.y;
          const bottom = o.y + o.h - pos.y;
          const m = Math.min(left, right, top, bottom);
          if (m === left) pos.x = o.x - radius;
          else if (m === right) pos.x = o.x + o.w + radius;
          else if (m === top) pos.y = o.y - radius;
          else pos.y = o.y + o.h + radius;
        }
      }
    }
  }
}

/** A random spot where a circle of `radius` doesn't touch any obstacle. */
export function findFreeSpot(radius: number, margin: number, random: () => number = Math.random): { x: number; y: number } {
  for (let i = 0; i < 500; i++) {
    const x = margin + random() * (ARENA_SIZE - margin * 2);
    const y = margin + random() * (ARENA_SIZE - margin * 2);
    if (OBSTACLES.every((o) => distanceTo(o, x, y) > radius + 4)) return { x, y };
  }
  return { x: MID, y: MID }; // the crossroads is always open
}
