import Phaser from "phaser";
import { ARENA_SIZE } from "../../shared/constants";
import {
  INTERSECTIONS,
  ROADS,
  ROAD_WIDTH,
  SIDEWALK_WIDTH,
  seededRandom,
  type CircleObstacle,
  type GameMap,
  type RectObstacle,
} from "../../shared/map";
import { shade } from "./soldier";
import { bakeAtlas } from "./atlas";

export interface RenderedMap {
  objects: Phaser.GameObjects.GameObject[];
  /** Texture keys made for this map (remove them when the map is replaced). */
  textures: string[];
}

/** Decoration density is tuned per 2000×2000 area and scaled to the real map size. */
const DENSITY = (ARENA_SIZE / 2000) ** 2;

type G = Phaser.GameObjects.Graphics;

/**
 * Draws the whole arena once into textures (fast to render every frame).
 * `resolution` > 1 bakes extra detail so it stays sharp when the camera zooms in.
 * Tree canopies go on a separate layer above the soldiers.
 * Returns everything it created (game objects, plus texture keys to remove), so the map
 * can be swapped for a new one.
 */
export function renderMap(scene: Phaser.Scene, map: GameMap, resolution: number): RenderedMap {
  const created: Phaser.GameObjects.GameObject[] = [];
  const textures: string[] = [];
  const g = scene.add.graphics();
  g.setScale(resolution);

  const rng = seededRandom(map.seed);
  drawGrass(g, rng);
  drawGrounds(g, map, rng);
  drawRoads(g);
  drawShadows(g, map);
  for (const o of map.obstacles) {
    if (o.kind === "rect") drawRect(g, o, rng);
    else if (o.style !== "tree") drawRound(g, o);
  }

  // Bake into a grid of tiles: one texture for the whole map would exceed the
  // 4096px texture limit many GPUs have.
  const tiles = Math.ceil((ARENA_SIZE * resolution) / 2048);
  const tileWorld = ARENA_SIZE / tiles;
  const tilePx = Math.ceil(tileWorld * resolution) + 2; // +2px overlap hides seams
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const wx = tx * tileWorld;
      const wy = ty * tileWorld;
      const rt = scene.add.renderTexture(wx, wy, tilePx, tilePx).setOrigin(0, 0).setScale(1 / resolution).setDepth(0);
      rt.draw(g, -wx * resolution, -wy * resolution);
      rt.render();
      created.push(rt);
    }
  }
  g.destroy();

  // Tree canopies sit above the soldiers. Baked once into one small texture (one image per
  // tree) instead of a live Graphics, which Phaser would re-triangulate every frame.
  const trees = map.obstacles.filter((o): o is CircleObstacle => o.kind === "circle" && o.style === "tree");
  const canopyKey = `canopy-${map.seed}`;
  const cells = trees.map((o) => {
    const size = (o.r + 12) * 2 + 4; // canopy radius is trunk + 12, plus its outline
    return { w: size, h: size, draw: (cg: G, cx: number, cy: number) => drawTree(cg, { ...o, x: cx, y: cy }, rng) };
  });
  if (bakeAtlas(scene, canopyKey, cells, resolution)) {
    trees.forEach((o, i) => created.push(scene.add.image(o.x, o.y, canopyKey, String(i)).setScale(1 / resolution).setDepth(30)));
    textures.push(canopyKey);
  } else {
    const canopy = scene.add.graphics().setDepth(30); // fallback: live vector graphics
    for (const o of trees) drawTree(canopy, o, rng);
    created.push(canopy);
  }

  // Arena border wall
  const border = scene.add.graphics().setDepth(1);
  border.lineStyle(14, 0x2a2622, 1);
  border.strokeRect(-7, -7, ARENA_SIZE + 14, ARENA_SIZE + 14);
  border.lineStyle(3, 0x55504a, 1);
  border.strokeRect(-1, -1, ARENA_SIZE + 2, ARENA_SIZE + 2);

  created.push(border);
  return { objects: created, textures };
}

// ---------- Ground ----------

