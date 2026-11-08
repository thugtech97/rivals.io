import Phaser from "phaser";
import { PLAYER_MAX_HP } from "../../shared/constants";
import type { WeaponId } from "../../shared/weapons";

// A top-down soldier, drawn facing RIGHT (angle 0). The whole `body` container is
// rotated to the aim angle; the name and health bar live outside it so they stay upright.
//
// body layers (bottom → top): base (shadow, backpack, torso) · vest · arms + weapon · helmet

const SKIN = 0xe2b48c;
const GUN_DARK = 0x1b1e24;
const GUN_METAL = 0x3a3f48;
const STEEL = 0xcfd6dd;
const STEEL_DARK = 0x8b949c;
const WOOD = 0x8a5a2b;

type G = Phaser.GameObjects.Graphics;

export interface SoldierView {
  root: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Container;
  /** Arms + weapon; redrawn when the weapon in hand changes, rotated for melee swings. */
  arms: G;
  vest: G;
  hitFlash: Phaser.GameObjects.Arc;
  hpBar: G;
  label: Phaser.GameObjects.Text;
  color: number;
  weapon: string;
}

export function createSoldier(
  scene: Phaser.Scene,
  x: number,
  y: number,
  color: number,
  name: string,
  isMe: boolean,
): SoldierView {
  const base = scene.add.graphics();
  drawBase(base, color, isMe);
  const vest = scene.add.graphics();
  drawVest(vest);
  vest.setVisible(false);
  const arms = scene.add.graphics();
  const head = scene.add.graphics();
  drawHelmet(head, color);

  // Red overlay that flashes when hit.
  const hitFlash = scene.add.circle(0, 0, 22, 0xff3030, 1).setAlpha(0);

  const body = scene.add.container(0, 0, [base, vest, arms, head, hitFlash]);

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
  drawHealthBar(hpBar, PLAYER_MAX_HP, 0);

  const root = scene.add.container(x, y, [body, hpBar, label]);
  root.setDepth(isMe ? 20 : 10);

  const view: SoldierView = { root, body, arms, vest, hitFlash, hpBar, label, color, weapon: "?" };
  setSoldierWeapon(view, "");
  return view;
}

/** Show the weapon in hand ("" = fists). */
export function setSoldierWeapon(view: SoldierView, weapon: string) {
  if (view.weapon === weapon) return;
  view.weapon = weapon;
  view.arms.clear();
  view.arms.setRotation(0);
  drawArmsWithWeapon(view.arms, (weapon || "fists") as WeaponId, view.color);
}

export function setSoldierVest(view: SoldierView, wearing: boolean) {
  view.vest.setVisible(wearing);
}

/** Health bar, with a thin blue armor bar under it while wearing a vest. */
export function drawHealthBar(g: G, hp: number, armor: number) {
  const w = 38;
  const h = 5;
  const pct = Math.max(0, Math.min(1, hp / PLAYER_MAX_HP));
  g.clear();
  g.fillStyle(0x0b0d12, 0.8);
  g.fillRect(-w / 2 - 1, -33, w + 2, h + 2 + (armor > 0 ? 4 : 0));
  g.fillStyle(pct > 0.5 ? 0x6fdc6f : pct > 0.25 ? 0xf0c040 : 0xf05050, 1);
  g.fillRect(-w / 2, -32, w * pct, h);
  if (armor > 0) {
    g.fillStyle(0x5aa9ff, 1);
    g.fillRect(-w / 2, -26, w * Math.min(1, armor / 50), 2.5);
  }
}

// ---------- Body ----------

function drawBase(g: G, color: number, isMe: boolean) {
  const dark = shade(color, 0.62);
  const darker = shade(color, 0.45);

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

  // Shoulders / torso
  g.fillStyle(color, 1);
  g.fillEllipse(-3, 0, 24, 40);
  g.lineStyle(2, dark, 1);
  g.strokeEllipse(-3, 0, 24, 40);
}

