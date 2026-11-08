import Phaser from "phaser";
import { Callbacks, type Room } from "@colyseus/sdk";
import { ARENA_SIZE, BULLET_LIFETIME_MS, BULLET_SPEED, RESPAWN_MS } from "../../shared/constants";
import { angleDelta, applyInput, isMoving, NO_INPUT, type InputState } from "../../shared/movement";
import type { BulletEndEvent, KillEvent, ShotEvent } from "../../shared/messages";
import { createSoldier, drawHealthBar, type SoldierView } from "./soldier";
import type { Hud } from "./hud";
import { renderMap } from "./mapRender";

/** What the client knows about a player (a live view of the server's synced state). */
interface PlayerData {
  name: string;
  x: number;
  y: number;
  angle: number;
  color: number;
  hp: number;
  alive: boolean;
  kills: number;
  deaths: number;
  ammo: number;
  reserve: number;
  reloading: boolean;
}

interface PickupData {
  x: number;
  y: number;
}

interface PlayerView {
  soldier: SoldierView;
  data: PlayerData;
  lastHp: number;
  wasAlive: boolean;
}

interface BulletView {
  sprite: Phaser.GameObjects.Rectangle;
  vx: number;
  vy: number;
  bornAt: number;
}

export interface GameSceneData {
  room: Room;
  hud: Hud;
  onPlayerCount?: (count: number) => void;
  onRoomName?: (name: string) => void;
}

const ANGLE_SEND_INTERVAL_MS = 50;
/** Camera zoom: 1 = no zoom, higher = closer to the player. Override with ?zoom=0.5 in the URL. */
const CAMERA_ZOOM = Number(new URLSearchParams(location.search).get("zoom")) || 1.4;
/** The map is baked at this resolution so it stays sharp at the default zoom. */
const MAP_RESOLUTION = 1.4;

export class GameScene extends Phaser.Scene {
  private room!: Room;
  private hud!: Hud;
  private onPlayerCount?: (count: number) => void;
  private onRoomName?: (name: string) => void;

  private views = new Map<string, PlayerView>();
  private bullets = new Map<number, BulletView>();
  private pickups = new Map<string, Phaser.GameObjects.Container>();

  private myInput: InputState = { ...NO_INPUT };
  private lastSentKeys = "";
  private lastSentAngle = 0;
  private lastSentAt = 0;
  private keys!: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key[]>;
  private crosshair!: Phaser.GameObjects.Graphics;

  /** Our own predicted position (moves instantly, corrected by the server). */
  private me = { x: 0, y: 0 };
  private diedAt = 0;
  private killedBy = "";
  private scoreboardTimer = 0;

  constructor() {
    super("game");
  }

  init(data: GameSceneData) {
    this.room = data.room;
    this.hud = data.hud;
    this.onRoomName = data.onRoomName;
    this.onPlayerCount = data.onPlayerCount;
    this.views.clear();
    this.bullets.clear();
    this.pickups.clear();
    this.lastSentKeys = "";
  }

  create() {
    renderMap(this, MAP_RESOLUTION);

    const cam = this.cameras.main;
    cam.setBackgroundColor("#0b0d12");
    cam.setBounds(-60, -60, ARENA_SIZE + 120, ARENA_SIZE + 120);
    cam.setZoom(CAMERA_ZOOM);

    // Controls: WASD / arrows to move, mouse to aim, left click to shoot, R to reload.
    const kb = this.input.keyboard!;
    const k = Phaser.Input.Keyboard.KeyCodes;
    this.keys = {
      up: [kb.addKey(k.UP), kb.addKey(k.W)],
      down: [kb.addKey(k.DOWN), kb.addKey(k.S)],
      left: [kb.addKey(k.LEFT), kb.addKey(k.A)],
      right: [kb.addKey(k.RIGHT), kb.addKey(k.D)],
    };
    kb.on("keydown-R", () => this.room.send("reload"));
    this.input.mouse?.disableContextMenu();
    this.input.setDefaultCursor("none");
    // Drawn in world space (at the mouse's world position) so camera zoom can't shift it off the cursor.
    this.crosshair = this.add.graphics().setDepth(1000);

    this.hud.show();
    this.listenToRoom();
  }