function drawGrass(g: G, rng: () => number) {
  g.fillStyle(0x4c7a3a, 1);
  g.fillRect(0, 0, ARENA_SIZE, ARENA_SIZE);

  // Big soft patches of lighter / darker grass
  for (let i = 0; i < 160 * DENSITY; i++) {
    const x = rng() * ARENA_SIZE;
    const y = rng() * ARENA_SIZE;
    const w = 80 + rng() * 220;
    const h = 60 + rng() * 160;
    g.fillStyle(rng() < 0.5 ? 0x578a43 : 0x436c33, 0.35);
    g.fillEllipse(x, y, w, h);
  }

  // Grass tufts
  for (let i = 0; i < 1400 * DENSITY; i++) {
    const x = rng() * ARENA_SIZE;
    const y = rng() * ARENA_SIZE;
    g.lineStyle(1.5, rng() < 0.5 ? 0x5f9a4a : 0x3b6130, 0.8);
    g.lineBetween(x, y, x - 2, y - 5);
    g.lineBetween(x + 2, y, x + 3, y - 6);
    g.lineBetween(x + 4, y, x + 6, y - 4);
  }

  // Little flowers
  const flowerColors = [0xf2e86d, 0xffffff, 0xe78bd0, 0x9fc8ff];
  for (let i = 0; i < 260 * DENSITY; i++) {
    const x = rng() * ARENA_SIZE;
    const y = rng() * ARENA_SIZE;
    g.fillStyle(flowerColors[Math.floor(rng() * flowerColors.length)], 0.9);
    g.fillCircle(x, y, 2);
  }

  // Low bushes (decoration only: you can walk and shoot through them)
  for (let i = 0; i < 70 * DENSITY; i++) {
    const x = rng() * ARENA_SIZE;
    const y = rng() * ARENA_SIZE;
    const r = 10 + rng() * 8;
    g.fillStyle(0x000000, 0.18);
    g.fillCircle(x + 3, y + 4, r);
    g.fillStyle(0x3d6b2c, 1);
    g.fillCircle(x, y, r);
    g.fillStyle(0x4f8a38, 1);
    g.fillCircle(x - r * 0.3, y - r * 0.3, r * 0.6);
  }
}

function drawRoads(g: G) {
  // Sidewalks (a bit wider than the road on each side)
  g.fillStyle(0x9b9890, 1);
  for (const r of ROADS) {
    if (r.w > r.h) g.fillRect(r.x, r.y - SIDEWALK_WIDTH, r.w, r.h + SIDEWALK_WIDTH * 2);
    else g.fillRect(r.x - SIDEWALK_WIDTH, r.y, r.w + SIDEWALK_WIDTH * 2, r.h);
  }
  // Curb lines
  g.lineStyle(2, 0x7a776f, 1);
  for (const r of ROADS) {
    if (r.w > r.h) {
      g.lineBetween(0, r.y, ARENA_SIZE, r.y);
      g.lineBetween(0, r.y + r.h, ARENA_SIZE, r.y + r.h);
    } else {
      g.lineBetween(r.x, 0, r.x, ARENA_SIZE);
      g.lineBetween(r.x + r.w, 0, r.x + r.w, ARENA_SIZE);
    }
  }
  // Sidewalk tiles
  g.lineStyle(1, 0x85827a, 1);
  for (let i = 0; i < ARENA_SIZE; i += 32) {
    for (const r of ROADS) {
      if (r.w > r.h) {
        g.lineBetween(i, r.y - SIDEWALK_WIDTH, i, r.y);
        g.lineBetween(i, r.y + r.h, i, r.y + r.h + SIDEWALK_WIDTH);
      } else {
        g.lineBetween(r.x - SIDEWALK_WIDTH, i, r.x, i);
        g.lineBetween(r.x + r.w, i, r.x + r.w + SIDEWALK_WIDTH, i);
      }
    }
  }

  // Asphalt
  g.fillStyle(0x3b3e44, 1);
  for (const r of ROADS) g.fillRect(r.x, r.y, r.w, r.h);

  const half = ROAD_WIDTH / 2;
  const centers = [...new Set(INTERSECTIONS.map((p) => p.x))];
  const inCrossing = (i: number) => centers.some((c) => i + 30 > c - half - 40 && i < c + half + 40);

  // Dashed yellow center lines (skipping the crossroads)
  g.fillStyle(0xe2c044, 1);
  for (const c of centers) {
    for (let i = 10; i < ARENA_SIZE; i += 60) {
      if (inCrossing(i)) continue;
      g.fillRect(i, c - 2, 30, 4);
      g.fillRect(c - 2, i, 4, 30);
    }
  }

  // Zebra crossings on all four sides of every crossroads
  g.fillStyle(0xe8e8e8, 0.9);
  for (const p of INTERSECTIONS) {
    const ax = p.x - half;
    const bx = p.x + half;
    const ay = p.y - half;
    const by = p.y + half;
    for (let i = 8; i < ROAD_WIDTH - 8; i += 16) {
      g.fillRect(ax + i, ay - 34, 9, 26); // north
      g.fillRect(ax + i, by + 8, 9, 26); // south
      g.fillRect(ax - 34, ay + i, 26, 9); // west
      g.fillRect(bx + 8, ay + i, 26, 9); // east
    }
  }

  // Cracks and oil stains
  const rng = seededRandom(7);
  for (let i = 0; i < 40 * DENSITY; i++) {
    const road = ROADS[i % ROADS.length];
    const x = road.x + rng() * road.w;
    const y = road.y + rng() * road.h;
    g.fillStyle(0x2c2e33, 0.6);
    g.fillEllipse(x, y, 14 + rng() * 20, 8 + rng() * 12);
  }
}

