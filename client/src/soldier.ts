import Phaser from "phaser";
import { PLAYER_MAX_HP } from "../../shared/constants";

// A top-down soldier, drawn facing RIGHT (angle 0). The whole `body` container is
// rotated to the aim angle; the name and health bar live outside it so they stay upright.

const SKIN = 0xe2b48c;
const GUN_DARK = 0x1b1e24;
const GUN_METAL = 0x3a3f48;

export interface SoldierView {
  root: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Container;
  hitFlash: Phaser.GameObjects.Arc;
  hpBar: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
}

export function createSoldier(
  scene: Phaser.Scene,
  x: number,
  y: number,
  color: number,
  name: string,
  isMe: boolean,
): SoldierView {
  const g = scene.add.graphics();
  drawSoldier(g, color, isMe);

  // Red overlay that flashes when hit.
  const hitFlash = scene.add.circle(0, 0, 22, 0xff3030, 1).setAlpha(0);

  const body = scene.add.container(0, 0, [g, hitFlash]);

  const label = scene.add
    .text(0, -44, name, {
      fontFamily: "system-ui, sans-serif",
      fontSize: "13px",
      fontStyle: "bold",
      color: isMe ? "#ffffff" : "#d6d9e4",
      stroke: "#0b0d12",
      strokeThickness: 3,
    })
    .setOrigin(0.5);

  const hpBar = scene.add.graphics();
  drawHealthBar(hpBar, PLAYER_MAX_HP);

  const root = scene.add.container(x, y, [body, hpBar, label]);
  root.setDepth(isMe ? 20 : 10);

  return { root, body, hitFlash, hpBar, label };
}

export function drawHealthBar(g: Phaser.GameObjects.Graphics, hp: number) {
  const w = 38;
  const h = 5;
  const pct = Math.max(0, Math.min(1, hp / PLAYER_MAX_HP));
  g.clear();
  g.fillStyle(0x0b0d12, 0.8);
  g.fillRect(-w / 2 - 1, -33, w + 2, h + 2);
  g.fillStyle(pct > 0.5 ? 0x6fdc6f : pct > 0.25 ? 0xf0c040 : 0xf05050, 1);
  g.fillRect(-w / 2, -32, w * pct, h);
}

function drawSoldier(g: Phaser.GameObjects.Graphics, color: number, isMe: boolean) {
  const dark = shade(color, 0.62);
  const darker = shade(color, 0.45);
  const light = shade(color, 1.35);

  // Ground shadow
  g.fillStyle(0x000000, 0.28);
  g.fillEllipse(3, 4, 36, 46);

  // "You" ring on the ground
  if (isMe) {
    g.lineStyle(2, 0xffffff, 0.55);
    g.strokeCircle(0, 0, 27);
  }

  // Backpack (behind the shoulders)
  g.fillStyle(darker, 1);
  g.fillRoundedRect(-20, -11, 12, 22, 4);
  g.lineStyle(1.5, 0x000000, 0.3);
  g.strokeRoundedRect(-20, -11, 12, 22, 4);

  // Rifle: stock, receiver, magazine, barrel, held on the right side (+y)
  g.fillStyle(GUN_DARK, 1);
  g.fillRect(-2, 4, 8, 5); // stock
  g.fillRect(6, 3, 20, 7); // receiver
  g.fillRect(13, 9, 4, 6); // magazine
  g.fillStyle(GUN_METAL, 1);
  g.fillRect(26, 4.5, 11, 3); // barrel
  g.fillRect(9, 4, 10, 2); // top rail highlight

  // Shoulders / torso
  g.fillStyle(color, 1);
  g.fillEllipse(-3, 0, 24, 40);
  g.lineStyle(2, dark, 1);
  g.strokeEllipse(-3, 0, 24, 40);

  // Arms reaching forward to the rifle
  g.lineStyle(7, color, 1);
  g.lineBetween(-2, 14, 9, 9); // right arm → trigger hand
  g.lineBetween(-2, -14, 22, 4); // left arm → support hand on the barrel guard
  g.fillStyle(color, 1);
  g.fillCircle(-2, 14, 4);
  g.fillCircle(-2, -14, 4);

  // Hands
  g.fillStyle(SKIN, 1);
  g.fillCircle(10, 9, 3.6);
  g.fillCircle(22, 5, 3.6);

  // Helmet
  g.fillStyle(dark, 1);
  g.fillCircle(0, 0, 10.5);
  g.lineStyle(1.5, 0x000000, 0.35);
  g.strokeCircle(0, 0, 10.5);
  g.fillStyle(light, 0.55);
  g.fillCircle(-2.5, -3, 4);
  // Helmet brim hint at the front
  g.lineStyle(2, darker, 1);
  g.beginPath();
  g.arc(0, 0, 10.5, -0.9, 0.9);
  g.strokePath();
}

/** Multiply an 0xRRGGBB color's brightness. */
export function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * factor));
  const gr = Math.min(255, Math.round(((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.round((color & 0xff) * factor));
  return (r << 16) | (gr << 8) | b;
}