/** Bulletproof vest: a dark plate carrier over the torso. */
function drawVest(g: G) {
  g.fillStyle(0x2f3a2b, 1);
  g.fillRoundedRect(-12, -15, 17, 30, 5);
  g.fillStyle(0x3d4a37, 1);
  g.fillRoundedRect(-9, -12, 11, 24, 3); // front plate
  g.lineStyle(1.5, 0x1c241a, 1);
  g.strokeRoundedRect(-12, -15, 17, 30, 5);
  g.fillStyle(0x1c241a, 1); // pouches
  g.fillRect(-1, -11, 4, 6);
  g.fillRect(-1, 5, 4, 6);
}

function drawHelmet(g: G, color: number) {
  const dark = shade(color, 0.62);
  const darker = shade(color, 0.45);
  const light = shade(color, 1.35);
  g.fillStyle(dark, 1);
  g.fillCircle(0, 0, 10.5);
  g.lineStyle(1.5, 0x000000, 0.35);
  g.strokeCircle(0, 0, 10.5);
  g.fillStyle(light, 0.55);
  g.fillCircle(-2.5, -3, 4);
  g.lineStyle(2, darker, 1); // brim at the front
  g.beginPath();
  g.arc(0, 0, 10.5, -0.9, 0.9);
  g.strokePath();
}

/** Arms from the shoulders to two hand positions (right hand is +y). */
function drawArms(g: G, color: number, right: [number, number], left: [number, number]) {
  g.lineStyle(7, color, 1);
  g.lineBetween(-2, 14, right[0], right[1]);
  g.lineBetween(-2, -14, left[0], left[1]);
  g.fillStyle(color, 1);
  g.fillCircle(-2, 14, 4);
  g.fillCircle(-2, -14, 4);
}

function drawHands(g: G, right: [number, number], left: [number, number]) {
  g.fillStyle(SKIN, 1);
  g.fillCircle(right[0], right[1], 3.6);
  g.fillCircle(left[0], left[1], 3.6);
}

/** Where each weapon is held: [right hand, left hand]. */
const GRIP: Record<WeaponId, [[number, number], [number, number]]> = {
  pistol: [[15, 7], [17, 1]],
  rifle: [[10, 9], [22, 5]],
  mg: [[10, 11], [26, 6]],
  sniper: [[10, 9], [25, 5]],
  knife: [[17, 11], [6, -12]],
  sword: [[15, 11], [4, -13]],
  axe: [[12, 10], [26, 10]],
  fists: [[14, 9], [14, -9]],
};

function drawArmsWithWeapon(g: G, id: WeaponId, color: number) {
  const [right, left] = GRIP[id] ?? GRIP.fists;
  // Two-handed guns sit under the arms; blades are drawn on top of the hand holding them.
  const gunFirst = id === "pistol" || id === "rifle" || id === "mg" || id === "sniper";
  if (gunFirst) drawWeaponShape(g, id, 0, 0);
  drawArms(g, color, right, left);
  if (!gunFirst && id !== "fists") drawWeaponShape(g, id, 0, 0);
  drawHands(g, right, left);
}

// ---------- Weapon shapes (also used for items on the ground) ----------