function drawGrounds(g: G, map: GameMap, rng: () => number) {
  for (const a of map.grounds) {
    const { x, y, w, h } = a;
    switch (a.kind) {
      case "field": // ploughed crop rows
        g.fillStyle(0x7a5c3a, 1);
        g.fillRect(x, y, w, h);
        for (let i = y + 6; i < y + h - 4; i += 18) {
          g.fillStyle(0x5f4529, 1);
          g.fillRect(x + 4, i, w - 8, 5);
          g.fillStyle(0x6c9a3c, 1);
          for (let j = x + 10; j < x + w - 10; j += 14) g.fillCircle(j + rng() * 4, i + 11, 3.5);
        }
        break;
      case "gravel":
        g.fillStyle(0x8f8676, 1);
        g.fillRect(x, y, w, h);
        for (let i = 0; i < (w * h) / 900; i++) {
          g.fillStyle(rng() < 0.5 ? 0x7a7264 : 0xa39a88, 0.8);
          g.fillCircle(x + rng() * w, y + rng() * h, 1.5 + rng() * 2);
        }
        break;
      case "concrete":
        g.fillStyle(0x84878b, 1);
        g.fillRect(x, y, w, h);
        g.lineStyle(1.5, 0x6f7276, 1);
        for (let i = x; i <= x + w; i += 86) g.lineBetween(i, y, i, y + h);
        for (let i = y; i <= y + h; i += 86) g.lineBetween(x, i, x + w, i);
        for (let i = 0; i < 30; i++) {
          g.fillStyle(0x5d6064, 0.45);
          g.fillEllipse(x + rng() * w, y + rng() * h, 20 + rng() * 40, 10 + rng() * 20);
        }
        break;
      case "paving":
        g.fillStyle(0xb8a88a, 1);
        g.fillRect(x, y, w, h);
        g.lineStyle(1, 0x9c8d72, 1);
        for (let row = 0, i = y; i <= y + h; i += 20, row++) {
          g.lineBetween(x, i, x + w, i);
          for (let j = x + (row % 2) * 20; j < x + w; j += 40) g.lineBetween(j, i, j, Math.min(i + 20, y + h));
        }
        g.lineStyle(4, 0x8a7c63, 1);
        g.strokeRect(x, y, w, h);
        break;
    }
  }
}

function drawShadows(g: G, map: GameMap) {
  g.fillStyle(0x000000, 0.25);
  for (const o of map.obstacles) {
    if (o.kind === "rect") {
      const off = o.style === "building" ? 10 : 5;
      g.fillRect(o.x + off, o.y + off, o.w, o.h);
    } else if (o.style === "tree") {
      g.fillCircle(o.x + 10, o.y + 12, o.r + 14);
    } else {
      g.fillCircle(o.x + 4, o.y + 5, o.r);
    }
  }
}

// ---------- Solid obstacles ----------

