import { ARENA_SIZE } from "../../shared/constants";

// A small square in the corner that shows only where YOU are in the arena.

export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private sizePx = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  /** Match the canvas resolution to its on-screen size (sharp on high-DPI screens). */
  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round((this.canvas.clientWidth || 180) * dpr);
    if (px !== this.sizePx) {
      this.sizePx = px;
      this.canvas.width = this.canvas.height = px;
    }
  }

  /**
   * Draw a frame. `me` is your position and aim (null while dead);
   * `zone` is the safe square and where it shrinks to next (null before it appears).
   */
  update(me: { x: number; y: number; angle: number; color: number } | null, zone: MinimapZone | null, timeMs: number) {
    this.resize();
    const ctx = this.ctx;
    const px = this.sizePx;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, px, px);
    if (zone) this.drawZone(zone);
    if (!me) return;

    const x = (me.x / ARENA_SIZE) * px;
    const y = (me.y / ARENA_SIZE) * px;

    // Pulsing ring so you can spot yourself instantly
    const t = (timeMs % 1200) / 1200;
    ctx.beginPath();
    ctx.arc(x, y, (4 + t * 9) * dpr, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${0.8 * (1 - t)})`;
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();

    // Aim direction
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(me.angle) * 9 * dpr, y + Math.sin(me.angle) * 9 * dpr);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();

    // The dot: your uniform color with a white outline
    ctx.beginPath();
    ctx.arc(x, y, 4 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = `#${me.color.toString(16).padStart(6, "0")}`;
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();
  }

  /** Red danger area outside the safe square, its red edge, and the next square in white. */
  private drawZone(z: MinimapZone) {
    const ctx = this.ctx;
    const px = this.sizePx;
    const dpr = window.devicePixelRatio || 1;
    const s = px / ARENA_SIZE;
    const x = z.x * s;
    const y = z.y * s;
    const size = z.size * s;

    if (z.next) {
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = 1 * dpr;
      ctx.strokeRect(z.next.x * s, z.next.y * s, z.next.size * s, z.next.size * s);
    }

    // Still the whole map: nothing dangerous to show yet.
    if (z.size >= ARENA_SIZE - 0.5) return;

    // Danger: fill everything, then cut the safe square back out.
    ctx.fillStyle = "rgba(208, 24, 24, 0.35)";
    ctx.beginPath();
    ctx.rect(0, 0, px, px);
    ctx.rect(x, y, size, size);
    ctx.fill("evenodd");

    ctx.strokeStyle = "#ff2a2a";
    ctx.lineWidth = 2 * dpr;
    ctx.strokeRect(x, y, size, size);
  }
}

export interface MinimapZone {
  x: number;
  y: number;
  size: number;
  /** Where it will shrink to next (omit once it's final). */
  next?: { x: number; y: number; size: number };
}