/** Draw a weapon facing right with its grip around (ox, oy) as held by a soldier. */
export function drawWeaponShape(g: G, id: WeaponId, ox: number, oy: number) {
  const r = (x: number, y: number, w: number, h: number) => g.fillRect(ox + x, oy + y, w, h);
  switch (id) {
    case "pistol":
      g.fillStyle(GUN_DARK, 1);
      r(12, 3, 9, 6); // grip & frame
      g.fillStyle(GUN_METAL, 1);
      r(16, 2.5, 14, 4); // slide
      break;
    case "rifle":
      g.fillStyle(GUN_DARK, 1);
      r(-2, 4, 8, 5); // stock
      r(6, 3, 20, 7); // receiver
      r(13, 9, 4, 6); // magazine
      g.fillStyle(GUN_METAL, 1);
      r(26, 4.5, 11, 3); // barrel
      r(9, 4, 10, 2);
      break;
    case "mg":
      g.fillStyle(GUN_DARK, 1);
      r(-4, 4, 10, 7); // stock
      r(6, 2, 24, 10); // receiver
      g.fillStyle(0x4a5a3a, 1);
      r(12, 11, 10, 9); // ammo box
      g.fillStyle(GUN_METAL, 1);
      r(30, 4.5, 11, 4.5); // heavy barrel
      g.fillStyle(GUN_DARK, 1);
      r(36, 3.5, 2, 6.5); // barrel shroud ring
      break;
    case "sniper":
      g.fillStyle(GUN_DARK, 1);
      r(-4, 4, 12, 5); // stock
      r(8, 3.5, 18, 6); // receiver
      g.fillStyle(GUN_METAL, 1);
      r(26, 5, 22, 2.5); // long barrel
      g.fillStyle(0x111316, 1);
      r(10, 0, 13, 3.5); // scope
      g.fillStyle(0x6fb8ff, 0.9);
      r(22, 0.5, 1.5, 2.5); // lens glint
      break;
    case "knife":
      g.fillStyle(0x2a2a2a, 1);
      r(14, 9, 7, 4); // handle
      g.fillStyle(STEEL, 1);
      g.fillTriangle(ox + 21, oy + 8.5, ox + 21, oy + 13, ox + 35, oy + 11);
      g.lineStyle(1, STEEL_DARK, 1);
      g.lineBetween(ox + 21, oy + 11, ox + 33, oy + 11);
      break;
    case "sword":
      g.fillStyle(0x3b2a1a, 1);
      r(10, 9.5, 7, 3.5); // grip
      g.fillStyle(0xc9a54a, 1);
      r(17, 5, 3, 12); // crossguard
      g.fillStyle(STEEL, 1);
      r(20, 9, 34, 4.5); // blade
      g.fillTriangle(ox + 54, oy + 9, ox + 54, oy + 13.5, ox + 61, oy + 11.2);
      g.lineStyle(1, STEEL_DARK, 1);
      g.lineBetween(ox + 20, oy + 11.2, ox + 56, oy + 11.2);
      break;
    case "axe":
      g.fillStyle(WOOD, 1);
      r(6, 8.5, 42, 3.5); // handle
      g.fillStyle(STEEL_DARK, 1);
      r(38, 4, 8, 11); // head
      g.fillStyle(STEEL, 1);
      g.fillTriangle(ox + 38, oy + 15, ox + 46, oy + 15, ox + 50, oy + 24); // blade (bites to the right side)
      g.fillTriangle(ox + 38, oy + 15, ox + 50, oy + 24, ox + 36, oy + 22);
      break;
    case "fists":
      break;
  }
}

/** Highlight color for loot on the ground. */
export function itemGlow(kind: string, weapon: string): number {
  if (kind === "vest") return 0x5aa9ff;
  if (kind === "ammo") return 0xd9a441;
  return ({ sniper: 0xffc94a, mg: 0xc07aff, rifle: 0x63b3ff, pistol: 0xc9ced6 } as Record<string, number>)[weapon] ?? 0x7ee08a;
}

/** A vest lying on the ground (icon). */
export function drawVestIcon(g: G) {
  g.fillStyle(0x2f3a2b, 1);
  g.fillRoundedRect(-11, -13, 22, 26, 5);
  g.fillStyle(0x3d4a37, 1);
  g.fillRoundedRect(-7, -9, 14, 18, 3);
  g.fillStyle(0x1c241a, 1);
  g.fillRect(-9, -15, 5, 5); // shoulder straps
  g.fillRect(4, -15, 5, 5);
  g.lineStyle(1.5, 0x1c241a, 1);
  g.strokeRoundedRect(-11, -13, 22, 26, 5);
}

/** Multiply an 0xRRGGBB color's brightness. */
export function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * factor));
  const gr = Math.min(255, Math.round(((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.round((color & 0xff) * factor));
  return (r << 16) | (gr << 8) | b;
}
