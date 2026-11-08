// On-screen twin-stick controls for phones and tablets.
//
//   left thumb  → MOVE stick (appears where you touch on the left side)
//   right thumb → AIM stick: push it far enough and you shoot / swing
//   buttons     → pick up, reload, switch weapon, drop
//
// "Touch mode" turns on with the first touch, and off again when a real mouse moves,
// so touchscreen laptops work both ways.

export type TouchAction = "pickup" | "reload" | "next-weapon" | "drop";

/** Push the aim stick at least this far (0..1) to fire. */
const FIRE_THRESHOLD = 0.55;
/** Ignore tiny stick movements. */
const DEAD_ZONE = 0.2;
const STICK_RADIUS = 56; // px the knob can travel

const $ = (id: string) => document.getElementById(id)!;

// ---------- Touch mode (body.touch-mode) ----------

let touchMode = window.matchMedia?.("(pointer: coarse)").matches ?? false;
const listeners: ((on: boolean) => void)[] = [];

function setTouchMode(on: boolean) {
  if (on === touchMode) return;
  touchMode = on;
  document.body.classList.toggle("touch-mode", on);
  listeners.forEach((l) => l(on));
}
document.body.classList.toggle("touch-mode", touchMode);
window.addEventListener("pointerdown", (e) => e.pointerType === "touch" && setTouchMode(true), { capture: true, passive: true });
window.addEventListener("pointermove", (e) => e.pointerType === "mouse" && e.movementX + e.movementY !== 0 && setTouchMode(false), { passive: true });

export function isTouchMode() {
  return touchMode;
}
export function onTouchModeChange(fn: (on: boolean) => void) {
  listeners.push(fn);
}

// ---------- A virtual joystick ----------

class Stick {
  /** -1..1 on each axis (length ≤ 1). */
  x = 0;
  y = 0;
  private pointerId: number | null = null;
  private cx = 0;
  private cy = 0;
  private base: HTMLElement;
  private knob: HTMLElement;

  constructor(private zone: HTMLElement) {
    this.base = zone.querySelector(".stick-base") as HTMLElement;
    this.knob = zone.querySelector(".stick-knob") as HTMLElement;
    zone.addEventListener("pointerdown", (e) => this.start(e));
    zone.addEventListener("pointermove", (e) => this.drag(e));
    zone.addEventListener("pointerup", (e) => this.end(e));
    zone.addEventListener("pointercancel", (e) => this.end(e));
  }

  get length() {
    return Math.hypot(this.x, this.y);
  }
  get angle() {
    return Math.atan2(this.y, this.x);
  }
  get active() {
    return this.pointerId !== null;
  }

  private start(e: PointerEvent) {
    if (this.pointerId !== null) return;
    e.preventDefault();
    this.pointerId = e.pointerId;
    this.zone.setPointerCapture(e.pointerId);
    // The stick appears under your thumb.
    const r = this.zone.getBoundingClientRect();
    this.cx = e.clientX;
    this.cy = e.clientY;
    this.base.style.left = `${e.clientX - r.left}px`;
    this.base.style.top = `${e.clientY - r.top}px`;
    this.zone.classList.add("active");
    this.update(e.clientX, e.clientY);
  }

  private drag(e: PointerEvent) {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    this.update(e.clientX, e.clientY);
  }

  private end(e: PointerEvent) {
    if (e.pointerId !== this.pointerId) return;
    this.reset();
  }

  reset() {
    this.pointerId = null;
    this.x = 0;
    this.y = 0;
    this.knob.style.transform = "translate(-50%, -50%)";
    this.base.style.left = "";
    this.base.style.top = "";
    this.zone.classList.remove("active");
  }

  private update(px: number, py: number) {
    let dx = px - this.cx;
    let dy = py - this.cy;
    const d = Math.hypot(dx, dy);
    if (d > STICK_RADIUS) {
      dx = (dx / d) * STICK_RADIUS;
      dy = (dy / d) * STICK_RADIUS;
    }
    this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    const len = Math.min(1, d / STICK_RADIUS);
    this.x = len < DEAD_ZONE ? 0 : (dx / STICK_RADIUS);
    this.y = len < DEAD_ZONE ? 0 : (dy / STICK_RADIUS);
  }
}

// ---------- The controls ----------

export class TouchControls {
  private root = $("touch-controls");
  private moveStick = new Stick($("stick-move"));
  private aimStick = new Stick($("stick-aim"));
  private pickupBtn = this.root.querySelector('[data-action="pickup"]') as HTMLElement;
  onAction?: (a: TouchAction) => void;
  private shown = false;

  constructor() {
    for (const btn of this.root.querySelectorAll<HTMLElement>("[data-action]")) {
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.classList.add("pressed");
        this.onAction?.(btn.dataset.action as TouchAction);
      });
      const release = () => btn.classList.remove("pressed");
      btn.addEventListener("pointerup", release);
      btn.addEventListener("pointercancel", release);
      btn.addEventListener("pointerleave", release);
    }
  }

  /** Show the sticks (only in touch mode, only while you're alive in a game). */
  setShown(show: boolean) {
    const want = show && touchMode;
    if (want === this.shown) return;
    this.shown = want;
    this.root.hidden = !want;
    if (!want) {
      this.moveStick.reset();
      this.aimStick.reset();
    }
  }

  /** Glow the pick-up button when there's something to pick up / swap. */
  setPickupHint(on: boolean) {
    this.pickupBtn.classList.toggle("hint", on);
  }

  /** Movement as the four direction keys (8 directions, like WASD). */
  get keys() {
    const s = this.moveStick;
    if (!this.shown || s.length < DEAD_ZONE) return { up: false, down: false, left: false, right: false };
    const a = s.angle;
    const c = Math.cos(a);
    const n = Math.sin(a);
    const k = 0.38; // ≈ sin(22.5°): splits the circle into 8 directions
    return { up: n < -k, down: n > k, left: c < -k, right: c > k };
  }

  /** Where to aim: the aim stick, or (if it's idle) the way you're walking. null = keep current. */
  get aimAngle(): number | null {
    if (!this.shown) return null;
    if (this.aimStick.length >= DEAD_ZONE) return this.aimStick.angle;
    if (this.moveStick.length >= DEAD_ZONE) return this.moveStick.angle;
    return null;
  }

  get firing() {
    return this.shown && this.aimStick.length >= FIRE_THRESHOLD;
  }
}