  // ---------- Server state & events ----------

  private listenToRoom() {
    const $ = Callbacks.get(this.room);
    $.listen("roomName", (name: string) => this.onRoomName?.(name));

    $.onAdd("players", (player, key) => {
      this.addPlayer(key as string, player as PlayerData);
      this.onPlayerCount?.(this.views.size);
    });
    $.onRemove("players", (_player, key) => {
      this.views.get(key as string)?.soldier.root.destroy();
      this.views.delete(key as string);
      this.onPlayerCount?.(this.views.size);
    });

    $.onAdd("pickups", (pickup, key) => this.addPickup(key as string, pickup as PickupData));
    $.onRemove("pickups", (_pickup, key) => {
      this.pickups.get(key as string)?.destroy();
      this.pickups.delete(key as string);
    });

    this.room.onMessage("shot", (shot: ShotEvent) => this.spawnBullet(shot));
    this.room.onMessage("bulletEnd", (end: BulletEndEvent) => this.endBullet(end));
    this.room.onMessage("kill", (kill: KillEvent) => {
      const killer = this.views.get(kill.killer)?.data.name ?? "Someone";
      const victim = this.views.get(kill.victim)?.data.name ?? "Someone";
      this.hud.addKill(killer, victim);
      if (kill.victim === this.room.sessionId) this.killedBy = killer;
    });
  }

  // ---------- Frame update ----------

  update(time: number, delta: number) {
    const mine = this.views.get(this.room.sessionId);
    this.readInput(time, mine);

    const smoothing = 1 - Math.pow(0.001, delta / 1000); // frame-rate independent lerp factor

    this.views.forEach((view, sessionId) => {
      const { soldier, data } = view;
      const isMe = sessionId === this.room.sessionId;

      // Respawned: jump straight to the new spot.
      if (data.alive && !view.wasAlive) {
        soldier.root.setPosition(data.x, data.y);
        if (isMe) this.me = { x: data.x, y: data.y };
      }
      // Just died: leave a mark on the floor.
      if (!data.alive && view.wasAlive) {
        this.deathEffect(soldier.root.x, soldier.root.y, data.color);
        if (isMe) this.diedAt = time;
      }
      view.wasAlive = data.alive;
      soldier.root.setVisible(data.alive);

      // Took damage: flash red and update the health bar.
      if (data.hp !== view.lastHp) {
        if (data.hp < view.lastHp) this.flashHit(soldier);
        drawHealthBar(soldier.hpBar, data.hp);
        view.lastHp = data.hp;
      }

      if (isMe && data.alive) {
        // Our player: predict locally so movement and aim feel instant...
        applyInput(this.me, this.myInput, delta);
        // ...then drift toward the server's position (gentle while moving, firm when stopped).
        const dist = Phaser.Math.Distance.Between(this.me.x, this.me.y, data.x, data.y);
        const pull = !isMoving(this.myInput) ? smoothing * 0.5 : dist > 120 ? 0.3 : 0;
        this.me.x += (data.x - this.me.x) * pull;
        this.me.y += (data.y - this.me.y) * pull;
        soldier.root.setPosition(this.me.x, this.me.y);
        soldier.body.rotation = this.myInput.angle;
      } else {
        // Other players: interpolate position and aim toward the latest server values.
        soldier.root.x += (data.x - soldier.root.x) * smoothing;
        soldier.root.y += (data.y - soldier.root.y) * smoothing;
        soldier.body.rotation += angleDelta(soldier.body.rotation, data.angle) * Math.min(1, smoothing * 1.5);
      }
    });

    this.updateBullets(time, delta);
    this.updateHud(time, delta, mine);
  }

