import Phaser from "phaser";

// Blood effects: sprays when a bullet hits, splats on the ground, drip trails at low HP,
// and pools on death. Everything is cosmetic (client-side only) and fades away.

const DARK = 0x5c0606;
const RED = 0x8a0f0f;
const BRIGHT = 0xb01818;
const MAX_STAINS = 220; // oldest stains are removed beyond this
const STAIN_DEPTH = 2; // on the ground: above the map, under crates and soldiers

export class Blood {
  private stains: Phaser.GameObjects.Graphics[] = [];

  constructor(private scene: Phaser.Scene) {}

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

  /** Droplets that fly out in a cone around `angle` and vanish. */
  private spray(x: number, y: number, angle: number, count: number, spread = 0.6) {
    for (let i = 0; i < count; i++) {
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
    const g = this.scene.add.graphics({ x, y }).setDepth(STAIN_DEPTH).setAlpha(0.85);
    g.setRotation(angle ?? Math.random() * Math.PI * 2);

    g.fillStyle(RED, 1);
    g.fillCircle(0, 0, size);
    g.fillEllipse(size * 0.5, 0, size * 1.8, size * 1.1);
    if (angle !== undefined || size > 6) {
      // Spatter flung outward along the rotation (+x)
      const n = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) {
        const d = size * (1 + Math.random() * 1.8);
        const r = size * (0.12 + Math.random() * 0.3);
        g.fillCircle(d, (Math.random() - 0.5) * size * 1.4, r);
      }
    }
    g.fillStyle(DARK, 0.7);
    g.fillCircle(-size * 0.1, size * 0.05, size * 0.55);

    this.stains.push(g);
    if (this.stains.length > MAX_STAINS) this.stains.shift()?.destroy();

    this.scene.tweens.add({
      targets: g,
      alpha: 0,
      delay: lifeMs,
      duration: 1500,
      onComplete: () => {
        this.stains = this.stains.filter((s) => s !== g);
        g.destroy();
      },
    });
  }
}
