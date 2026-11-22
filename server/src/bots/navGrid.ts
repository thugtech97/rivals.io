import { ARENA_SIZE, PLAYER_RADIUS } from "../../../shared/constants";
import { distanceTo, TREE_TRUNK_RADIUS, type GameMap, type Obstacle } from "../../../shared/map";

// What bots know about the map, precomputed once per match (the map changes every match):
//   • a walking grid (20px cells): how far each cell's center is from the nearest wall, for
//     A* pathfinding and for checking whether a straight walk is clear;
//   • a "solid" grid (10px cells): where bullets stop (walls and tree trunks), for cheap
//     line-of-sight checks. (The room's exact checks loop over every obstacle: far too slow
//     to run for every bot against every player several times a second.)

/** Walking grid cell size (px). */
const CELL = 20;
/** Solid grid cell size (px). */
const SOLID_CELL = 10;
/** Clearance is only tracked up to this far (anything more is "open ground"). */
const CLEARANCE_CAP = 64;
/** A cell is walkable when its center is at least this far from any wall. */
const WALK_CLEARANCE = PLAYER_RADIUS + 2;
/**
 * Straight-line shortcuts need this much clearance: a point on the line can be up to
 * ~14px from its cell's center, so this keeps a soldier's body off the walls.
 */
const WIDE_CLEARANCE = PLAYER_RADIUS + 16;

export interface Point {
  x: number;
  y: number;
}

export class NavGrid {
  readonly cols = Math.ceil(ARENA_SIZE / CELL);
  readonly rows = this.cols;
  /** Distance from each walking cell's center to the nearest wall (capped). */
  private clearance: Float32Array;
  private solidCols = Math.ceil(ARENA_SIZE / SOLID_CELL);
  private solid: Uint8Array;

  // A* scratch space, reused between searches (a "generation" stamp avoids clearing it).
  private g: Float32Array;
  private came: Int32Array;
  private seen: Uint32Array;
  private closed: Uint32Array;
  private gen = 0;
  private heapF: number[] = [];
  private heapI: number[] = [];