  private readInput(time: number, mine?: PlayerView) {
    const held = (list: Phaser.Input.Keyboard.Key[]) => list.some((key) => key.isDown);
    const pointer = this.input.activePointer;

    // Aim from our soldier to the mouse, in world coordinates.
    const world = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    let angle = this.myInput.angle;
    if (mine) angle = Math.atan2(world.y - this.me.y, world.x - this.me.x);

    this.myInput = {
      up: held(this.keys.up),
      down: held(this.keys.down),
      left: held(this.keys.left),
      right: held(this.keys.right),
      fire: pointer.leftButtonDown(),
      angle,
    };

    // Send immediately when keys/fire change; send aim-only changes at most every 50ms.
    const keys = `${+this.myInput.up}${+this.myInput.down}${+this.myInput.left}${+this.myInput.right}${+this.myInput.fire}`;
    const aimChanged = Math.abs(angleDelta(this.lastSentAngle, angle)) > 0.01;
    if (keys !== this.lastSentKeys || (aimChanged && time - this.lastSentAt >= ANGLE_SEND_INTERVAL_MS)) {
      this.room.send("input", { ...this.myInput, angle: Math.round(angle * 1000) / 1000 });
      this.lastSentKeys = keys;
      this.lastSentAngle = angle;
      this.lastSentAt = time;
    }

    this.drawCrosshair(world.x, world.y, mine?.data.reloading ?? false);
  }

  private updateHud(time: number, delta: number, mine?: PlayerView) {
    if (mine) {
      const d = mine.data;
      this.hud.setHealth(d.hp);
      this.hud.setAmmo(d.ammo, d.reserve, d.reloading);
      if (d.alive) {
        this.hud.setDead(false);
      } else {
        const secs = Math.max(1, Math.ceil((RESPAWN_MS - (time - this.diedAt)) / 1000));
        const by = this.killedBy ? `Eliminated by ${this.killedBy}` : "Eliminated";
        this.hud.setDead(true, `${by} · respawning in ${secs}…`);
      }
    }

    this.scoreboardTimer -= delta;
    if (this.scoreboardTimer <= 0) {
      this.scoreboardTimer = 250;
      const rows = [...this.views].map(([id, v]) => ({
        name: v.data.name,
        kills: v.data.kills,
        deaths: v.data.deaths,
        isMe: id === this.room.sessionId,
      }));
      this.hud.setScoreboard(rows);
    }
  }

  // ---------- Players ----------

  private addPlayer(sessionId: string, data: PlayerData) {
    const isMe = sessionId === this.room.sessionId;
    const soldier = createSoldier(this, data.x, data.y, data.color, isMe ? `${data.name} (you)` : data.name, isMe);
    soldier.body.rotation = data.angle;
    drawHealthBar(soldier.hpBar, data.hp);
    this.views.set(sessionId, { soldier, data, lastHp: data.hp, wasAlive: data.alive });

    if (isMe) {
      this.me = { x: data.x, y: data.y };
      this.cameras.main.startFollow(soldier.root, true, 0.12, 0.12);
    }
  }

  private flashHit(soldier: SoldierView) {
    this.tweens.killTweensOf(soldier.hitFlash);
    soldier.hitFlash.setAlpha(0.65);
    this.tweens.add({ targets: soldier.hitFlash, alpha: 0, duration: 180 });
  }

  private deathEffect(x: number, y: number, color: number) {
    const splat = this.add.circle(x, y, 18, 0x7a1010, 0.7).setDepth(1);
    const ring = this.add.circle(x, y, 10, color, 0).setStrokeStyle(3, color, 0.9).setDepth(30);
    this.tweens.add({ targets: ring, scale: 4, alpha: 0, duration: 400, onComplete: () => ring.destroy() });
    this.tweens.add({ targets: splat, alpha: 0, delay: 2000, duration: 1500, onComplete: () => splat.destroy() });
  }

  // ---------- Bullets ----------

