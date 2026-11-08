import { ARENA_SIZE } from "./constants";

// The arena layout, generated from a seed. The server picks a new seed every match and
// syncs it; every client runs generateMap(seed) and gets exactly the same map, so
// collisions match on both sides.
//
// The road grid is fixed: a 3×3 grid of 940px blocks separated by 120px roads (3060×3060).
// What changes every match:
//   • which theme (forest, town, farm, …) goes in which block
//   • each block's layout is rotated / mirrored at random
//   • trees are scattered fresh
//   • parked cars and crossroads barriers move around
//
//          x: 0 ──── 940 ═ 1060 ──── 2000 ═ 2120 ──── 3060
//   y: 0      ┌────────╥────────────╥────────────┐
//             │ block   ║   block     ║   block     │
//    940/1060 ╞═════════╬═════════════╬═════════════╡   ═ ║ roads
//             │ block   ║   block     ║   block     │
//   2000/2120 ╞═════════╬═════════════╬═════════════╡
//             │ block   ║   block     ║   block     │
//   3060      └────────╨────────────╨────────────┘

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
  | "log"
  | "fence"
  | "hay"
  | "pipe"
  | "concrete"
  | "stall";

export type CircleStyle = "tree" | "rock" | "barrel" | "fountain" | "silo" | "statue";