function drawRect(g: G, o: RectObstacle, rng: () => number) {
  const { x, y, w, h } = o;
  const horizontal = w >= h;

  switch (o.style) {
    case "building": {
      const roof = o.color ?? 0x8a4a3a;
      g.fillStyle(shade(roof, 0.75), 1);
      g.fillRect(x, y, w, h);
      // Two roof halves with a ridge line
      g.fillStyle(roof, 1);
      if (horizontal) g.fillRect(x + 4, y + 4, w - 8, h / 2 - 4);
      else g.fillRect(x + 4, y + 4, w / 2 - 4, h - 8);
      g.fillStyle(shade(roof, 0.88), 1);
      if (horizontal) g.fillRect(x + 4, y + h / 2, w - 8, h / 2 - 4);
      else g.fillRect(x + w / 2, y + 4, w / 2 - 4, h - 8);
      // Roof tiles
      g.lineStyle(1, shade(roof, 0.65), 0.6);
      if (horizontal) for (let i = y + 14; i < y + h - 4; i += 12) g.lineBetween(x + 4, i, x + w - 4, i);
      else for (let i = x + 14; i < x + w - 4; i += 12) g.lineBetween(i, y + 4, i, y + h - 4);
      g.lineStyle(3, shade(roof, 0.55), 1);
      if (horizontal) g.lineBetween(x + 4, y + h / 2, x + w - 4, y + h / 2);
      else g.lineBetween(x + w / 2, y + 4, x + w / 2, y + h - 4);
      // Chimney
      g.fillStyle(0x6b5b55, 1);
      g.fillRect(x + w * 0.72, y + h * 0.18, 22, 22);
      g.fillStyle(0x2b2522, 1);
      g.fillRect(x + w * 0.72 + 5, y + h * 0.18 + 5, 12, 12);
      g.lineStyle(2, 0x1d1b1a, 1);
      g.strokeRect(x, y, w, h);
      break;
    }

    case "car": {
      const body = o.color ?? 0xaa3333;
      g.fillStyle(0x111111, 1); // tires peeking out
      if (horizontal) {
        g.fillRect(x + 10, y - 3, 16, 4);
        g.fillRect(x + w - 26, y - 3, 16, 4);
        g.fillRect(x + 10, y + h - 1, 16, 4);
        g.fillRect(x + w - 26, y + h - 1, 16, 4);
      } else {
        g.fillRect(x - 3, y + 10, 4, 16);
        g.fillRect(x - 3, y + h - 26, 4, 16);
        g.fillRect(x + w - 1, y + 10, 4, 16);
        g.fillRect(x + w - 1, y + h - 26, 4, 16);
      }
      g.fillStyle(body, 1);
      g.fillRoundedRect(x, y, w, h, 8);
      g.fillStyle(shade(body, 1.2), 1);
      g.fillRoundedRect(x + (horizontal ? 24 : 5), y + (horizontal ? 5 : 24), horizontal ? w - 44 : w - 10, horizontal ? h - 10 : h - 44, 5);
      // Windshields
      g.fillStyle(0x23303c, 1);
      if (horizontal) {
        g.fillRect(x + w - 30, y + 6, 8, h - 12);
        g.fillRect(x + 16, y + 7, 7, h - 14);
      } else {
        g.fillRect(x + 6, y + h - 30, w - 12, 8);
        g.fillRect(x + 7, y + 16, w - 14, 7);
      }
      // Headlights
      g.fillStyle(0xfff4c2, 1);
      if (horizontal) {
        g.fillRect(x + w - 4, y + 5, 3, 7);
        g.fillRect(x + w - 4, y + h - 12, 3, 7);
      } else {
        g.fillRect(x + 5, y + h - 4, 7, 3);
        g.fillRect(x + w - 12, y + h - 4, 7, 3);
      }
      g.lineStyle(1.5, shade(body, 0.5), 1);
      g.strokeRoundedRect(x, y, w, h, 8);
      break;
    }

    case "barrier": {
      g.fillStyle(0x9fa3a7, 1);
      g.fillRect(x, y, w, h);
      g.fillStyle(0xc5c8cb, 1);
      if (horizontal) g.fillRect(x, y + h / 2 - 2, w, 4);
      else g.fillRect(x + w / 2 - 2, y, 4, h);
      // Hazard stripes on the ends
      g.fillStyle(0xe0a020, 1);
      if (horizontal) {
        g.fillRect(x, y, 6, h);
        g.fillRect(x + w - 6, y, 6, h);
      } else {
        g.fillRect(x, y, w, 6);
        g.fillRect(x, y + h - 6, w, 6);
      }
      g.lineStyle(1.5, 0x5c6064, 1);
      g.strokeRect(x, y, w, h);
      break;
    }

    case "sandbag": {
      g.fillStyle(0x8e7f58, 1);
      g.fillRect(x, y, w, h);
      // Individual bags in staggered rows
      const bagL = 24;
      const along = horizontal ? w : h;
      const across = horizontal ? h : w;
      const rows = 2;
      const rowSize = across / rows;
      for (let row = 0; row < rows; row++) {
        const offset = row % 2 ? bagL / 2 : 0;
        for (let p = -offset; p < along; p += bagL) {
          const s = Math.max(0, p);
          const e = Math.min(along, p + bagL);
          if (e - s < 4) continue;
          const bx = horizontal ? x + s : x + row * rowSize;
          const by = horizontal ? y + row * rowSize : y + s;
          const bw = horizontal ? e - s : rowSize;
          const bh = horizontal ? rowSize : e - s;
          g.fillStyle(row % 2 ? 0xc2b07e : 0xb5a271, 1);
          g.fillRoundedRect(bx + 1, by + 1, bw - 2, bh - 2, 4);
          g.lineStyle(1, 0x6f6345, 1);
          g.strokeRoundedRect(bx + 1, by + 1, bw - 2, bh - 2, 4);
        }
      }
      break;
    }

    case "container": {
      const c = o.color ?? 0x8a3a2e;
      g.fillStyle(c, 1);
      g.fillRect(x, y, w, h);
      g.lineStyle(1.5, shade(c, 0.7), 1);
      if (horizontal) for (let i = x + 8; i < x + w; i += 8) g.lineBetween(i, y + 3, i, y + h - 3);
      else for (let i = y + 8; i < y + h; i += 8) g.lineBetween(x + 3, i, x + w - 3, i);
      g.lineStyle(3, shade(c, 0.5), 1);
      g.strokeRect(x, y, w, h);
      break;
    }

    case "crate": {
      g.fillStyle(0xa8743f, 1);
      g.fillRect(x, y, w, h);
      g.lineStyle(3, 0x6e4a26, 1);
      g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
      g.lineStyle(2.5, 0x7d5530, 1);
      g.lineBetween(x + 3, y + 3, x + w - 3, y + h - 3);
      g.lineBetween(x + w - 3, y + 3, x + 3, y + h - 3);
      break;
    }

    case "dumpster": {
      g.fillStyle(0x2f6b5a, 1);
      g.fillRect(x, y, w, h);
      g.fillStyle(0x245446, 1);
      g.fillRect(x + 2, y + 2, w / 2 - 3, h - 4);
      g.fillRect(x + w / 2 + 1, y + 2, w / 2 - 3, h - 4);
      g.lineStyle(2, 0x173a30, 1);
      g.strokeRect(x, y, w, h);
      break;
    }

    case "brick": {
      g.fillStyle(0x9c4b36, 1);
      g.fillRect(x, y, w, h);
      g.lineStyle(1, 0x6d3122, 1);
      // Two courses of bricks along the wall's length (either direction).
      for (let row = 0; row < 2; row++) {
        if (horizontal) {
          const rowH = h / 2;
          g.lineBetween(x, y + row * rowH, x + w, y + row * rowH);
          for (let i = x + (row ? 10 : 0); i < x + w; i += 20) g.lineBetween(i, y + row * rowH, i, y + (row + 1) * rowH);
        } else {
          const colW = w / 2;
          g.lineBetween(x + row * colW, y, x + row * colW, y + h);
          for (let i = y + (row ? 10 : 0); i < y + h; i += 20) g.lineBetween(x + row * colW, i, x + (row + 1) * colW, i);
        }
      }
      g.lineStyle(1.5, 0x5a281b, 1);
      g.strokeRect(x, y, w, h);
      break;
    }

    case "hedge": {
      g.fillStyle(0x2e5a23, 1);
      g.fillRoundedRect(x, y, w, h, 8);
      const along = horizontal ? w : h;
      for (let p = 6; p < along - 4; p += 9) {
        const cx = horizontal ? x + p : x + w / 2 + (rng() - 0.5) * 4;
        const cy = horizontal ? y + h / 2 + (rng() - 0.5) * 4 : y + p;
        g.fillStyle(rng() < 0.5 ? 0x3c7430 : 0x46833a, 1);
        g.fillCircle(cx, cy, 7);
      }
      break;
    }

    case "stone": {
      g.fillStyle(0x7e776d, 1);
      g.fillRect(x, y, w, h);
      g.lineStyle(1, 0x5a544c, 1);
      const along = horizontal ? w : h;
      for (let p = 0; p < along; p += 18 + rng() * 10) {
        if (horizontal) g.lineBetween(x + p, y, x + p, y + h);
        else g.lineBetween(x, y + p, x + w, y + p);
      }
      g.lineStyle(2, 0x4d4842, 1);
      g.strokeRect(x, y, w, h);
      break;
    }

    case "fence": {
      // Two rails and posts
      g.fillStyle(0x9c7146, 1);
      if (horizontal) {
        g.fillRect(x, y + 2, w, 3);
        g.fillRect(x, y + h - 5, w, 3);
      } else {
        g.fillRect(x + 2, y, 3, h);
        g.fillRect(x + w - 5, y, 3, h);
      }
      g.fillStyle(0x6b4a2b, 1);
      const along = horizontal ? w : h;
      for (let p = 0; p <= along - 10; p += 30) {
        if (horizontal) g.fillRect(x + p, y, 10, h);
        else g.fillRect(x, y + p, w, 10);
      }
      if (horizontal) g.fillRect(x + w - 10, y, 10, h);
      else g.fillRect(x, y + h - 10, w, 10);
      break;
    }

    case "hay": {
      g.fillStyle(0xd8b44a, 1);
      g.fillRoundedRect(x, y, w, h, 5);
      g.lineStyle(1, 0xb08d2e, 1);
      for (let i = x + 6; i < x + w - 3; i += 6) g.lineBetween(i, y + 3, i - 2, y + h - 3);
      g.lineStyle(2.5, 0x8c5a2b, 1);
      g.lineBetween(x + w * 0.3, y, x + w * 0.3, y + h);
      g.lineBetween(x + w * 0.7, y, x + w * 0.7, y + h);
      break;
    }

    case "pipe": {
      g.fillStyle(0x5d6d7e, 1);
      g.fillRect(x, y, w, h);
      g.fillStyle(0x85929e, 1);
      if (horizontal) g.fillRect(x, y + 5, w, h * 0.3);
      else g.fillRect(x + 5, y, w * 0.3, h);
      g.fillStyle(0x2c3e50, 1); // open ends
      if (horizontal) {
        g.fillEllipse(x + 4, y + h / 2, 8, h - 6);
        g.fillEllipse(x + w - 4, y + h / 2, 8, h - 6);
      } else {
        g.fillEllipse(x + w / 2, y + 4, w - 6, 8);
        g.fillEllipse(x + w / 2, y + h - 4, w - 6, 8);
      }
      g.lineStyle(1.5, 0x34495e, 1);
      g.strokeRect(x, y, w, h);
      break;
    }

    case "concrete": {
      g.fillStyle(0xa7a9ac, 1);
      g.fillRect(x, y, w, h);
      g.fillStyle(0xbfc1c4, 1);
      g.fillRect(x + 3, y + 3, w - 6, h * 0.35);
      for (let i = 0; i < (w * h) / 300; i++) {
        g.fillStyle(0x8e9093, 1);
        g.fillCircle(x + 3 + rng() * (w - 6), y + 3 + rng() * (h - 6), 1.2);
      }
      g.lineStyle(1.5, 0x6e7073, 1);
      g.strokeRect(x, y, w, h);
      break;
    }

    case "stall": {
      const c = o.color ?? 0xc0392b;
      g.fillStyle(0x8a6239, 1); // wooden counter peeking out the front
      g.fillRect(x + 4, y + h - 10, w - 8, 10);
      // Striped awning
      const stripes = 7;
      for (let i = 0; i < stripes; i++) {
        g.fillStyle(i % 2 ? 0xf4f1e8 : c, 1);
        g.fillRect(x + (i * w) / stripes, y, w / stripes + 0.5, h - 8);
      }
      g.lineStyle(2, shade(c, 0.6), 1);
      g.strokeRect(x, y, w, h - 8);
      // Fruit on the counter
      for (let i = x + 12; i < x + w - 8; i += 11) {
        g.fillStyle([0xe74c3c, 0xf39c12, 0x27ae60][Math.floor(rng() * 3)], 1);
        g.fillCircle(i, y + h - 5, 3.5);
      }
      break;
    }

    case "log": {
      // Works lying either way (random maps rotate blocks).
      const t = Math.min(w, h); // thickness
      g.fillStyle(0x6b4a2b, 1);
      g.fillRoundedRect(x, y, w, h, t / 2);
      g.lineStyle(1, 0x4d331c, 1);
      if (horizontal) for (let i = x + 10; i < x + w - 10; i += 14) g.lineBetween(i, y + 4, i + 8, y + h - 4);
      else for (let i = y + 10; i < y + h - 10; i += 14) g.lineBetween(x + 4, i, x + w - 4, i + 8);
      // Cut end with rings
      const ex = horizontal ? x + w - t / 2 : x + w / 2;
      const ey = horizontal ? y + h / 2 : y + h - t / 2;
      g.fillStyle(0xb08a5a, 1);
      g.fillCircle(ex, ey, t / 2 - 2);
      g.lineStyle(1, 0x7d5d38, 1);
      g.strokeCircle(ex, ey, t / 4);
      break;
    }
  }
}

