import Phaser from "phaser";
import { Callbacks, type Room } from "@colyseus/sdk";
import { ARENA_SIZE, MATCH_MIN_PLAYERS, PICKUP_RADIUS, PLAYER_MAX_HP, PLAYER_RADIUS, RESPAWN_MS } from "../../shared/constants";
import { sfx } from "./sound";
import { angleDelta, applyInput, isMoving, muzzlePosition, NO_INPUT, type InputState } from "../../shared/movement";
import type { BulletEndEvent, KillEvent, ShotEvent, SwingEvent } from "../../shared/messages";
import {
  createSoldier,
  drawHealthBar,
  drawVestIcon,
  drawWeaponShape,
  itemGlow,
  setSoldierVest,
  setSoldierWeapon,
  type SoldierView,
} from "./soldier";
import type { Hud, SlotInfo } from "./hud";
import { renderMap } from "./mapRender";
import { Blood } from "./blood";
import { GameMap } from "../../shared/map";
import { isTouchMode, type TouchControls } from "./touchControls";
import { gunStats, heldStats, MEDKIT_HEAL, SLOT_COUNT, WEAPONS, type WeaponId } from "../../shared/weapons";

/** At or below this HP a soldier leaves a blood trail and your screen pulses red. */
const LOW_HP = 30;
/** A position jump bigger than this is a teleport (respawn / match start), not movement. */
const TELEPORT_PX = 400;
/** Distance walked between footstep sounds. */
const STRIDE_PX = 46;
/** How close an item must be to show its name. */
const ITEM_LABEL_RANGE = 120;
const ITEM_REACH = PLAYER_RADIUS + PICKUP_RADIUS + 14;

interface SlotData {
  weapon: string;
  ammo: number;
  reserve: number;
}

/** What the client knows about a player (a live view of the server's synced state). */
interface PlayerData {
  name: string;
  x: number;
  y: number;
  angle: number;
  color: number;
  hp: number;
  armor: number;
  alive: boolean;
  kills: number;
  deaths: number;
  place: number;
  active: number;
  reloading: boolean;
  slots: ArrayLike<SlotData> & { at?: (i: number) => SlotData | undefined };
}

interface ItemData {
  kind: string; // weapon | vest | ammo | medkit
  weapon: string;
  ammo: number;
  reserve: number;
  armor: number;
  x: number;
  y: number;
}

interface ZoneData {
  phase: string; // waiting | hold | shrink | final
  secondsLeft: number;
  x: number;
  y: number;
  size: number;
  nextX: number;
  nextY: number;
  nextSize: number;
}

interface PlayerView {
  soldier: SoldierView;
  data: PlayerData;
  lastHp: number;
  lastArmor: number;
  wasAlive: boolean;
  /** When a bullet / blade last hit this player (so the hit isn't drawn twice). */
  lastBulletHitAt: number;
  /** Countdown to the next blood drop while badly hurt. */
  dripInMs: number;
  /** Where the last footstep sounded (a step every STRIDE_PX walked). */
  stepX: number;
  stepY: number;
}

interface BulletView {
  sprite: Phaser.GameObjects.Rectangle;
  /** Where the server spawned it; the tracer follows the server's path from here. */
  x0: number;
  y0: number;
  vx: number;
  vy: number;
  /** Gap between the gun tip on screen and the server's spawn point (fades out quickly). */
  offX: number;
  offY: number;
  bornAt: number;
  lifeMs: number;
  owner: string;
}

/** How long a tracer takes to slide from the on-screen gun tip onto the server's bullet path. */
const TRACER_BLEND_MS = 120;
/** A bigger gap than this means the shooter view is stale (respawn, teleport): don't fake it. */
const TRACER_MAX_OFFSET_PX = 80;

export interface GameSceneData {
  room: Room;
  hud: Hud;
  onPlayerCount?: (count: number) => void;
  onRoomName?: (name: string) => void;
  /** Called when M toggles sound (true = muted). */
  onMuteToggle?: (muted: boolean) => void;
  /** On-screen sticks for phones / tablets. */
  touch?: TouchControls;
  /** Called once the map is built and you're in it (hides the loading spinner). */
  onReady?: () => void;
}

const ANGLE_SEND_INTERVAL_MS = 50;
/** Camera zoom: 1 = no zoom, higher = closer to the player. Override with ?zoom=0.5 in the URL. */
const ZOOM_PARAM = Number(new URLSearchParams(location.search).get("zoom"));
const CAMERA_ZOOM = ZOOM_PARAM || 1.4;
/** Holding a sniper zooms the camera out so you can see as far as it shoots. */
const SNIPER_ZOOM = Math.min(CAMERA_ZOOM, 0.9);
/** The map is baked at this resolution so it stays sharp at the default zoom. */
const MAP_RESOLUTION = 1.4;

/** Read slot i from the synced array (works with ArraySchema and plain arrays). */
function slotOf(d: PlayerData, i: number): SlotData {
  return (d.slots?.at ? d.slots.at(i) : d.slots?.[i]) ?? { weapon: "", ammo: 0, reserve: 0 };
}

export class GameScene extends Phaser.Scene {
  private room!: Room;
  private hud!: Hud;
  private onPlayerCount?: (count: number) => void;
  private onRoomName?: (name: string) => void;
  private onMuteToggle?: (muted: boolean) => void;
  private touch?: TouchControls;
  private onReady?: () => void;
  private ready = false;

  private views = new Map<string, PlayerView>();
  private bullets = new Map<number, BulletView>();
  private items = new Map<string, { obj: Phaser.GameObjects.Container; data: ItemData }>();
  private itemLabel!: Phaser.GameObjects.Text;

