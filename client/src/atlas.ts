import Phaser from "phaser";

// Bake many small vector drawings into ONE texture, once.
//
// Phaser re-processes every Graphics object's shapes on every frame (arcs into points,
// then triangles), so hundreds of live circles cost real CPU on phones. Images that share
// one texture are nearly free and draw in a single batch.

export interface AtlasCell {
  /** Size of the drawing in world pixels (it is drawn centered in its cell). */
  w: number;
  h: number;
  /** Draw the shape centered at (cx, cy) into `g` (world pixel units). */
  draw: (g: Phaser.GameObjects.Graphics, cx: number, cy: number) => void;
}

const MAX_WIDTH = 2048;
const MAX_HEIGHT = 4096;
const PAD = 2; // texture pixels around each cell so neighbours never bleed in

/**
 * Bake ONE drawing into its own texture `key` (once: later calls just reuse it).
 * `draw` draws around (0, 0); the drawing must fit in a `w`×`h` box CENTERED on (0, 0),
 * so `scene.add.image(x, y, key).setScale(1 / resolution)` puts that (0, 0) at (x, y),
 * and rotating the image turns it around that same point.
 */
export function bakeShape(
  scene: Phaser.Scene,
  key: string,
  w: number,
  h: number,
  resolution: number,
  draw: (g: Phaser.GameObjects.Graphics) => void,
): boolean {
  if (scene.textures.exists(key)) return true;
  const texture = scene.textures.addDynamicTexture(key, Math.ceil(w * resolution) + PAD * 2, Math.ceil(h * resolution) + PAD * 2);
  if (!texture) return false;
  const g = scene.add.graphics();
  g.setScale(resolution);
  draw(g);
  texture.draw(g, texture.width / 2, texture.height / 2);
  texture.render();
  g.destroy();
  return true;
}

/**
 * Bake `cells` into a texture called `key` at `resolution` texture pixels per world pixel.
 * Frame i is named String(i). Use it with `scene.add.image(x, y, key, String(i)).setScale(1 / resolution)`.
 * Returns false (and creates nothing) if the cells don't fit in one texture.
 */
export function bakeAtlas(scene: Phaser.Scene, key: string, cells: AtlasCell[], resolution: number): boolean {
  // Simple shelf packing, in texture pixels.
  const boxes: { x: number; y: number; w: number; h: number }[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let width = 0;
  for (const c of cells) {
    const w = Math.ceil(c.w * resolution) + PAD * 2;
    const h = Math.ceil(c.h * resolution) + PAD * 2;
    if (w > MAX_WIDTH) return false;
    if (x + w > MAX_WIDTH) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    boxes.push({ x, y, w, h });
    x += w;
    rowH = Math.max(rowH, h);
    width = Math.max(width, x);
  }
  const height = y + rowH;
  if (cells.length === 0 || height > MAX_HEIGHT) return false;

  if (scene.textures.exists(key)) scene.textures.remove(key);
  const texture = scene.textures.addDynamicTexture(key, width, height);
  if (!texture) return false;

  const g = scene.add.graphics();
  g.setScale(resolution);
  cells.forEach((c, i) => {
    const b = boxes[i];
    c.draw(g, (b.x + b.w / 2) / resolution, (b.y + b.h / 2) / resolution);
  });
  texture.draw(g, 0, 0);
  texture.render();
  g.destroy();

  boxes.forEach((b, i) => texture.add(String(i), 0, b.x, b.y, b.w, b.h));
  return true;
}