  private spawnBullet(shot: ShotEvent) {
    const vx = Math.cos(shot.angle) * BULLET_SPEED;
    const vy = Math.sin(shot.angle) * BULLET_SPEED;

    // Tracer
    const sprite = this.add.rectangle(shot.x, shot.y, 16, 3, 0xffe08a).setRotation(shot.angle).setDepth(15);
    this.bullets.set(shot.id, { sprite, vx, vy, bornAt: this.time.now });

    // Muzzle flash
    const flash = this.add.circle(shot.x, shot.y, 7, 0xfff1b0, 1).setDepth(25);
    this.tweens.add({ targets: flash, scale: 0.2, alpha: 0, duration: 70, onComplete: () => flash.destroy() });

    // Small recoil kick on the shooter
    const shooter = this.views.get(shot.owner);
    if (shooter) {
      const body = shooter.soldier.body;
      this.tweens.killTweensOf(body);
      body.setPosition(0, 0);
      this.tweens.add({
        targets: body,
        x: -Math.cos(shot.angle) * 2,
        y: -Math.sin(shot.angle) * 2,
        duration: 40,
        yoyo: true,
      });
    }
  }

  private updateBullets(time: number, delta: number) {
    const dt = delta / 1000;
    this.bullets.forEach((b, id) => {
      b.sprite.x += b.vx * dt;
      b.sprite.y += b.vy * dt;
      // Safety net in case the server's "bulletEnd" never arrives.
      if (time - b.bornAt > BULLET_LIFETIME_MS + 500) {
        b.sprite.destroy();
        this.bullets.delete(id);
      }
    });
  }

  private endBullet(end: BulletEndEvent) {
    const b = this.bullets.get(end.id);
    if (b) {
      b.sprite.destroy();
      this.bullets.delete(end.id);
    }
    this.impactEffect(end.x, end.y, end.hit !== "");
  }

  private impactEffect(x: number, y: number, hitPlayer: boolean) {
    const color = hitPlayer ? 0xff4040 : 0x9aa3b5;
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2;
      const dist = 8 + Math.random() * 10;
      const p = this.add.circle(x, y, hitPlayer ? 2.5 : 2, color, 1).setDepth(16);
      this.tweens.add({
        targets: p,
        x: x + Math.cos(a) * dist,
        y: y + Math.sin(a) * dist,
        alpha: 0,
        duration: 220,
        onComplete: () => p.destroy(),
      });
    }
  }

  // ---------- Ammo crates ----------

  private addPickup(id: string, data: PickupData) {
    const g = this.add.graphics();
    g.fillStyle(0x000000, 0.3);
    g.fillRoundedRect(-11, -6, 26, 18, 3); // shadow
    g.fillStyle(0x4f5b2e, 1);
    g.fillRoundedRect(-13, -9, 26, 18, 3); // crate
    g.lineStyle(2, 0x2f371b, 1);
    g.strokeRoundedRect(-13, -9, 26, 18, 3);
    g.lineBetween(-13, 0, 13, 0);
    // Three brass rounds on top
    for (let i = -1; i <= 1; i++) {
      g.fillStyle(0xd9a441, 1);
      g.fillRect(i * 6 - 1.5, -6, 3, 10);
      g.fillStyle(0xb0b6c0, 1);
      g.fillRect(i * 6 - 1.5, -8, 3, 3);
    }

    const crate = this.add.container(data.x, data.y, [g]).setDepth(5);
    this.tweens.add({ targets: crate, scale: 1.12, duration: 700, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    this.pickups.set(id, crate);
  }

  // ---------- Drawing ----------

  private drawCrosshair(x: number, y: number, reloading: boolean) {
    const g = this.crosshair;
    const color = reloading ? 0xf0c040 : 0xffffff;
    g.clear();
    // Counter the zoom so the crosshair stays the same size on screen.
    g.setPosition(x, y).setScale(1 / this.cameras.main.zoom);
    x = 0;
    y = 0;
    g.lineStyle(2, 0x000000, 0.5);
    g.strokeCircle(x, y, 10);
    g.lineStyle(1.5, color, 1);
    g.strokeCircle(x, y, 10);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      g.lineBetween(x + dx * 5, y + dy * 5, x + dx * 14, y + dy * 14);
    }
    g.fillStyle(color, 1);
    g.fillCircle(x, y, 1.5);
  }
}