/** Decorative ground areas (no collision). */
export type GroundKind = "field" | "concrete" | "gravel" | "paving";
export interface GroundArea {
  kind: GroundKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

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

// ---------- Roads (fixed, visual only, no collision) ----------

export const BLOCK_SIZE = 940;
export const ROAD_WIDTH = 120;
export const SIDEWALK_WIDTH = 16;
/** Top-left corner of each block column/row: 0, 1060, 2120. */
export const BLOCK_ORIGINS = [0, 1, 2].map((i) => i * (BLOCK_SIZE + ROAD_WIDTH));
/** Center line of each road: 1000, 2060. */
export const ROAD_CENTERS = [1, 2].map((i) => i * BLOCK_SIZE + (i - 0.5) * ROAD_WIDTH);

export const ROADS: Rect[] = ROAD_CENTERS.flatMap((c) => [
  { x: 0, y: c - ROAD_WIDTH / 2, w: ARENA_SIZE, h: ROAD_WIDTH }, // east-west
  { x: c - ROAD_WIDTH / 2, y: 0, w: ROAD_WIDTH, h: ARENA_SIZE }, // north-south
]);

/** Where roads cross. */
export const INTERSECTIONS = ROAD_CENTERS.flatMap((x) => ROAD_CENTERS.map((y) => ({ x, y })));

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

/** A fresh random seed for a new map. */
export function newMapSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

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

// ---------- Block themes ----------
// Each theme is laid out in local block coordinates: (0,0) is the block's top-left, 940 wide.

interface Theme {
  name: string;
  items: Obstacle[];
  grounds?: GroundArea[];
  /** How many trees to scatter in this block. */
  trees: number;
}

const THEMES: Theme[] = [
  {
    name: "forest",
    trees: 15,
    items: [circle("rock", 220, 300, 24), circle("rock", 520, 700, 26), rect("log", 300, 560, 120, 22)],
  },
  {
    name: "town",
    trees: 2,
    items: [
      rect("building", 100, 110, 280, 200, 0xa5432f),
      rect("building", 500, 90, 320, 180, 0x56606e),
      rect("building", 120, 520, 220, 280, 0xb59a6d),
      rect("building", 520, 500, 260, 220, 0x3f6b4f),
      rect("dumpster", 410, 350, 50, 30),
      rect("brick", 380, 820, 200, 18),
      rect("crate", 400, 560, 36, 36),
    ],
  },
  {
    name: "army camp",
    trees: 3,
    items: [
      rect("sandbag", 200, 190, 140, 22), // bunker 1
      rect("sandbag", 200, 212, 22, 88),
      rect("sandbag", 318, 212, 22, 88),
      rect("sandbag", 540, 740, 140, 22), // bunker 2
      rect("sandbag", 540, 652, 22, 88),
      rect("sandbag", 658, 652, 22, 88),
      rect("container", 520, 140, 180, 64, 0xb03a2e),
      rect("container", 120, 520, 64, 180, 0x2c5f8a),
      rect("crate", 400, 440, 40, 40),
      circle("barrel", 690, 270, 14),
    ],
  },
  {
    name: "park",
    trees: 6,
    items: [
      circle("fountain", 440, 440, 60),
      rect("hedge", 240, 240, 160, 22),
      rect("hedge", 480, 240, 160, 22),
      rect("hedge", 240, 620, 160, 22),
      rect("hedge", 480, 620, 160, 22),
      rect("stone", 740, 140, 22, 160),
    ],
  },
  {
    name: "farm",
    trees: 2,
    items: [
      rect("building", 120, 80, 260, 200, 0x8b2e22), // barn
      rect("building", 640, 70, 180, 150, 0x6d4c33), // farmhouse
      circle("silo", 470, 140, 45),
      rect("fence", 80, 420, 300, 12),
      rect("fence", 80, 432, 12, 240),
      rect("fence", 520, 420, 330, 12),
      rect("fence", 838, 432, 12, 240),
      rect("hay", 200, 520, 46, 30),
      rect("hay", 520, 700, 46, 30),
      rect("hay", 700, 800, 46, 30),
    ],
    grounds: [{ kind: "field", x: 92, y: 432, w: 746, h: 440 }],
  },
  {
    name: "construction",
    trees: 0,
    items: [
      rect("container", 80, 80, 160, 60, 0xd9a321), // site offices
      rect("container", 80, 140, 160, 60, 0xd9a321),
      rect("concrete", 400, 200, 50, 50),
      rect("concrete", 740, 180, 50, 50),
      rect("pipe", 480, 400, 240, 34),
      rect("pipe", 150, 420, 34, 220),
      rect("concrete", 520, 620, 300, 22), // unfinished building
      rect("concrete", 520, 642, 22, 200),
      rect("concrete", 798, 642, 22, 110),
      rect("concrete", 620, 840, 200, 22),
    ],
    grounds: [{ kind: "gravel", x: 40, y: 40, w: 860, h: 860 }],
  },
  {
    name: "industrial",
    trees: 0,
    items: [
      rect("building", 80, 80, 360, 240, 0x6b7280), // warehouses
      rect("building", 530, 60, 330, 200, 0x4b5563),
      rect("container", 100, 420, 180, 64, 0xb03a2e),
      rect("container", 360, 420, 64, 180, 0x3e7b3a),
      rect("container", 560, 400, 180, 64, 0xd9822b),
      rect("dumpster", 800, 330, 50, 30),
      rect("crate", 700, 720, 40, 40),
    ],
    grounds: [{ kind: "concrete", x: 40, y: 40, w: 860, h: 860 }],
  },
  {
    name: "market",
    trees: 1,
    items: [
      circle("statue", 470, 470, 36),
      rect("stall", 150, 150, 110, 60, 0xc0392b),
      rect("stall", 560, 150, 110, 60, 0xf1c40f),
      rect("stall", 150, 720, 110, 60, 0x27ae60),
      rect("stall", 620, 720, 110, 60, 0x2e6fb7),
      rect("building", 720, 380, 120, 100, 0x8a5a44), // kiosk
      rect("hedge", 200, 420, 100, 22),
    ],
    grounds: [{ kind: "paving", x: 60, y: 60, w: 820, h: 820 }],
  },
  {
    name: "ruins",
    trees: 8,
    items: [
      rect("stone", 100, 100, 200, 22), // broken house 1
      rect("stone", 100, 122, 22, 140),
      rect("stone", 278, 122, 22, 60),
      rect("stone", 500, 150, 22, 180), // broken house 2
      rect("stone", 522, 150, 180, 22),
      rect("stone", 680, 172, 22, 80),
      rect("stone", 360, 480, 160, 22), // tower base
      rect("stone", 360, 502, 22, 100),
      circle("rock", 760, 700, 30),
    ],
  },
];

/**
 * One of 8 orientations of a square block: rotate 0/90/180/270°, optionally mirrored.
 * Maps a local point (0..BLOCK_SIZE) to its new local position.
 */
function orient(px: number, py: number, rot: number, mirror: boolean): [number, number] {
  const S = BLOCK_SIZE;
  let x = mirror ? S - px : px;
  let y = py;
  for (let i = 0; i < rot; i++) [x, y] = [S - y, x];
  return [x, y];
}

function orientRect<T extends Rect>(r: T, rot: number, mirror: boolean, ox: number, oy: number): T {
  const [ax, ay] = orient(r.x, r.y, rot, mirror);
  const [bx, by] = orient(r.x + r.w, r.y + r.h, rot, mirror);
  return { ...r, x: Math.min(ax, bx) + ox, y: Math.min(ay, by) + oy, w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

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

function inside(x: number, y: number, a: Rect): boolean {
  return x >= a.x && y >= a.y && x <= a.x + a.w && y <= a.y + a.h;
}

// ---------- The map ----------

export class GameMap {
  /** Which theme ended up in each block, row by row (for debugging / display). */
  readonly blockThemes: string[] = [];
  readonly obstacles: Obstacle[] = [];
  readonly grounds: GroundArea[] = [];

  constructor(readonly seed: number) {
    const rng = seededRandom(seed);

    // 1. Shuffle the themes into the 9 blocks.
    const themes = [...THEMES];
    for (let i = themes.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [themes[i], themes[j]] = [themes[j], themes[i]];
    }

    // 2. Place each block's layout in a random orientation.
    const blocks: { theme: Theme; area: Rect }[] = [];
    themes.forEach((theme, i) => {
      const ox = BLOCK_ORIGINS[i % 3];
      const oy = BLOCK_ORIGINS[Math.floor(i / 3)];
      const rot = Math.floor(rng() * 4);
      const mirror = rng() < 0.5;
      this.blockThemes.push(theme.name);
      for (const o of theme.items) {
        if (o.kind === "rect") {
          this.obstacles.push(orientRect(o, rot, mirror, ox, oy));
        } else {
          const [x, y] = orient(o.x, o.y, rot, mirror);
          this.obstacles.push({ ...o, x: x + ox, y: y + oy });
        }
      }
      for (const g of theme.grounds ?? []) this.grounds.push(orientRect(g, rot, mirror, ox, oy));
      blocks.push({ theme, area: { x: ox, y: oy, w: BLOCK_SIZE, h: BLOCK_SIZE } });
    });

    // 3. Streets: barriers at each crossroads (2 of 4 lanes) and parked cars.
    this.placeStreetCover(rng);

    // 4. Trees, scattered fresh inside each block (never in crop fields).
    for (const { theme, area } of blocks) {
      const fields = this.grounds.filter((g) => g.kind === "field" && inside(g.x + 1, g.y + 1, area));
      this.scatterTrees({ x: area.x + 40, y: area.y + 40, w: BLOCK_SIZE - 80, h: BLOCK_SIZE - 80 }, theme.trees, fields, rng);
    }
  }

  private placeStreetCover(rng: () => number) {
    for (const p of INTERSECTIONS) {
      const options = [
        rect("barrier", p.x - 150, p.y - 52, 18, 52), // west, north lane
        rect("barrier", p.x + 132, p.y, 18, 52), // east, south lane
        rect("barrier", p.x - 52, p.y - 150, 52, 18), // north, west lane
        rect("barrier", p.x, p.y + 132, 52, 18), // south, east lane
      ];
      for (let k = 0; k < 2; k++) this.obstacles.push(options.splice(Math.floor(rng() * options.length), 1)[0]);
    }

    const colors = [0xc0392b, 0xe8e8e8, 0x2e6fb7, 0x27ae60, 0x7f8c8d, 0xe67e22, 0xf1c40f, 0x8e44ad, 0x16a085];
    const cars: RectObstacle[] = [];
    for (let tries = 0; cars.length < 8 && tries < 400; tries++) {
      const c = ROAD_CENTERS[Math.floor(rng() * 2)];
      const horizontal = rng() < 0.5;
      const lane = rng() < 0.5 ? c - 50 : c + 12; // which side of the yellow line
      const along = 40 + rng() * (ARENA_SIZE - 166);
      // Keep crossroads clear, and don't park on top of another car.
      if (ROAD_CENTERS.some((rc) => Math.abs(along + 43 - rc) < 230)) continue;
      const car = horizontal
        ? rect("car", along, lane, 86, 40, colors[Math.floor(rng() * colors.length)])
        : rect("car", lane, along, 40, 86, colors[Math.floor(rng() * colors.length)]);
      const clash = cars.some(
        (o) => o.x < car.x + car.w + 60 && car.x < o.x + o.w + 60 && o.y < car.y + car.h + 60 && car.y < o.y + o.h + 60,
      );
      if (!clash) cars.push(car);
    }
    this.obstacles.push(...cars);
  }

  private scatterTrees(area: Rect, count: number, avoid: Rect[], rng: () => number) {
    const GAP = 52; // leave room for a soldier (40px wide) to walk between things
    let placed = 0;
    for (let tries = 0; placed < count && tries < count * 60; tries++) {
      const r = 22 + rng() * 10;
      const x = area.x + r + rng() * (area.w - r * 2);
      const y = area.y + r + rng() * (area.h - r * 2);
      if (nearRoad(x, y, SIDEWALK_WIDTH + r + 10)) continue;
      if (avoid.some((a) => inside(x, y, { x: a.x - r, y: a.y - r, w: a.w + r * 2, h: a.h + r * 2 }))) continue;
      if (this.obstacles.some((o) => distanceTo(o, x, y) < r + GAP)) continue;
      this.obstacles.push(circle("tree", x, y, r));
      placed++;
    }
  }

  // ---------- Collision queries ----------

  /** True if a point is inside any obstacle (used for bullets). */
  pointBlocked(x: number, y: number): boolean {
    for (const o of this.obstacles) if (distanceTo(o, x, y) <= 0) return true;
    return false;
  }

  /** Push a circle (a soldier) out of any obstacle it overlaps. Lets you slide along walls. */
  resolveCollisions(pos: { x: number; y: number }, radius: number): void {
    for (let pass = 0; pass < 2; pass++) {
      for (const o of this.obstacles) {
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

  /**
   * A random spot where a circle of `radius` doesn't touch any obstacle.
   * Pass `area` to pick inside that square only (e.g. inside the safe zone).
   */
  findFreeSpot(
    radius: number,
    margin: number,
    random: () => number = Math.random,
    area: Rect = { x: 0, y: 0, w: ARENA_SIZE, h: ARENA_SIZE },
  ): { x: number; y: number } {
    for (let i = 0; i < 500; i++) {
      const x = area.x + margin + random() * Math.max(0, area.w - margin * 2);
      const y = area.y + margin + random() * Math.max(0, area.h - margin * 2);
      if (x < radius || y < radius || x > ARENA_SIZE - radius || y > ARENA_SIZE - radius) continue;
      if (this.obstacles.every((o) => distanceTo(o, x, y) > radius + 4)) return { x, y };
    }
    // Tiny or crowded area: fall back to anywhere on the map that's free.
    if (area.w < ARENA_SIZE) return this.findFreeSpot(radius, margin, random);
    return { ...INTERSECTIONS[0] }; // crossroads centers are always open
  }
}