  private myInput: InputState = { ...NO_INPUT };
  private lastSentKeys = "";
  private lastSentAngle = 0;
  private lastSentAt = 0;
  private keys!: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key[]>;
  private crosshair!: Phaser.GameObjects.Graphics;
  private blood!: Blood;
  // Sound bookkeeping
  private wasReloading = false;
  private lastHeld = "";
  private nextDryFireAt = 0;
  private lastBeep = -1;
  private lastPhase = "";
  private map?: GameMap;
  /** Everything renderMap() created, destroyed when the map changes. */
  private mapObjects: Phaser.GameObjects.GameObject[] = [];
  private zoneGfx!: Phaser.GameObjects.Graphics;
  /** The zone square as currently drawn (smoothed between server updates). */
  private zoneShown: { x: number; y: number; size: number } | null = null;

  /** Our own predicted position (moves instantly, corrected by the server). */
  private me = { x: 0, y: 0 };
  private diedAt = 0;
  private killedBy = "";
  private killedById = "";
  /** sessionId we're watching after being eliminated ("" = ourselves). */
  private spectating = "";
  private cameraTarget = "";
  private scoreboardTimer = 0;

  constructor() {
    super("game");
  }

  init(data: GameSceneData) {
    this.room = data.room;
    this.hud = data.hud;
    this.onRoomName = data.onRoomName;
    this.onMuteToggle = data.onMuteToggle;
    this.touch = data.touch;
    this.onReady = data.onReady;
    this.ready = false;
    this.onPlayerCount = data.onPlayerCount;
    this.wasReloading = false;
    this.lastHeld = "";
    this.lastBeep = -1;
    this.lastPhase = "";
    this.views.clear();
    this.map = undefined;
    this.mapObjects = [];
    this.killedBy = "";
    this.killedById = "";
    this.spectating = "";
    this.cameraTarget = "";
    this.bullets.clear();
    this.items.clear();
    this.lastSentKeys = "";
  }