  constructor(map: GameMap) {
    const n = this.cols * this.rows;
    this.clearance = new Float32Array(n);
    this.g = new Float32Array(n);
    this.came = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.solid = new Uint8Array(this.solidCols * this.solidCols);

    // Start from the distance to the arena edge (soldiers can't leave it).
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const x = (c + 0.5) * CELL;
        const y = (r + 0.5) * CELL;
        this.clearance[r * this.cols + c] = Math.min(CLEARANCE_CAP, x, y, ARENA_SIZE - x, ARENA_SIZE - y) + PLAYER_RADIUS;
      }
    }
    for (const o of map.obstacles) {
      const isTree = o.kind === "circle" && o.style === "tree";
      if (!isTree) this.addWall(o); // trees can be walked into
      this.addSolid(o, isTree);
    }
  }

  private addWall(o: Obstacle) {
    const b = bounds(o, CLEARANCE_CAP);
    const c0 = Math.max(0, Math.floor(b.x0 / CELL));
    const c1 = Math.min(this.cols - 1, Math.floor(b.x1 / CELL));
    const r0 = Math.max(0, Math.floor(b.y0 / CELL));
    const r1 = Math.min(this.rows - 1, Math.floor(b.y1 / CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * this.cols + c;
        const d = distanceTo(o, (c + 0.5) * CELL, (r + 0.5) * CELL);
        if (d < this.clearance[i]) this.clearance[i] = Math.max(-1, d);
      }
    }
  }

  private addSolid(o: Obstacle, trunkOnly: boolean) {
    const b = bounds(o, 0);
    const c0 = Math.max(0, Math.floor(b.x0 / SOLID_CELL));
    const c1 = Math.min(this.solidCols - 1, Math.floor(b.x1 / SOLID_CELL));
    const r0 = Math.max(0, Math.floor(b.y0 / SOLID_CELL));
    const r1 = Math.min(this.solidCols - 1, Math.floor(b.y1 / SOLID_CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const x = (c + 0.5) * SOLID_CELL;
        const y = (r + 0.5) * SOLID_CELL;
        const inside = trunkOnly && o.kind === "circle" ? Math.hypot(x - o.x, y - o.y) <= TREE_TRUNK_RADIUS : distanceTo(o, x, y) <= 0;
        if (inside) this.solid[r * this.solidCols + c] = 1;
      }
    }
  }

  // ---------- Queries ----------

  private cellAt(x: number, y: number): number {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(x / CELL)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor(y / CELL)));
    return r * this.cols + c;
  }

  private center(i: number): Point {
    return { x: ((i % this.cols) + 0.5) * CELL, y: (Math.floor(i / this.cols) + 0.5) * CELL };
  }

  walkable(x: number, y: number): boolean {
    return this.clearance[this.cellAt(x, y)] > WALK_CLEARANCE;
  }

  /** Nothing that stops bullets between two points (approximate). `skipEnd`: ignore the last px (e.g. the core you aim at). */
  sightClear(x0: number, y0: number, x1: number, y1: number, skipEnd = 0): boolean {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const usable = len - skipEnd;
    if (usable <= 0) return true;
    const steps = Math.ceil(usable / 5);
    const sc = this.solidCols;
    for (let i = 1; i <= steps; i++) {
      const t = Math.min(usable, i * 5) / len;
      const c = Math.floor((x0 + (x1 - x0) * t) / SOLID_CELL);
      const r = Math.floor((y0 + (y1 - y0) * t) / SOLID_CELL);
      if (c < 0 || r < 0 || c >= sc || r >= sc) return false;
      if (this.solid[r * sc + c]) return false;
    }
    return true;
  }

  /** A soldier can walk the straight line between two points without brushing a wall. */
  walkClear(x0: number, y0: number, x1: number, y1: number): boolean {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.ceil(len / 8);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (this.clearance[this.cellAt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)] <= WIDE_CLEARANCE) return false;
    }
    return true;
  }

  /** A random open spot inside `area` (falls back to anywhere open). */
  randomOpenSpot(area: { x: number; y: number; w: number; h: number }, rand = Math.random): Point {
    for (let i = 0; i < 80; i++) {
      const x = area.x + 30 + rand() * Math.max(0, area.w - 60);
      const y = area.y + 30 + rand() * Math.max(0, area.h - 60);
      if (this.clearance[this.cellAt(x, y)] > WIDE_CLEARANCE) return { x, y };
    }
    return { x: area.x + area.w / 2, y: area.y + area.h / 2 };
  }

  /** The closest walkable cell to (x, y), searching outward a few rings. */
  private nearestWalkable(x: number, y: number): number {
    const start = this.cellAt(x, y);
    if (this.clearance[start] > WALK_CLEARANCE) return start;
    const sc = start % this.cols;
    const sr = Math.floor(start / this.cols);
    for (let ring = 1; ring <= 8; ring++) {
      let best = -1;
      let bestD = Infinity;
      for (let r = sr - ring; r <= sr + ring; r++) {
        for (let c = sc - ring; c <= sc + ring; c++) {
          if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) continue;
          if (Math.max(Math.abs(r - sr), Math.abs(c - sc)) !== ring) continue;
          const i = r * this.cols + c;
          if (this.clearance[i] <= WALK_CLEARANCE) continue;
          const p = this.center(i);
          const d = Math.hypot(p.x - x, p.y - y);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      if (best >= 0) return best;
    }
    return start;
  }

  /**
   * A* over the walking grid (8 directions, no cutting corners), then shortened to the
   * fewest straight legs. Returns waypoints (the last one is the goal itself, or the
   * closest reachable point to it), or null if there's no way there.
   */
  findPath(sx: number, sy: number, gx: number, gy: number, maxExpand = 14000): Point[] | null {
    const cols = this.cols;
    const start = this.nearestWalkable(sx, sy);
    const goal = this.nearestWalkable(gx, gy);
    if (start === goal) return [{ x: gx, y: gy }];

    const gen = ++this.gen;
    const gc = goal % cols;
    const gr = Math.floor(goal / cols);
    const h = (i: number) => {
      const dx = Math.abs((i % cols) - gc);
      const dy = Math.abs(Math.floor(i / cols) - gr);
      return (dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy)) * CELL;
    };
    const heapF = this.heapF;
    const heapI = this.heapI;
    heapF.length = 0;
    heapI.length = 0;
    this.g[start] = 0;
    this.seen[start] = gen;
    this.came[start] = -1;
    push(heapF, heapI, h(start), start);

    // Best fallback if the goal can't be reached: the explored cell closest to it.
    let closest = start;
    let closestH = h(start);
    let found = false;
    let expanded = 0;

    while (heapI.length && expanded < maxExpand) {
      const cur = pop(heapF, heapI);
      if (this.closed[cur] === gen) continue;
      this.closed[cur] = gen;
      expanded++;
      if (cur === goal) {
        found = true;
        break;
      }
      const hc = h(cur);
      if (hc < closestH) {
        closestH = hc;
        closest = cur;
      }
      const c = cur % cols;
      const r = Math.floor(cur / cols);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nc = c + dc;
          const nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= this.rows) continue;
          const ni = nr * cols + nc;
          if (this.clearance[ni] <= WALK_CLEARANCE || this.closed[ni] === gen) continue;
          // Diagonal: both sides must be open too (don't squeeze past a corner).
          if (dr && dc && (this.clearance[r * cols + nc] <= WALK_CLEARANCE || this.clearance[nr * cols + c] <= WALK_CLEARANCE)) continue;
          const ng = this.g[cur] + (dr && dc ? Math.SQRT2 * CELL : CELL);
          if (this.seen[ni] === gen && ng >= this.g[ni]) continue;
          this.seen[ni] = gen;
          this.g[ni] = ng;
          this.came[ni] = cur;
          push(heapF, heapI, ng + h(ni), ni);
        }
      }
    }

    const end = found ? goal : closest;
    if (end === start) return null;
    const cells: Point[] = [];
    for (let i = end; i !== -1; i = this.came[i]) cells.push(this.center(i));
    cells.reverse();
    if (found) cells[cells.length - 1] = { x: gx, y: gy };

    // Shorten: from each point, jump to the furthest one that's a clear straight walk.
    const path: Point[] = [];
    let from: Point = { x: sx, y: sy };
    let i = 0;
    while (i < cells.length) {
      let j = Math.min(cells.length - 1, i + 40);
      while (j > i && !this.walkClear(from.x, from.y, cells[j].x, cells[j].y)) j--;
      path.push(cells[j]);
      from = cells[j];
      i = j + 1;
    }
    return path;
  }
}

