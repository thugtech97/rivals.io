import Phaser from "phaser";
import { ARENA_SIZE } from "../../shared/constants";
import {
  OBSTACLES,
  ROADS,
  ROAD_WIDTH,
  SIDEWALK_WIDTH,
  seededRandom,
  type CircleObstacle,
  type RectObstacle,
} from "../../shared/map";
import { shade } from "./soldier";

type G = Phaser.GameObjects.Graphics;

/**
 * Draws the whole arena once into a texture (fast to render every frame).
 * `resolution` > 1 bakes extra detail so it stays sharp when the camera zooms in.
 * Tree canopies go on a separate layer above the soldiers.
 */
export function renderMap(scene: Phaser.Scene, resolution: number) {
  const g = scene.add.graphics();
  g.setScale(resolution);

  const rng = seededRandom(42);
  drawGrass(g, rng);
  drawRoads(g);
  drawShadows(g);
  for (const o of OBSTACLES) {
    if (o.kind === "rect") drawRect(g, o, rng);
    else if (o.style !== "tree") drawRound(g, o);
  }

  const size = Math.ceil(ARENA_SIZE * resolution);
  const rt = scene.add.renderTexture(0, 0, size, size).setOrigin(0, 0).setScale(1 / resolution).setDepth(0);
  rt.draw(g, 0, 0);
  rt.render();
  g.destroy();

  // Canopies stay as live vector graphics (crisp, only a few hundred shapes).
  const canopy = scene.add.graphics().setDepth(30);
  for (const o of OBSTACLES) if (o.kind === "circle" && o.style === "tree") drawTree(canopy, o, rng);

  // Arena border wall
  const border = scene.add.graphics().setDepth(1);
  border.lineStyle(14, 0x2a2622, 1);
  border.strokeRect(-7, -7, ARENA_SIZE + 14, ARENA_SIZE + 14);
  border.lineStyle(3, 0x55504a, 1);
  border.strokeRect(-1, -1, ARENA_SIZE + 2, ARENA_SIZE + 2);
}

// ---------- Ground ----------

function drawGrass(g: G, rng: () => number) {
  g.fillStyle(0x4c7a3a, 1);
  g.fillRect(0, 0, ARENA_SIZE, ARENA_SIZE);

  // Big soft patches of lighter / darker grass
  for (let i = 0; i < 160; i++) {
    const x = rng() * ARENA_SIZE;
    const y = rng() * ARENA_SIZE;
    const w = 80 + rng() * 220;
    const h = 60 + rng() * 160;
    g.fillStyle(rng() < 0.5 ? 0x578a43 : 0x436c33, 0.35);
    g.fillEllipse(x, y, w, h);
  }

  // Grass tufts
  for (let i = 0; i < 1400; i++) {
    const x = rng() * ARENA_SIZE;
    const y = rng() * ARENA_SIZE;
    g.lineStyle(1.5, rng() < 0.5 ? 0x5f9a4a : 0x3b6130, 0.8);
    g.lineBetween(x, y, x - 2, y - 5);
    g.lineBetween(x + 2, y, x + 3, y - 6);
    g.lineBetween(x + 4, y, x + 6, y - 4);
  }

  // Little flowers
  const flowerColors = [0xf2e86d, 0xffffff, 0xe78bd0, 0x9fc8ff];
  for (let i = 0; i < 260; i++) {
    const x = rng() * ARENA_SIZE;
    const y = rng() * ARENA_SIZE;
    g.fillStyle(flowerColors[Math.floor(rng() * flowerColors.length)], 0.9);
    g.fillCircle(x, y, 2);
  }

  // Low bushes (decoration only: you can walk and shoot through them)
  for (let i = 0; i < 70; i++) {
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

  // A dirt path through the forest
  g.fillStyle(0x8a7350, 0.55);
  for (let t = 0; t <= 1; t += 0.01) {
    const x = 120 + t * 780;
    const y = 820 - t * 600 + Math.sin(t * 9) * 50;
    g.fillCircle(x, y, 18);
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

  const mid = ARENA_SIZE / 2;
  const a = mid - ROAD_WIDTH / 2;
  const b = mid + ROAD_WIDTH / 2;

  // Dashed yellow center lines (skip the intersection)
  g.fillStyle(0xe2c044, 1);
  for (let i = 10; i < ARENA_SIZE; i += 60) {
    if (i + 30 > a - 40 && i < b + 40) continue;
    g.fillRect(i, mid - 2, 30, 4);
    g.fillRect(mid - 2, i, 4, 30);
  }

  // Zebra crossings on all four sides of the crossroads
  g.fillStyle(0xe8e8e8, 0.9);
  for (let i = a + 8; i < b - 8; i += 16) {
    g.fillRect(i, a - 34, 9, 26); // north
    g.fillRect(i, b + 8, 9, 26); // south
    g.fillRect(a - 34, i, 26, 9); // west
    g.fillRect(b + 8, i, 26, 9); // east
  }

  // Cracks and oil stains
  const rng = seededRandom(7);
  for (let i = 0; i < 40; i++) {
    const road = ROADS[i % 2];
    const x = road.x + rng() * road.w;
    const y = road.y + rng() * road.h;
    g.fillStyle(0x2c2e33, 0.6);
    g.fillEllipse(x, y, 14 + rng() * 20, 8 + rng() * 12);
  }
}

function drawShadows(g: G) {
  g.fillStyle(0x000000, 0.25);
  for (const o of OBSTACLES) {
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
      const rowH = h / 2;
      for (let row = 0; row < 2; row++) {
        g.lineBetween(x, y + row * rowH, x + w, y + row * rowH);
        for (let i = x + (row ? 10 : 0); i < x + w; i += 20) g.lineBetween(i, y + row * rowH, i, y + (row + 1) * rowH);
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

    case "log": {
      g.fillStyle(0x6b4a2b, 1);
      g.fillRoundedRect(x, y, w, h, h / 2);
      g.lineStyle(1, 0x4d331c, 1);
      for (let i = x + 10; i < x + w - 10; i += 14) g.lineBetween(i, y + 4, i + 8, y + h - 4);
      g.fillStyle(0xb08a5a, 1);
      g.fillCircle(x + w - h / 2, y + h / 2, h / 2 - 2);
      g.lineStyle(1, 0x7d5d38, 1);
      g.strokeCircle(x + w - h / 2, y + h / 2, h / 4);
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