  create() {
    // The map is drawn when its seed arrives from the server (see listenToRoom).

    const cam = this.cameras.main;
    cam.setBackgroundColor("#0b0d12");
    cam.setBounds(-60, -60, ARENA_SIZE + 120, ARENA_SIZE + 120);
    cam.setZoom(this.baseZoom());

    // Controls: WASD / arrows move, mouse aims, left click attacks, R reloads,
    // 1/2/3 or the wheel switch weapons, G drops, E picks up / swaps.
    const kb = this.input.keyboard!;
    const k = Phaser.Input.Keyboard.KeyCodes;
    this.keys = {
      up: [kb.addKey(k.UP), kb.addKey(k.W)],
      down: [kb.addKey(k.DOWN), kb.addKey(k.S)],
      left: [kb.addKey(k.LEFT), kb.addKey(k.A)],
      right: [kb.addKey(k.RIGHT), kb.addKey(k.D)],
    };
    kb.on("keydown-R", () => this.room.send("reload"));
    // Touch buttons and tappable weapon slots
    if (this.touch) {
      this.touch.onAction = (a) => {
        if (a === "reload") this.room.send("reload");
        else if (a === "pickup") this.room.send("pickup");
        else if (a === "drop") this.room.send("drop");
        else this.cycleSlot(1);
      };
    }
    this.hud.onSlotTap = (i) => this.selectSlot(i);
    kb.on("keydown-G", () => this.room.send("drop"));
    kb.on("keydown-E", () => this.room.send("pickup"));
    kb.on("keydown-ONE", () => this.selectSlot(0));
    kb.on("keydown-TWO", () => this.selectSlot(1));
    kb.on("keydown-THREE", () => this.selectSlot(2));
    this.input.on("wheel", (_p: unknown, _o: unknown, _dx: number, dy: number) => this.cycleSlot(dy > 0 ? 1 : -1));
    kb.on("keydown-M", () => this.onMuteToggle?.(sfx.toggleMute()));
    // Spectator controls (only do anything while you're out of the match)
    kb.on("keydown-SPACE", () => this.cycleSpectate(1));
    kb.on("keydown-RIGHT", () => this.cycleSpectate(1));
    kb.on("keydown-LEFT", () => this.cycleSpectate(-1));
    this.input.on("pointerdown", () => this.cycleSpectate(1));
    this.input.mouse?.disableContextMenu();
    this.input.setDefaultCursor("none");
    // Drawn in world space (at the mouse's world position) so camera zoom can't shift it off the cursor.
    this.crosshair = this.add.graphics().setDepth(1000);
    this.blood = new Blood(this);
    this.zoneGfx = this.add.graphics().setDepth(35); // above tree canopies, below the crosshair
    this.zoneShown = null;
    this.itemLabel = this.add
      .text(0, 0, "", {
        fontFamily: "system-ui, sans-serif",
        fontSize: "12px",
        fontStyle: "bold",
        color: "#ffffff",
        stroke: "#0b0d12",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(40)
      .setVisible(false);

    this.hud.show();
    this.listenToRoom();
  }

  // ---------- Server state & events ----------

  private listenToRoom() {
    const $ = Callbacks.get(this.room);
    $.listen("roomName", (name: string) => this.onRoomName?.(name));
    // A new random map every match: rebuild it from the server's seed.
    $.listen("mapSeed", (seed: number) => this.loadMap(seed));

    $.onAdd("players", (player, key) => {
      this.addPlayer(key as string, player as unknown as PlayerData);
      this.onPlayerCount?.(this.views.size);
    });
    $.onRemove("players", (_player, key) => {
      this.views.get(key as string)?.soldier.root.destroy();
      this.views.delete(key as string);
      this.onPlayerCount?.(this.views.size);
    });

    $.onAdd("items", (item, key) => this.addItem(key as string, item as unknown as ItemData));
    $.onRemove("items", (_item, key) => this.removeItem(key as string));

    this.room.onMessage("shot", (shot: ShotEvent) => this.spawnBullet(shot));
    this.room.onMessage("bulletEnd", (end: BulletEndEvent) => this.endBullet(end));
    this.room.onMessage("swing", (ev: SwingEvent) => this.swingEffect(ev));
    this.room.onMessage("kill", (kill: KillEvent) => {
      const killer = kill.killer === "" ? "Zone" : (this.views.get(kill.killer)?.data.name ?? "Someone");
      const victim = this.views.get(kill.victim)?.data.name ?? "Someone";
      const weapon = kill.weapon === "zone" ? "" : WEAPONS[kill.weapon as WeaponId]?.name ?? "";
      this.hud.addKill(killer, victim, weapon);
      if (kill.victim === this.room.sessionId) {
        this.killedBy = killer;
        this.killedById = kill.killer;
      }
    });
  }

  // ---------- Frame update ----------

  update(time: number, delta: number) {
    // Safety net: build the map if its seed arrived before we started listening.
    const seed = Number(this.room.state.mapSeed ?? 0);
    if (seed && this.map?.seed !== seed) this.loadMap(seed);

    const mine = this.views.get(this.room.sessionId);
    this.readInput(time, mine);

    const smoothing = 1 - Math.pow(0.001, delta / 1000); // frame-rate independent lerp factor

    this.views.forEach((view, sessionId) => {
      const { soldier, data } = view;
      const isMe = sessionId === this.room.sessionId;
      const heldId = slotOf(data, data.active).weapon;

      // Respawned, or moved to a new spot at match start: jump straight there (no sliding across the map).
      const shown = isMe ? this.me : soldier.root;
      if ((data.alive && !view.wasAlive) || Math.hypot(data.x - shown.x, data.y - shown.y) > TELEPORT_PX) {
        soldier.root.setPosition(data.x, data.y);
        if (isMe) this.me = { x: data.x, y: data.y };
      }

      // Weapon in hand and vest
      setSoldierWeapon(soldier, heldId);
      setSoldierVest(soldier, data.armor > 0);

      // HP / armor changed: flash red and bleed when hurt, sparkle green when healed.
      if (data.hp !== view.lastHp || data.armor !== view.lastArmor) {
        if (data.hp < view.lastHp) {
          this.flashHit(soldier);
          // Bullet / blade hits already sprayed blood; this covers the zone.
          if (time - view.lastBulletHitAt > 300) this.blood.wound(soldier.root.x, soldier.root.y);
          if (isMe) {
            this.hud.hurtFlash();
            sfx.hurt();
          }
        } else if (data.hp > view.lastHp && data.alive && view.wasAlive) {
          this.healEffect(soldier.root.x, soldier.root.y);
        }
        drawHealthBar(soldier.hpBar, data.hp, data.armor);
        view.lastHp = data.hp;
        view.lastArmor = data.armor;
      }

      // Just died: leave a mark on the floor.
      if (!data.alive && view.wasAlive) {
        this.deathEffect(soldier.root.x, soldier.root.y, data.color);
        sfx.death(soldier.root.x, soldier.root.y);
        if (isMe) this.diedAt = time;
      }
      view.wasAlive = data.alive;
      soldier.root.setVisible(data.alive);

      // Badly hurt: leave a trail of blood drops (faster while moving).
      if (data.alive && data.hp <= LOW_HP) {
        view.dripInMs -= delta;
        if (view.dripInMs <= 0) {
          this.blood.drip(soldier.root.x, soldier.root.y);
          const moving = isMe ? isMoving(this.myInput) : Math.hypot(data.x - soldier.root.x, data.y - soldier.root.y) > 2;
          view.dripInMs = moving ? 140 + Math.random() * 120 : 600 + Math.random() * 400;
        }
      }

      if (isMe && data.alive) {
        // Our player: predict locally so movement and aim feel instant (heavy weapons are slower)...
        if (this.map) applyInput(this.me, this.myInput, delta, this.map, heldStats(heldId).moveMul);
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

    this.updateBullets(this.time.now);
    this.drawZone(smoothing);
    this.updateCamera(mine);
    this.updateItemLabel(mine);
    this.updateSounds(time, mine);
    this.updateHud(time, delta, mine);
  }

  // ---------- Weapons & slots ----------

  private selectSlot(i: number) {
    const mine = this.views.get(this.room.sessionId);
    if (!mine?.data.alive || this.isSpectator) return;
    this.room.send("slot", i);
  }

  /** Mouse wheel: next / previous slot. */
  private cycleSlot(dir: 1 | -1) {
    const mine = this.views.get(this.room.sessionId);
    if (!mine?.data.alive) return;
    this.selectSlot((mine.data.active + dir + SLOT_COUNT) % SLOT_COUNT);
  }

  // ---------- Sound ----------

  private updateSounds(time: number, mine?: PlayerView) {
    // Your ears are wherever the camera looks (you, or who you're spectating).
    const view = this.cameras.main.worldView;
    sfx.setListener(view.centerX, view.centerY);

    // Footsteps: one every stride walked, for everyone alive.
    this.views.forEach((v, id) => {
      const pos = id === this.room.sessionId ? this.me : v.soldier.root;
      const moved = Math.hypot(pos.x - v.stepX, pos.y - v.stepY);
      if (!v.data.alive || moved > TELEPORT_PX) {
        v.stepX = pos.x;
        v.stepY = pos.y;
      } else if (moved >= STRIDE_PX) {
        sfx.footstep(pos.x, pos.y, id === this.room.sessionId);
        v.stepX = pos.x;
        v.stepY = pos.y;
      }
    });

    if (mine) {
      const d = mine.data;
      const slot = slotOf(d, d.active);
      // Switched weapon
      if (d.alive && slot.weapon !== this.lastHeld) {
        if (this.lastHeld !== "" || slot.weapon !== "") sfx.equip(slot.weapon);
        this.lastHeld = slot.weapon;
      }
      // Reload: magazine out when it starts, in + charge when it finishes.
      if (d.reloading && !this.wasReloading) sfx.reloadStart();
      if (!d.reloading && this.wasReloading && d.alive && slot.ammo > 0) sfx.reloadEnd();
      this.wasReloading = d.reloading;
      // Holding the trigger on a gun with no ammo at all: click… click…
      const gun = gunStats(slot.weapon);
      if (d.alive && gun && this.myInput.fire && slot.ammo === 0 && slot.reserve === 0 && time >= this.nextDryFireAt) {
        sfx.dryFire();
        this.nextDryFireAt = time + 300;
      }
    }

    // Match: countdown beeps, start horn, and a jingle at the end.
    const st = this.room.state;
    const phase = this.phase;
    if (phase === "countdown" && st.phaseSecondsLeft !== this.lastBeep && st.phaseSecondsLeft > 0) {
      sfx.countdownBeep(false);
      this.lastBeep = st.phaseSecondsLeft;
    }
    if (phase !== this.lastPhase) {
      if (phase === "live" && this.lastPhase === "countdown") sfx.countdownBeep(true);
      if (phase === "ended") (st.winner === this.room.sessionId ? sfx.win() : sfx.lose());
      if (phase !== "countdown") this.lastBeep = -1;
      this.lastPhase = phase;
    }
  }

  /** Tell main.ts we're playable (map drawn + our soldier exists), once. */
  private tryReady() {
    if (this.ready || !this.map || !this.views.has(this.room.sessionId)) return;
    this.ready = true;
    this.onReady?.();
  }

  /**
   * Camera zoom for this screen: 1.4 on a normal monitor, zoomed out on small screens
   * (phones) so you still see about the same amount of the map.
   */
  private baseZoom(): number {
    if (ZOOM_PARAM) return ZOOM_PARAM;
    const shortSide = Math.min(this.scale.width, this.scale.height);
    return Phaser.Math.Clamp(shortSide / 600, 0.62, CAMERA_ZOOM);
  }

  // ---------- Map ----------

  /** Build (or replace) the map from a seed: same seed → same map as the server. */
  private loadMap(seed: number) {
    if (!seed || this.map?.seed === seed) return;
    for (const o of this.mapObjects) o.destroy();
    this.map = new GameMap(seed);
    this.mapObjects = renderMap(this, this.map, MAP_RESOLUTION);
    this.tryReady();
  }

  // ---------- Match ----------

  private get phase(): string {
    return String(this.room.state.matchPhase ?? "warmup");
  }

  /** Out of the current match (dead during "live"/"ended"): watching others. */
  private get isSpectator(): boolean {
    const mine = this.views.get(this.room.sessionId);
    return !!mine && !mine.data.alive && (this.phase === "live" || this.phase === "ended");
  }

  /** Alive players, in a stable order, for cycling through while spectating. */
  private alivePlayers(): string[] {
    return [...this.views].filter(([, v]) => v.data.alive).map(([id]) => id).sort();
  }

  /** Spectator: switch to the next (+1) or previous (-1) player still alive. */
  private cycleSpectate(dir: 1 | -1) {
    if (!this.isSpectator) return;
    const alive = this.alivePlayers();
    if (alive.length === 0) return;
    const i = alive.indexOf(this.spectating);
    this.spectating = alive[(i + dir + alive.length) % alive.length];
  }

  /** Who the camera follows (you, or someone still alive), and how far it zooms. */
  private updateCamera(mine?: PlayerView) {
    let target = this.room.sessionId;
    if (this.isSpectator) {
      if (!this.views.get(this.spectating)?.data.alive) {
        // Start with whoever eliminated us, else the next player alive.
        this.spectating = this.views.get(this.killedById)?.data.alive ? this.killedById : (this.alivePlayers()[0] ?? "");
      }
      if (this.spectating) target = this.spectating;
    } else {
      this.spectating = "";
    }
    if (!mine && !this.views.has(target)) return;
    if (target !== this.cameraTarget) {
      const view = this.views.get(target);
      if (view) this.cameras.main.startFollow(view.soldier.root, true, 0.12, 0.12);
      this.cameraTarget = target;
    }

    // Sniper in hand: zoom out to see as far as it shoots.
    const watched = this.views.get(target)?.data;
    const sniper = !!watched?.alive && slotOf(watched, watched.active).weapon === "sniper";
    const cam = this.cameras.main;
    const base = this.baseZoom();
    const want = sniper ? Math.min(base, SNIPER_ZOOM) * (base < CAMERA_ZOOM ? 0.85 : 1) : base;
    if (Math.abs(cam.zoom - want) > 0.001) cam.setZoom(cam.zoom + (want - cam.zoom) * 0.12);
  }

  // ---------- Safe zone ----------

  private get zone(): ZoneData {
    return this.room.state.zone as ZoneData;
  }

  private drawZone(smoothing: number) {
    const z = this.zone;
    const g = this.zoneGfx;
    g.clear();
    if (!z?.size) return; // state not received yet

    // Glide toward the server's square (it updates ~20×/s while shrinking).
    if (!this.zoneShown) this.zoneShown = { x: z.x, y: z.y, size: z.size };
    const s = this.zoneShown;
    const k = Math.min(1, smoothing * 2);
    s.x += (z.x - s.x) * k;
    s.y += (z.y - s.y) * k;
    s.size += (z.size - s.size) * k;

    // Where it will shrink to next (thin white outline), shown as soon as it's announced.
    if (z.phase === "hold" || z.phase === "shrink") {
      g.lineStyle(2, 0xffffff, 0.7);
      g.strokeRect(z.nextX, z.nextY, z.nextSize, z.nextSize);
    }

    // Still the whole map: no danger area to draw yet.
    if (s.size >= ARENA_SIZE - 0.5) return;

    // Red tint over everything outside the square (4 rectangles around it).
    const pad = 400;
    const min = -pad;
    const max = ARENA_SIZE + pad;
    const right = s.x + s.size;
    const bottom = s.y + s.size;
    g.fillStyle(0xd01818, 0.28);
    g.fillRect(min, min, max - min, s.y - min); // above
    g.fillRect(min, bottom, max - min, max - bottom); // below
    g.fillRect(min, s.y, s.x - min, s.size); // left
    g.fillRect(right, s.y, max - right, s.size); // right

    // The zone edge: a bold red border
    g.lineStyle(6, 0xff2a2a, 0.95);
    g.strokeRect(s.x, s.y, s.size, s.size);
    g.lineStyle(2, 0xffb3b3, 0.9);
    g.strokeRect(s.x + 3, s.y + 3, s.size - 6, s.size - 6);
  }

  /** The line at the top of the screen: match state, clock, zone, players alive. */
  private zoneText(): { text: string; urgent: boolean } {
    const st = this.room.state;
    switch (this.phase) {
      case "warmup": {
        const max = Number(st.maxPlayers) || MATCH_MIN_PLAYERS;
        const count = `Waiting for players… (${this.views.size}/${max})`;
        if (this.views.size < MATCH_MIN_PLAYERS) return { text: `${count} · warm up!`, urgent: false };
        return { text: `${count} · match starts when full or in ${formatTime(Number(st.phaseSecondsLeft ?? 0))}`, urgent: false };
      }
      case "countdown":
        return { text: `Match starts in ${st.phaseSecondsLeft}…`, urgent: true };
      case "ended":
        return { text: `Match over · next match in ${st.phaseSecondsLeft}s`, urgent: false };
    }

    const z = this.zone;
    const clock = formatTime(Number(st.matchSeconds ?? 0));
    const alive = `👥 ${st.aliveCount} alive`;
    const left = formatTime(z?.secondsLeft ?? 0);
    switch (z?.phase) {
      case "waiting":
      case "hold":
        return { text: `⏱ ${clock}  ·  ${alive}  ·  Zone shrinks in ${left}`, urgent: z.secondsLeft <= 10 };
      case "shrink":
        return { text: `⏱ ${clock}  ·  ${alive}  ·  Zone shrinking! ${left}`, urgent: true };
      default:
        return { text: `⏱ ${clock}  ·  ${alive}  ·  Final zone`, urgent: false };
    }
  }

  private readInput(time: number, mine?: PlayerView) {
    const held = (list: Phaser.Input.Keyboard.Key[]) => list.some((key) => key.isDown);
    const pointer = this.input.activePointer;

    const world = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    let angle = this.myInput.angle;
    const touch = this.touch && isTouchMode();

    if (touch) {
      // Phone / tablet: left stick moves, right stick aims (push it to shoot).
      const k = this.touch!.keys;
      angle = this.touch!.aimAngle ?? angle;
      this.myInput = { ...k, fire: this.touch!.firing, angle };
    } else {
      // Keyboard + mouse: aim from our soldier to the mouse, in world coordinates.
      if (mine) angle = Math.atan2(world.y - this.me.y, world.x - this.me.x);
      this.myInput = {
        up: held(this.keys.up),
        down: held(this.keys.down),
        left: held(this.keys.left),
        right: held(this.keys.right),
        fire: pointer.leftButtonDown(),
        angle,
      };
    }

    // Send immediately when keys/fire change; send aim-only changes at most every 50ms.
    const keys = `${+this.myInput.up}${+this.myInput.down}${+this.myInput.left}${+this.myInput.right}${+this.myInput.fire}`;
    const aimChanged = Math.abs(angleDelta(this.lastSentAngle, angle)) > 0.01;
    if (keys !== this.lastSentKeys || (aimChanged && time - this.lastSentAt >= ANGLE_SEND_INTERVAL_MS)) {
      this.room.send("input", { ...this.myInput, angle: Math.round(angle * 1000) / 1000 });
      this.lastSentKeys = keys;
      this.lastSentAngle = angle;
      this.lastSentAt = time;
    }

    if (mine?.data.alive && !touch) this.drawCrosshair(world.x, world.y, mine.data.reloading);
    else this.crosshair.clear(); // no crosshair while dead / spectating / on touch screens

    // Sticks only while you're alive (when dead, a tap switches who you're watching).
    this.touch?.setShown(!!mine?.data.alive);
  }

  private updateHud(time: number, delta: number, mine?: PlayerView) {
    // Match clock, zone countdown, and the "you're outside" warning.
    const info = this.zoneText();
    this.hud.setZoneInfo(info.text, info.urgent);
    const z = this.zone;
    const s = this.zoneShown;
    const outside =
      !!mine?.data.alive &&
      !!s &&
      (this.me.x < s.x || this.me.y < s.y || this.me.x > s.x + s.size || this.me.y > s.y + s.size);
    this.hud.setOutsideZone(outside);

    // Minimap: your own dot (hidden while dead) and the danger zone.
    const alive = mine?.data.alive ?? false;
    const shrinking = z?.phase === "hold" || z?.phase === "shrink";
    this.hud.minimap.update(
      alive ? { x: this.me.x, y: this.me.y, angle: this.myInput.angle, color: mine!.data.color } : null,
      s ? { ...s, next: shrinking ? { x: z.nextX, y: z.nextY, size: z.nextSize } : undefined } : null,
      time,
    );

    if (mine) {
      const d = mine.data;
      this.hud.setHealth(d.hp, d.armor);
      this.hud.setLowHealth(d.alive && d.hp <= LOW_HP);

      // Weapon in hand + the three slots
      const held = slotOf(d, d.active);
      const gun = gunStats(held.weapon);
      this.hud.setWeapon(heldStats(held.weapon).name, gun ? { ammo: held.ammo, reserve: held.reserve, mag: gun.mag } : null, d.reloading);
      const slots: SlotInfo[] = [];
      for (let i = 0; i < SLOT_COUNT; i++) {
        const sl = slotOf(d, i);
        slots.push({ name: sl.weapon ? heldStats(sl.weapon).name : "", ammo: gunStats(sl.weapon) ? `${sl.ammo}/${sl.reserve}` : "", active: i === d.active });
      }
      this.hud.setSlots(d.alive ? slots : null);
      const prompt = d.alive ? this.pickupPrompt(d) : "";
      this.hud.setPrompt(isTouchMode() ? prompt.replace(/^E:/, "✋") : prompt);
      this.touch?.setPickupHint(!!prompt);

      const by = this.killedBy ? `Eliminated by ${this.killedBy}` : "Eliminated";
      if (d.alive || this.phase === "ended") {
        this.hud.setDead(false);
      } else if (this.phase === "live") {
        // Out of the match: show the placement and who we're watching.
        const watching = this.views.get(this.spectating)?.data.name;
        const n = this.alivePlayers().length;
        this.hud.setDead(
          true,
          `${by} · you placed #${d.place}`,
          watching
            ? `👁 Spectating ${watching}${n > 1 ? (isTouchMode() ? "  ·  tap the screen to switch" : "  ·  click / Space / ← → to switch") : ""}`
            : "",
        );
      } else {
        const secs = Math.max(1, Math.ceil((RESPAWN_MS - (time - this.diedAt)) / 1000));
        this.hud.setDead(true, `${by} · respawning in ${secs}…`);
      }
    }

    // Winner banner
    if (this.phase === "ended") {
      const st = this.room.state;
      const winner = this.views.get(String(st.winner));
      const next = `Next match in ${st.phaseSecondsLeft}s`;
      if (st.winner === this.room.sessionId) this.hud.setBanner("🏆 You win!", `Last soldier standing · ${next}`, true);
      else if (winner) this.hud.setBanner(`🏆 ${winner.data.name} wins!`, `You placed #${mine?.data.place || "?"} · ${next}`, false);
      else this.hud.setBanner("No survivors", next, false);
    } else {
      this.hud.setBanner(null);
    }

    this.scoreboardTimer -= delta;
    if (this.scoreboardTimer <= 0) {
      this.scoreboardTimer = 250;
      const inMatch = this.phase === "live" || this.phase === "ended";
      const rows = [...this.views].map(([id, v]) => ({
        name: v.data.name,
        kills: v.data.kills,
        deaths: v.data.deaths,
        isMe: id === this.room.sessionId,
        out: inMatch && !v.data.alive,
      }));
      this.hud.setScoreboard(rows);
    }
  }

  /** "E: swap …" hint when standing on something that needs E. */
  private pickupPrompt(d: PlayerData): string {
    const near = this.nearestItem(this.me.x, this.me.y, ITEM_REACH);
    if (!near) return "";
    const it = near.data;
    if (it.kind === "vest" && it.armor <= d.armor) return `E: swap your vest (${d.armor}) for this one (${it.armor})`;
    if (it.kind !== "weapon") return "";
    const owned = [0, 1, 2].some((i) => slotOf(d, i).weapon === it.weapon);
    if (owned) return "";
    const full = [0, 1, 2].every((i) => slotOf(d, i).weapon);
    const name = heldStats(it.weapon).name;
    if (full) return `E: swap your ${heldStats(slotOf(d, d.active).weapon).name} for the ${name}`;
    return `E: pick up ${name}`;
  }

  // ---------- Players ----------

  private addPlayer(sessionId: string, data: PlayerData) {
    const isMe = sessionId === this.room.sessionId;
    const soldier = createSoldier(this, data.x, data.y, data.color, isMe ? `${data.name} (you)` : data.name, isMe);
    soldier.body.rotation = data.angle;
    drawHealthBar(soldier.hpBar, data.hp, data.armor);
    this.views.set(sessionId, {
      soldier,
      data,
      lastHp: data.hp,
      lastArmor: data.armor,
      wasAlive: data.alive,
      lastBulletHitAt: 0,
      dripInMs: 0,
      stepX: data.x,
      stepY: data.y,
    });

    if (isMe) {
      this.me = { x: data.x, y: data.y };
      this.cameras.main.startFollow(soldier.root, true, 0.12, 0.12);
      this.tryReady();
    }
  }

  private flashHit(soldier: SoldierView) {
    this.tweens.killTweensOf(soldier.hitFlash);
    soldier.hitFlash.setAlpha(0.65);
    this.tweens.add({ targets: soldier.hitFlash, alpha: 0, duration: 180 });
  }

  private deathEffect(x: number, y: number, color: number) {
    this.blood.pool(x, y);
    const ring = this.add.circle(x, y, 10, color, 0).setStrokeStyle(3, color, 0.9).setDepth(30);
    this.tweens.add({ targets: ring, scale: 4, alpha: 0, duration: 400, onComplete: () => ring.destroy() });
  }

  /** Green "+" sparkles when someone heals. */
  private healEffect(x: number, y: number) {
    for (let i = 0; i < 6; i++) {
      const p = this.add
        .text(x + (Math.random() - 0.5) * 30, y + (Math.random() - 0.5) * 20, "+", {
          fontFamily: "system-ui, sans-serif",
          fontSize: "16px",
          fontStyle: "bold",
          color: "#6fdc6f",
          stroke: "#0b2a0b",
          strokeThickness: 3,
        })
        .setOrigin(0.5)
        .setDepth(32);
      this.tweens.add({ targets: p, y: p.y - 30, alpha: 0, delay: i * 40, duration: 600, onComplete: () => p.destroy() });
    }
  }

  // ---------- Bullets ----------

  private spawnBullet(shot: ShotEvent) {
    const gun = gunStats(shot.weapon) ?? gunStats("rifle")!;
    const vx = Math.cos(shot.angle) * gun.bulletSpeed;
    const vy = Math.sin(shot.angle) * gun.bulletSpeed;

    // Tracer: long and white for the sniper, thin for the machine gun
    const look =
      shot.weapon === "sniper" ? { len: 34, w: 3, c: 0xffffff } : shot.weapon === "mg" ? { len: 14, w: 2, c: 0xffd27a } : { len: 16, w: 3, c: 0xffe08a };
    // The server fired from where IT thinks the shooter is, but on screen we draw ourselves
    // ahead (prediction) and others behind (smoothing). Start the tracer and flash at the gun
    // tip as drawn, then let the tracer slide onto the real path (hits are still server-side).
    const shooter = this.views.get(shot.owner);
    let startX = shot.x;
    let startY = shot.y;
    if (shooter?.soldier.root.visible) {
      const s = shooter.soldier;
      const tip = muzzlePosition({ x: s.root.x + s.body.x, y: s.root.y + s.body.y }, s.body.rotation, gun.muzzle);
      if (Math.hypot(tip.x - shot.x, tip.y - shot.y) <= TRACER_MAX_OFFSET_PX) {
        startX = tip.x;
        startY = tip.y;
      }
    }

    const sprite = this.add.rectangle(startX, startY, look.len, look.w, look.c).setRotation(shot.angle).setDepth(15);
    this.bullets.set(shot.id, {
      sprite,
      x0: shot.x,
      y0: shot.y,
      vx,
      vy,
      offX: startX - shot.x,
      offY: startY - shot.y,
      bornAt: this.time.now,
      lifeMs: gun.bulletLifeMs,
      owner: shot.owner,
    });
    sfx.gunshot(startX, startY, shot.owner === this.room.sessionId, shot.weapon);

    // Muzzle flash (bigger for the sniper)
    const flash = this.add.circle(startX, startY, shot.weapon === "sniper" ? 12 : shot.weapon === "pistol" ? 5 : 7, 0xfff1b0, 1).setDepth(25);
    this.tweens.add({ targets: flash, scale: 0.2, alpha: 0, duration: 70, onComplete: () => flash.destroy() });

    // Recoil kick on the shooter
    if (shooter) {
      const kick = shot.weapon === "sniper" ? 5 : 2;
      const body = shooter.soldier.body;
      this.tweens.killTweensOf(body);
      body.setPosition(0, 0);
      this.tweens.add({
        targets: body,
        x: -Math.cos(shot.angle) * kick,
        y: -Math.sin(shot.angle) * kick,
        duration: shot.weapon === "sniper" ? 80 : 40,
        yoyo: true,
      });
    }
  }

  private updateBullets(time: number) {
    this.bullets.forEach((b, id) => {
      const age = time - b.bornAt;
      // Position on the server's path, plus the on-screen gap fading to zero (ease-out).
      const t = Math.min(1, age / TRACER_BLEND_MS);
      const gap = (1 - t) * (1 - t);
      b.sprite.x = b.x0 + b.vx * (age / 1000) + b.offX * gap;
      b.sprite.y = b.y0 + b.vy * (age / 1000) + b.offY * gap;
      // Safety net in case the server's "bulletEnd" never arrives.
      if (time - b.bornAt > b.lifeMs + 500) {
        b.sprite.destroy();
        this.bullets.delete(id);
      }
    });
  }

  private endBullet(end: BulletEndEvent) {
    const b = this.bullets.get(end.id);
    const angle = b ? Math.atan2(b.vy, b.vx) : Math.random() * Math.PI * 2;
    if (b) {
      b.sprite.destroy();
      this.bullets.delete(end.id);
    }

    const victim = end.hit ? this.views.get(end.hit) : undefined;
    if (victim) {
      // Blood sprays out the way the bullet was going; a vest makes a metallic "tink" too.
      this.blood.bulletHit(end.x, end.y, angle);
      victim.lastBulletHitAt = this.time.now;
      sfx.fleshHit(end.x, end.y);
      if (end.armored) sfx.armorHit(end.x, end.y);
      if (b?.owner === this.room.sessionId) sfx.hitMarker();
    } else {
      this.impactEffect(end.x, end.y);
      // Only make a "ping" when it actually hit something (not when it just ran out of range).
      const blocked = this.map?.pointBlocked(end.x, end.y);
      const edge = end.x <= 1 || end.y <= 1 || end.x >= ARENA_SIZE - 1 || end.y >= ARENA_SIZE - 1;
      if (blocked || edge) sfx.impact(end.x, end.y);
    }
  }

  private impactEffect(x: number, y: number) {
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2;
      const dist = 8 + Math.random() * 10;
      const p = this.add.circle(x, y, 2, 0x9aa3b5, 1).setDepth(16);
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

  // ---------- Melee ----------

  /** Knife / sword / axe / fists: swing animation, whoosh, and blood on whoever got hit. */
  private swingEffect(ev: SwingEvent) {
    const attacker = this.views.get(ev.owner);
    const stats = WEAPONS[ev.weapon];
    if (attacker) {
      const arms = attacker.soldier.arms;
      const wide = stats?.kind === "melee" ? Math.min(1.1, stats.arc / 2) : 0.8;
      this.tweens.killTweensOf(arms);
      arms.setRotation(-wide);
      this.tweens.add({
        targets: arms,
        rotation: wide,
        duration: ev.weapon === "axe" ? 170 : ev.weapon === "sword" ? 150 : 90,
        ease: "Cubic.easeOut",
        onComplete: () => this.tweens.add({ targets: arms, rotation: 0, duration: 140 }),
      });
      sfx.swing(attacker.soldier.root.x, attacker.soldier.root.y, ev.weapon);
    }
    for (const id of ev.hits) {
      const victim = this.views.get(id);
      if (!victim) continue;
      const vx = victim.soldier.root.x;
      const vy = victim.soldier.root.y;
      this.blood.bulletHit(vx, vy, ev.angle);
      victim.lastBulletHitAt = this.time.now;
      sfx.meleeHit(vx, vy, ev.weapon);
      if (ev.owner === this.room.sessionId) sfx.hitMarker();
    }
  }

  // ---------- Items on the ground ----------

  private addItem(id: string, data: ItemData) {
    const glowColor = itemGlow(data.kind, data.weapon);
    const glow = this.add.circle(0, 0, 22, glowColor, 0.18).setStrokeStyle(1.5, glowColor, 0.6);
    const g = this.add.graphics();

    if (data.kind === "weapon") {
      // Draw the weapon centered, at a slight angle, like it was dropped.
      g.setRotation(-0.5);
      const shift = data.weapon === "sword" || data.weapon === "axe" ? -30 : data.weapon === "sniper" ? -22 : -18;
      drawWeaponShape(g, data.weapon as WeaponId, shift, -9);
    } else if (data.kind === "vest") {
      drawVestIcon(g);
    } else if (data.kind === "medkit") {
      g.fillStyle(0x000000, 0.3);
      g.fillRoundedRect(-10, -7, 24, 18, 4);
      g.fillStyle(0xf2f2f2, 1);
      g.fillRoundedRect(-12, -10, 24, 18, 4);
      g.lineStyle(1.5, 0xb8b8b8, 1);
      g.strokeRoundedRect(-12, -10, 24, 18, 4);
      g.fillStyle(0xd62828, 1);
      g.fillRect(-2.5, -7, 5, 12);
      g.fillRect(-6.5, -3, 13, 4);
    } else {
      // Ammo box
      g.fillStyle(0x000000, 0.3);
      g.fillRoundedRect(-11, -6, 26, 18, 3);
      g.fillStyle(0x4f5b2e, 1);
      g.fillRoundedRect(-13, -9, 26, 18, 3);
      g.lineStyle(2, 0x2f371b, 1);
      g.strokeRoundedRect(-13, -9, 26, 18, 3);
      g.lineBetween(-13, 0, 13, 0);
      for (let i = -1; i <= 1; i++) {
        g.fillStyle(0xd9a441, 1);
        g.fillRect(i * 6 - 1.5, -6, 3, 10);
        g.fillStyle(0xb0b6c0, 1);
        g.fillRect(i * 6 - 1.5, -8, 3, 3);
      }
    }

    const obj = this.add.container(data.x, data.y, [glow, g]).setDepth(5);
    this.tweens.add({ targets: glow, scale: 1.15, alpha: 0.6, duration: 800, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    this.items.set(id, { obj, data });
  }

  private removeItem(id: string) {
    const it = this.items.get(id);
    if (!it) return;
    // Picked up? Play the right sound for whoever is standing on it.
    const taker = [...this.views].find(
      ([, v]) => v.data.alive && Math.hypot(v.data.x - it.data.x, v.data.y - it.data.y) < ITEM_REACH + 20,
    );
    if (taker) sfx.pickup(it.data.x, it.data.y, taker[0] === this.room.sessionId, it.data.kind);
    it.obj.destroy();
    this.items.delete(id);
  }

  private nearestItem(x: number, y: number, range: number) {
    let best: { obj: Phaser.GameObjects.Container; data: ItemData } | null = null;
    let bestD = range;
    this.items.forEach((it) => {
      const d = Math.hypot(it.data.x - x, it.data.y - y);
      if (d <= bestD) {
        bestD = d;
        best = it;
      }
    });
    return best as { obj: Phaser.GameObjects.Container; data: ItemData } | null;
  }

  /** Name tag over the closest item, e.g. "Sniper · 5/10", "Vest · 50", "Medkit +40". */
  private updateItemLabel(mine?: PlayerView) {
    const near = mine?.data.alive ? this.nearestItem(this.me.x, this.me.y, ITEM_LABEL_RANGE) : null;
    if (!near) {
      this.itemLabel.setVisible(false);
      return;
    }
    const it = near.data;
    let text = "Ammo box";
    if (it.kind === "weapon") {
      const gun = gunStats(it.weapon);
      text = heldStats(it.weapon).name + (gun ? ` · ${it.ammo}/${it.reserve}` : "");
    } else if (it.kind === "vest") text = `Vest · ${it.armor}`;
    else if (it.kind === "medkit") text = `Medkit +${MEDKIT_HEAL}${mine!.data.hp >= PLAYER_MAX_HP ? " (full HP)" : ""}`;
    this.itemLabel.setText(text).setPosition(it.x, it.y - 22).setVisible(true);
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

/** 75 → "1:15" */
function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