function drawRound(g: G, o: CircleObstacle) {
  const { x, y, r } = o;
  switch (o.style) {
    case "rock":
      g.fillStyle(0x6f7275, 1);
      g.fillCircle(x, y, r);
      g.fillStyle(0x8d9093, 1);
      g.fillCircle(x - r * 0.25, y - r * 0.25, r * 0.65);
      g.fillStyle(0xa5a8ab, 1);
      g.fillCircle(x - r * 0.4, y - r * 0.4, r * 0.25);
      g.lineStyle(1.5, 0x4a4c4e, 1);
      g.strokeCircle(x, y, r);
      break;

    case "barrel":
      g.fillStyle(0xb5462b, 1);
      g.fillCircle(x, y, r);
      g.lineStyle(2, 0x7a2c1a, 1);
      g.strokeCircle(x, y, r);
      g.strokeCircle(x, y, r * 0.6);
      g.fillStyle(0x3a3a3a, 1);
      g.fillCircle(x + r * 0.35, y - r * 0.2, 2.5);
      break;

    case "silo":
      g.fillStyle(0xa9b1b8, 1);
      g.fillCircle(x, y, r);
      g.lineStyle(2, 0x7f8a93, 1);
      g.strokeCircle(x, y, r);
      g.strokeCircle(x, y, r * 0.7);
      g.strokeCircle(x, y, r * 0.4);
      g.fillStyle(0xd0d6db, 1);
      g.fillCircle(x - r * 0.3, y - r * 0.3, r * 0.2);
      g.fillStyle(0x6e7880, 1);
      g.fillCircle(x, y, 5);
      break;

    case "statue":
      g.fillStyle(0x9a958c, 1); // plinth
      g.fillCircle(x, y, r);
      g.lineStyle(2, 0x6a665f, 1);
      g.strokeCircle(x, y, r);
      g.fillStyle(0x4f7a6e, 1); // bronze-green figure seen from above
      g.fillEllipse(x, y, r * 1.0, r * 0.6);
      g.fillCircle(x + r * 0.15, y, r * 0.28);
      g.fillStyle(0x6f9d8f, 1);
      g.fillCircle(x + r * 0.05, y - r * 0.08, r * 0.12);
      break;

    case "fountain":
      g.fillStyle(0x9a958c, 1);
      g.fillCircle(x, y, r);
      g.fillStyle(0x3d7fb8, 1);
      g.fillCircle(x, y, r - 9);
      g.fillStyle(0x5fa3d8, 0.8);
      g.fillCircle(x - 8, y - 8, r - 24);
      g.fillStyle(0x9a958c, 1);
      g.fillCircle(x, y, 12);
      g.fillStyle(0xcde7f7, 1);
      g.fillCircle(x, y, 5);
      g.lineStyle(2, 0x6a665f, 1);
      g.strokeCircle(x, y, r);
      break;
  }
}

function drawTree(g: G, o: CircleObstacle, rng: () => number) {
  // The collision circle is the trunk + lower leaves; the canopy hangs a little wider.
  const { x, y, r } = o;
  const R = r + 12;
  g.fillStyle(0x2c5422, 1);
  g.fillCircle(x, y, R);
  for (let i = 0; i < 6; i++) {
    const a = rng() * Math.PI * 2;
    const d = rng() * R * 0.5;
    g.fillStyle(rng() < 0.5 ? 0x386b2b : 0x3f7a30, 1);
    g.fillCircle(x + Math.cos(a) * d, y + Math.sin(a) * d, R * (0.45 + rng() * 0.2));
  }
  g.fillStyle(0x5a9a44, 0.7);
  g.fillCircle(x - R * 0.3, y - R * 0.3, R * 0.3);
  g.lineStyle(2, 0x1f3d18, 0.8);
  g.strokeCircle(x, y, R);
}
