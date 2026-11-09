import Phaser from "phaser";
import { bakeAtlas } from "./atlas";
import { particleCount, qualitySettings } from "./quality";

// Blood effects: sprays when a bullet hits, splats on the ground, drip trails at low HP,
// and pools on death. Everything is cosmetic (client-side only) and fades away.
//
// Stains are images cut from a few pre-drawn variants (baked once), not live Graphics:
// a long fight leaves a couple of hundred of them, and Graphics are redrawn every frame.

const DARK = 0x5c0606;
const RED = 0x8a0f0f;
const BRIGHT = 0xb01818;
const STAIN_DEPTH = 2; // on the ground: above the map, under crates and soldiers

const ATLAS_KEY = "blood-stains";
/** Variants are drawn at this blob size, then scaled to each stain's size. */
const BASE_SIZE = 24;
/** Texture pixels per world pixel for the variants (a little extra so big pools stay sharp). */
const ATLAS_RES = 1.5;
const SPATTER_VARIANTS = 8; // splats with spatter flung to one side
const DROP_VARIANTS = 3; // small round drops

export class Blood {
  private stains: Phaser.GameObjects.Image[] = [];
  private baked = false;

  constructor(private scene: Phaser.Scene) {
    const cells = [];
    for (let i = 0; i < SPATTER_VARIANTS + DROP_VARIANTS; i++) {
      const spatter = i < SPATTER_VARIANTS;
      // The blob's center is the image's center, so the cell is symmetric around it
      // (spatter reaches ~3.2× the blob size to the right, so the cell is that wide both ways).
      cells.push({
        w: BASE_SIZE * 6.6,
        h: BASE_SIZE * 2.4,
        draw: (g: Phaser.GameObjects.Graphics, cx: number, cy: number) => drawStain(g, cx, cy, BASE_SIZE, spatter),
      });
    }
    this.baked = bakeAtlas(scene, ATLAS_KEY, cells, ATLAS_RES);
  }

  /** A bullet hit someone at (x, y) travelling at `angle`: droplets fly on, a splatter lands behind. */
  bulletHit(x: number, y: number, angle: number) {
    this.spray(x, y, angle, 14);
    this.stain(x + Math.cos(angle) * 24, y + Math.sin(angle) * 24, 10 + Math.random() * 4, angle, 8000);
  }

  /** Burned by the red zone: blood bursts out all around and splats under the soldier. */
  wound(x: number, y: number) {
    const a = Math.random() * Math.PI * 2;
    this.spray(x, y, a, 12, Math.PI);
    this.stain(x + (Math.random() - 0.5) * 20, y + (Math.random() - 0.5) * 20, 9 + Math.random() * 4, a, 7000);
  }

  /** One drop from a badly hurt soldier. */
  drip(x: number, y: number) {
    this.stain(x + (Math.random() - 0.5) * 14, y + (Math.random() - 0.5) * 14, 2.5 + Math.random() * 2.5, undefined, 5000);
  }

  /** A soldier went down. */
  pool(x: number, y: number) {
    this.spray(x, y, Math.random() * Math.PI * 2, 14, Math.PI);
    this.stain(x, y, 20 + Math.random() * 6, Math.random() * Math.PI * 2, 12000);
  }

  /** Droplets that fly out in a cone around `angle` and vanish (fewer on lower quality). */
  private spray(x: number, y: number, angle: number, count: number, spread = 0.6) {
    const n = particleCount(count, 3);
    for (let i = 0; i < n; i++) {
      const a = angle + (Math.random() - 0.5) * spread * 2;
      const dist = 16 + Math.random() * 34;
      const drop = this.scene.add.circle(x, y, 1.5 + Math.random() * 2, Math.random() < 0.5 ? RED : BRIGHT, 1).setDepth(16);
      this.scene.tweens.add({
        targets: drop,
        x: x + Math.cos(a) * dist,
        y: y + Math.sin(a) * dist,
        scale: 0.4,
        alpha: 0,
        duration: 220 + Math.random() * 160,
        ease: "Quad.easeOut",
        onComplete: () => drop.destroy(),
      });
    }
  }

  /** A blood stain on the ground: a main blob with spatter thrown toward `angle`. Fades after `lifeMs`. */
  private stain(x: number, y: number, size: number, angle: number | undefined, lifeMs: number) {
    if (!this.baked) return; // couldn't bake the variants (no texture space): skip stains
    const spatter = angle !== undefined || size > 6;
    const frame = spatter ? Math.floor(Math.random() * SPATTER_VARIANTS) : SPATTER_VARIANTS + Math.floor(Math.random() * DROP_VARIANTS);
    const img = this.scene.add
      .image(x, y, ATLAS_KEY, String(frame))
      .setScale(size / BASE_SIZE / ATLAS_RES)
      .setRotation(angle ?? Math.random() * Math.PI * 2)
      .setDepth(STAIN_DEPTH)
      .setAlpha(0.85);

    this.stains.push(img);
    const max = qualitySettings().maxStains;
    while (this.stains.length > max) {
      const old = this.stains.shift()!;
      this.scene.tweens.killTweensOf(old);
      old.destroy();
    }

    this.scene.tweens.add({
      targets: img,
      alpha: 0,
      delay: lifeMs,
      duration: 1500,
      onComplete: () => {
        this.stains = this.stains.filter((s) => s !== img);
        img.destroy();
      },
    });
  }
}

/** One stain drawn with its blob centered at (cx, cy); spatter is flung toward +x. */
function drawStain(g: Phaser.GameObjects.Graphics, cx: number, cy: number, size: number, spatter: boolean) {
  g.fillStyle(RED, 1);
  g.fillCircle(cx, cy, size);
  g.fillEllipse(cx + size * 0.5, cy, size * 1.8, size * 1.1);
  if (spatter) {
    const n = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const d = size * (1 + Math.random() * 1.8);
      const r = size * (0.12 + Math.random() * 0.3);
      g.fillCircle(cx + d, cy + (Math.random() - 0.5) * size * 1.4, r);
    }
  }
  g.fillStyle(DARK, 0.7);
  g.fillCircle(cx - size * 0.1, cy + size * 0.05, size * 0.55);
}