function bounds(o: Obstacle, pad: number) {
  if (o.kind === "circle") return { x0: o.x - o.r - pad, y0: o.y - o.r - pad, x1: o.x + o.r + pad, y1: o.y + o.r + pad };
  return { x0: o.x - pad, y0: o.y - pad, x1: o.x + o.w + pad, y1: o.y + o.h + pad };
}

// Tiny binary min-heap over two parallel arrays (priority, cell index).
function push(f: number[], idx: number[], pri: number, i: number) {
  let k = f.length;
  f.push(pri);
  idx.push(i);
  while (k > 0) {
    const p = (k - 1) >> 1;
    if (f[p] <= pri) break;
    f[k] = f[p];
    idx[k] = idx[p];
    k = p;
  }
  f[k] = pri;
  idx[k] = i;
}

function pop(f: number[], idx: number[]): number {
  const top = idx[0];
  const lastF = f.pop()!;
  const lastI = idx.pop()!;
  const n = f.length;
  if (n > 0) {
    let k = 0;
    for (;;) {
      const l = k * 2 + 1;
      if (l >= n) break;
      const r = l + 1;
      const m = r < n && f[r] < f[l] ? r : l;
      if (f[m] >= lastF) break;
      f[k] = f[m];
      idx[k] = idx[m];
      k = m;
    }
    f[k] = lastF;
    idx[k] = lastI;
  }
  return top;
}
