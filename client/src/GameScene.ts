import Phaser from "phaser";
import { Callbacks, type Room } from "@colyseus/sdk";
import { ARENA_SIZE, MATCH_MIN_PLAYERS, PICKUP_RADIUS, PLAYER_MAX_HP, PLAYER_RADIUS, RESPAWN_MS } from "../../shared/constants";
import { sfx } from "./sound";
import { angleDelta, applyInput, isMoving, muzzlePosition, NO_INPUT, type InputState } from "../../shared/movement";
import type { BulletEndEvent, CoreDestroyedEvent, ExplosionEvent, KillEvent, ShotEvent, SwingEvent } from "../../shared/messages";
import {
  CORE_MAX_HP,
  CORE_RADIUS,
  FOUNTAIN_RADIUS,
  isTeam,
  otherTeam,
  TEAM_COLOR,
  TEAM_CSS,
  TEAM_NAME,
  TEAM_RESPAWN_MS,
  TURRET_RANGE,
  type GameMode,
} from "../../shared/teams";
import {
  createSoldier,
  drawHealthBar,
  drawBootsIcon,
  drawVestIcon,
  drawWeaponShape,
  itemGlow,
  setSoldierVest,
  setSoldierWeapon,
  type SoldierView,
} from "./soldier";
import type { Hud, SlotInfo } from "./hud";
import type { MinimapExtras } from "./minimap";
import { renderMap, type RenderedMap } from "./mapRender";
import { bakeShape } from "./atlas";
import { cycleQuality, onQualityChange, particleCount, qualitySettings } from "./quality";
import { Blood } from "./blood";
import { GameMap } from "../../shared/map";
import { isTouchMode, type TouchControls } from "./touchControls";
import { BOOTS_SPEED_MUL, gunStats, heldStats, MEDKIT_HEAL, SLOT_COUNT, WEAPONS, type WeaponId } from "../../shared/weapons";

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
  /** Speed boots charge, 0-100 % (0 = none). */
  boots: number;
  alive: boolean;
  kills: number;
  deaths: number;
  place: number;
  /** Team mode: "blue" | "red". */
  team: string;
  /** Only watching. */
  spectator: boolean;
  active: number;
  reloading: boolean;
  slots: ArrayLike<SlotData> & { at?: (i: number) => SlotData | undefined };
}

interface ItemData {
  kind: string; // weapon | vest | ammo | medkit | boots
  weapon: string;
  ammo: number;
  reserve: number;
  armor: number;
  charge: number;
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

interface CoreData {
  team: string;
  x: number;
  y: number;
  hp: number;
}

/** A team base: the ground pad (fountain + turret range), the tower, its health bar and name. */
interface CoreView {
  data: CoreData;
  pad: Phaser.GameObjects.Graphics;
  tower: Phaser.GameObjects.Container;
  flash: Phaser.GameObjects.Arc;
  glow: Phaser.GameObjects.Arc;
  hpBar: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  lastHp: number;
  /** Hit sparks / sounds are throttled (a machine gun hits it 13×/s). */
  nextHitFxAt: number;
  /** When it last took damage ("Your base is under attack!"). */
  lastHitAt: number;
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
  /** Countdown to the next speed-boots trail puff. */
  trailInMs: number;
  /** Healing sparkles are throttled (the base fountain heals a little every update). */
  nextHealFxAt: number;
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
  weapon: string;
  /** Rockets: countdown to the next smoke puff. */
  smokeInMs: number;
}

/** How long a tracer takes to slide from the on-screen gun tip onto the server's bullet path. */
const TRACER_BLEND_MS = 120;
/** A bigger gap than this means the shooter view is stale (respawn, teleport): don't fake it. */
const TRACER_MAX_OFFSET_PX = 80;

export interface GameSceneData {
  room: Room;
  hud: Hud;
  /** People playing, and people watching. */
  onPlayerCount?: (players: number, spectators: number) => void;
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
/**
 * Other players glide toward their latest server position. Higher = snappier (less delay
 * behind the real position), lower = smoother. Per second: the remaining gap shrinks to this.
 */
const REMOTE_LAG_LEFT_PER_SEC = 0.00002;

/** Read slot i from the synced array (works with ArraySchema and plain arrays). */
function slotOf(d: PlayerData, i: number): SlotData {
  return (d.slots?.at ? d.slots.at(i) : d.slots?.[i]) ?? { weapon: "", ammo: 0, reserve: 0 };
}

export class GameScene extends Phaser.Scene {
  private room!: Room;
  private hud!: Hud;
  private onPlayerCount?: (players: number, spectators: number) => void;
  private onRoomName?: (name: string) => void;
  private onMuteToggle?: (muted: boolean) => void;
  private touch?: TouchControls;
  private onReady?: () => void;
  private ready = false;

  private views = new Map<string, PlayerView>();
  /** Team mode: the two bases. */
  private cores = new Map<string, CoreView>();
  private bullets = new Map<number, BulletView>();
  private items = new Map<string, { obj: Phaser.GameObjects.Container; data: ItemData; glow: Phaser.GameObjects.Image; phase: number }>();
  /** Thrown grenades (synced positions) and their blinking fuse light. */
  private grenades = new Map<string, { obj: Phaser.GameObjects.Container; light: Phaser.GameObjects.Arc; data: { x: number; y: number }; bornAt: number }>();
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
  private rendered: RenderedMap = { objects: [], textures: [] };
  /** Stops listening for quality changes when the scene goes away. */
  private offQuality?: () => void;
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
    this.cores.clear();
    this.map = undefined;
    this.rendered = { objects: [], textures: [] };
    this.killedBy = "";
    this.killedById = "";
    this.spectating = "";
    this.cameraTarget = "";
    this.bullets.clear();
    this.items.clear();
    this.grenades.clear();
    this.lastSentKeys = "";
  }

  create() {
    // The map is drawn when its seed arrives from the server (see listenToRoom).

    const cam = this.cameras.main;
    cam.setBackgroundColor("#0b0d12");
    cam.setBounds(-60, -60, ARENA_SIZE + 120, ARENA_SIZE + 120);
    cam.setZoom(this.baseZoom());

    // Controls: WASD / arrows move, mouse aims, left click attacks, R reloads,
    // 1-5 or the wheel switch weapons, G drops, E picks up / swaps.
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
    this.hud.onStartMatch = () => this.room.send("startMatch");
    this.hud.onSwitchTeam = () => {
      const team = this.views.get(this.room.sessionId)?.data.team;
      if (isTeam(team)) this.room.send("team", otherTeam(team));
    };
    this.hud.onToggleSpectate = () => {
      const me = this.views.get(this.room.sessionId)?.data;
      if (me) this.room.send("spectate", !me.spectator);
    };
    kb.on("keydown-G", () => this.room.send("drop"));
    kb.on("keydown-E", () => this.room.send("pickup"));
    (["ONE", "TWO", "THREE", "FOUR", "FIVE"] as const)
      .slice(0, SLOT_COUNT)
      .forEach((key, i) => kb.on(`keydown-${key}`, () => this.selectSlot(i)));
    this.input.on("wheel", (_p: unknown, _o: unknown, _dx: number, dy: number) => this.cycleSlot(dy > 0 ? 1 : -1));
    kb.on("keydown-M", () => this.onMuteToggle?.(sfx.toggleMute()));
    kb.on("keydown-Q", () => cycleQuality());
    // Graphics quality changed (Q or the toolbar button): re-bake the map at the new sharpness.
    this.offQuality = onQualityChange(() => {
      if (this.map) this.loadMap(this.map.seed, true);
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.offQuality?.());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.offQuality?.());
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

    $.onAdd("players", (player, key) => this.addPlayer(key as string, player as unknown as PlayerData));
    $.onRemove("players", (_player, key) => {
      this.views.get(key as string)?.soldier.root.destroy();
      this.views.delete(key as string);
    });

    // Team mode: the two bases.
    $.onAdd("cores", (core, key) => this.addCore(key as string, core as unknown as CoreData));
    $.onRemove("cores", (_core, key) => this.removeCore(key as string));
    this.room.onMessage("coreDestroyed", (ev: CoreDestroyedEvent) => this.coreDestroyedEffect(ev));

    $.onAdd("items", (item, key) => this.addItem(key as string, item as unknown as ItemData));
    $.onRemove("items", (_item, key) => this.removeItem(key as string));
    $.onAdd("grenades", (g, key) => this.addGrenade(key as string, g as unknown as { x: number; y: number; owner: string }));
    $.onRemove("grenades", (_g, key) => {
      this.grenades.get(key as string)?.obj.destroy();
      this.grenades.delete(key as string);
    });
    this.room.onMessage("explosion", (ev: ExplosionEvent) => this.explosionEffect(ev));

    this.room.onMessage("shot", (shot: ShotEvent) => this.spawnBullet(shot));
    this.room.onMessage("bulletEnd", (end: BulletEndEvent) => this.endBullet(end));
    this.room.onMessage("swing", (ev: SwingEvent) => this.swingEffect(ev));
    this.room.onMessage("kill", (kill: KillEvent) => {
      const baseTeam = kill.killer.startsWith("core:") ? kill.killer.slice(5) : "";
      const killer =
        kill.killer === ""
          ? "Zone"
          : isTeam(baseTeam)
            ? `${TEAM_NAME[baseTeam]} base`
            : (this.views.get(kill.killer)?.data.name ?? "Someone");
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
    if (seed && (this.map?.seed !== seed || this.map.mode !== this.mode)) this.loadMap(seed, this.map?.mode !== this.mode);

    const mine = this.views.get(this.room.sessionId);
    this.readInput(time, mine);

    const smoothing = 1 - Math.pow(0.001, delta / 1000); // frame-rate independent lerp factor
    const remoteSmoothing = 1 - Math.pow(REMOTE_LAG_LEFT_PER_SEC, delta / 1000);

    this.views.forEach((view, sessionId) => {
      // Switched team (new uniform color): redraw the soldier in the new color.
      if (view.data.color !== view.soldier.color) this.recolorSoldier(sessionId, view);
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
        } else if (data.hp > view.lastHp && data.alive && view.wasAlive && time >= view.nextHealFxAt) {
          this.healEffect(soldier.root.x, soldier.root.y);
          view.nextHealFxAt = time + 700;
        }
        drawHealthBar(soldier.hpBar, data.hp, data.armor);
        view.lastHp = data.hp;
        view.lastArmor = data.armor;
      }

      // Just died: leave a mark on the floor. (Going off to spectate isn't dying.)
      if (!data.alive && view.wasAlive && !data.spectator) {
        this.deathEffect(soldier.root.x, soldier.root.y, data.color);
        sfx.death(soldier.root.x, soldier.root.y);
        if (isMe) this.diedAt = time;
      }
      view.wasAlive = data.alive;
      soldier.root.setVisible(data.alive);

      // Speed boots: little teal puffs behind you while running.
      if (data.alive && data.boots > 0) {
        view.trailInMs -= delta;
        const moving = isMe ? isMoving(this.myInput) : Math.hypot(data.x - soldier.root.x, data.y - soldier.root.y) > 2;
        if (moving && view.trailInMs <= 0) {
          view.trailInMs = 70 / qualitySettings().particles;
          this.speedPuff(soldier.root.x, soldier.root.y);
        }
      }

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
        const speedMul = heldStats(heldId).moveMul * (data.boots > 0 ? BOOTS_SPEED_MUL : 1);
        if (this.map) applyInput(this.me, this.myInput, delta, this.map, speedMul);
        // ...then drift toward the server's position (gentle while moving, firm when stopped).
        const dist = Phaser.Math.Distance.Between(this.me.x, this.me.y, data.x, data.y);
        const pull = !isMoving(this.myInput) ? smoothing * 0.5 : dist > 120 ? 0.3 : 0;
        this.me.x += (data.x - this.me.x) * pull;
        this.me.y += (data.y - this.me.y) * pull;
        soldier.root.setPosition(this.me.x, this.me.y);
        soldier.body.rotation = this.myInput.angle;
      } else {
        // Other players: interpolate position and aim toward the latest server values.
        soldier.root.x += (data.x - soldier.root.x) * remoteSmoothing;
        soldier.root.y += (data.y - soldier.root.y) * remoteSmoothing;
        soldier.body.rotation += angleDelta(soldier.body.rotation, data.angle) * Math.min(1, remoteSmoothing * 1.5);
      }
    });

    this.updateBullets(this.time.now, delta);
    this.updateCores(this.time.now);
    this.updateGrenades(smoothing);
    this.drawZone(smoothing);
    this.updateCamera(mine);
    this.updateItemLabel(mine);
    this.updateItems(this.time.now);
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
      // Reload: magazine out when it starts, in + charge when it finishes (not for grenades).
      const thrown = !!gunStats(slot.weapon)?.thrown;
      if (d.reloading && !this.wasReloading && !thrown) sfx.reloadStart();
      if (!d.reloading && this.wasReloading && d.alive && slot.ammo > 0 && !thrown) sfx.reloadEnd();
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
      if (phase === "ended") {
        const me = this.views.get(this.room.sessionId)?.data;
        const won = this.mode === "teams" ? !!this.myTeam && st.winnerTeam === this.myTeam : st.winner === this.room.sessionId;
        if (won) sfx.win();
        else if (me && !me.spectator) sfx.lose();
      }
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
  /** Build (or with `force`, rebuild at the current quality) the map for this seed. */
  private loadMap(seed: number, force = false) {
    if (!seed || (this.map?.seed === seed && !force)) return;
    for (const o of this.rendered.objects) o.destroy();
    for (const key of this.rendered.textures) if (this.textures.exists(key)) this.textures.remove(key);
    // Team mode maps have open ground and a core at each base (same as the server's).
    if (this.map?.seed !== seed || this.map.mode !== this.mode) this.map = new GameMap(seed, this.mode);
    this.rendered = renderMap(this, this.map!, qualitySettings().mapResolution);
    this.tryReady();
  }

  // ---------- Match ----------

  private get phase(): string {
    return String(this.room.state.matchPhase ?? "warmup");
  }

  /** The host can start the match before the room is full. */
  private get isHost(): boolean {
    return this.room.state.hostId === this.room.sessionId;
  }

  private get mode(): GameMode {
    return this.room.state.mode === "teams" ? "teams" : "solo";
  }

  /** My team ("" in solo mode or while spectating). */
  private get myTeam(): string {
    const me = this.views.get(this.room.sessionId)?.data;
    return me && !me.spectator ? me.team : "";
  }

  /**
   * Watching others: a spectator, or (solo) out of the current match. In a team match the
   * dead just wait to respawn at their base.
   */
  private get isSpectator(): boolean {
    const d = this.views.get(this.room.sessionId)?.data;
    if (!d) return false;
    if (d.spectator) return true;
    return this.mode === "solo" && !d.alive && (this.phase === "live" || this.phase === "ended");
  }

  /** Alive players, in a stable order, for cycling through while spectating. */
  private alivePlayers(): string[] {
    return [...this.views].filter(([, v]) => v.data.alive && !v.data.spectator).map(([id]) => id).sort();
  }

  /** How many are playing / watching. */
  private counts(): { players: number; spectators: number } {
    let spectators = 0;
    this.views.forEach((v) => {
      if (v.data.spectator) spectators++;
    });
    return { players: this.views.size - spectators, spectators };
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
    // A spectator with nobody to watch: look at the middle of the map.
    if (target === this.room.sessionId && mine?.data.spectator) {
      if (this.cameraTarget !== "center") {
        this.cameras.main.stopFollow();
        this.cameras.main.pan(ARENA_SIZE / 2, ARENA_SIZE / 2, 600, "Sine.easeInOut");
        this.cameraTarget = "center";
      }
      return;
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

  // ---------- Team bases ----------

  private addCore(team: string, data: CoreData) {
    const color = isTeam(team) ? TEAM_COLOR[team] : 0xffffff;
    // On the ground: the turret's reach (faint dashes), the fountain, and a paved pad.
    const pad = this.add.graphics().setDepth(1);
    pad.lineStyle(2, color, 0.22);
    const dashes = 48;
    for (let i = 0; i < dashes; i++) {
      const a0 = (i / dashes) * Math.PI * 2;
      pad.beginPath();
      pad.arc(data.x, data.y, TURRET_RANGE, a0, a0 + (Math.PI / dashes) * 1.1);
      pad.strokePath();
    }
    pad.fillStyle(color, 0.1);
    pad.fillCircle(data.x, data.y, FOUNTAIN_RADIUS);
    pad.lineStyle(3, color, 0.55);
    pad.strokeCircle(data.x, data.y, FOUNTAIN_RADIUS);
    pad.fillStyle(0x5b606b, 1);
    pad.fillCircle(data.x, data.y, CORE_RADIUS + 22);
    pad.lineStyle(3, 0x3a3e47, 1);
    pad.strokeCircle(data.x, data.y, CORE_RADIUS + 22);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      pad.lineStyle(2, 0x494d57, 1);
      pad.lineBetween(
        data.x + Math.cos(a) * (CORE_RADIUS + 4),
        data.y + Math.sin(a) * (CORE_RADIUS + 4),
        data.x + Math.cos(a) * (CORE_RADIUS + 22),
        data.y + Math.sin(a) * (CORE_RADIUS + 22),
      );
    }

    // The tower: a team-colored crystal in an armored ring, with a pulsing glow.
    const glow = this.add.circle(0, 0, CORE_RADIUS + 10, color, 0.25);
    const shadow = this.add.circle(5, 6, CORE_RADIUS, 0x000000, 0.35);
    const ring = this.add.circle(0, 0, CORE_RADIUS, 0x2a2e36, 1).setStrokeStyle(3, 0x15171c, 1);
    const pts: number[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      pts.push(Math.cos(a) * (CORE_RADIUS - 8), Math.sin(a) * (CORE_RADIUS - 8));
    }
    const crystal = this.add.polygon(0, 0, pts, color, 1).setStrokeStyle(2, 0xffffff, 0.6);
    const shine = this.add.circle(-6, -7, 7, 0xffffff, 0.45);
    const flash = this.add.circle(0, 0, CORE_RADIUS, 0xffffff, 1).setAlpha(0);
    const tower = this.add.container(data.x, data.y, [glow, shadow, ring, crystal, shine, flash]).setDepth(12);
    this.tweens.add({ targets: glow, scale: 1.25, alpha: 0.1, duration: 1100, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });

    const hpBar = this.add.graphics().setDepth(41);
    const name = isTeam(team) ? `${TEAM_NAME[team].toUpperCase()} BASE` : "BASE";
    const label = this.add
      .text(data.x, data.y - CORE_RADIUS - 34, name, {
        fontFamily: "system-ui, sans-serif",
        fontSize: "13px",
        fontStyle: "bold",
        color: isTeam(team) ? TEAM_CSS[team] : "#ffffff",
        stroke: "#0b0d12",
        strokeThickness: 4,
      })
      .setOrigin(0.5, 1)
      .setDepth(41);

    const view: CoreView = { data, pad, tower, flash, glow, hpBar, label, lastHp: -1, nextHitFxAt: 0, lastHitAt: -Infinity };
    this.cores.set(team, view);
    this.drawCoreHp(view);
  }

  private removeCore(team: string) {
    const c = this.cores.get(team);
    if (!c) return;
    c.pad.destroy();
    c.tower.destroy();
    c.hpBar.destroy();
    c.label.destroy();
    this.cores.delete(team);
  }

  private drawCoreHp(c: CoreView) {
    const g = c.hpBar;
    const w = 90;
    const x = c.data.x - w / 2;
    const y = c.data.y - CORE_RADIUS - 28;
    const pct = Math.max(0, c.data.hp / CORE_MAX_HP);
    g.clear();
    g.fillStyle(0x0b0d12, 0.85);
    g.fillRoundedRect(x - 2, y - 2, w + 4, 11, 3);
    g.fillStyle(isTeam(c.data.team) ? TEAM_COLOR[c.data.team] : 0xffffff, 1);
    if (pct > 0) g.fillRoundedRect(x, y, Math.max(2, w * pct), 7, 2);
    c.lastHp = c.data.hp;
  }

  /** Health bar, a flash and sparks when hit, a dead tower once destroyed. */
  private updateCores(time: number) {
    this.cores.forEach((c) => {
      if (c.data.hp === c.lastHp) return;
      const hurt = c.lastHp >= 0 && c.data.hp < c.lastHp;
      const healed = c.data.hp > c.lastHp; // new match: back to full
      this.drawCoreHp(c);
      c.tower.setAlpha(c.data.hp > 0 ? 1 : 0.35);
      c.glow.setVisible(c.data.hp > 0);
      if (healed) c.lastHitAt = -Infinity;
      if (!hurt) return;
      c.lastHitAt = time;
      if (time < c.nextHitFxAt) return;
      c.nextHitFxAt = time + 120;
      this.tweens.killTweensOf(c.flash);
      c.flash.setAlpha(0.6);
      this.tweens.add({ targets: c.flash, alpha: 0, duration: 160 });
      this.impactEffect(c.data.x + (Math.random() - 0.5) * CORE_RADIUS, c.data.y + (Math.random() - 0.5) * CORE_RADIUS);
      sfx.armorHit(c.data.x, c.data.y);
    });
  }

  /** A base going down: a huge blast and a long shake. */
  private coreDestroyedEffect(ev: CoreDestroyedEvent) {
    this.explosionEffect({ x: ev.x, y: ev.y, radius: 220, owner: "", weapon: "bazooka", hits: [] });
    this.time.delayedCall(180, () => this.explosionEffect({ x: ev.x + 30, y: ev.y - 20, radius: 160, owner: "", weapon: "bazooka", hits: [] }));
    this.cameras.main.shake(700, 0.012);
  }

  /** A player changed team: draw their soldier again in the new uniform color. */
  private recolorSoldier(sessionId: string, view: PlayerView) {
    const isMe = sessionId === this.room.sessionId;
    const old = view.soldier;
    const d = view.data;
    const s = createSoldier(this, old.root.x, old.root.y, d.color, isMe ? `${d.name} (you)` : d.name, isMe);
    s.body.rotation = old.body.rotation;
    s.root.setVisible(old.root.visible);
    drawHealthBar(s.hpBar, d.hp, d.armor);
    if (this.cameraTarget === sessionId) this.cameras.main.startFollow(s.root, true, 0.12, 0.12);
    old.root.destroy();
    view.soldier = s;
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
    const teams = this.mode === "teams";
    switch (this.phase) {
      case "warmup": {
        const { players } = this.counts();
        const count = `Waiting for players… (${players}/${Number(st.maxPlayers) || MATCH_MIN_PLAYERS})`;
        if (players < MATCH_MIN_PLAYERS) return { text: `${count} · warm up!`, urgent: false };
        if (teams && !this.bothTeamsHavePlayers()) return { text: `${count} · each team needs a player`, urgent: false };
        if (this.isHost) return { text: `${count} · starts when full, or start it now`, urgent: false };
        return { text: `${count} · starts when full or when the host starts it`, urgent: false };
      }
      case "countdown":
        return { text: `Match starts in ${st.phaseSecondsLeft}…`, urgent: true };
      case "ended":
        return { text: `Match over · next match in ${st.phaseSecondsLeft}s`, urgent: false };
    }

    const z = this.zone;
    const clock = formatTime(Number(st.matchSeconds ?? 0));
    if (teams) {
      // Your base under attack? Say so.
      const mine = this.cores.get(this.myTeam);
      if (mine && this.time.now - mine.lastHitAt < 2500) return { text: `⏱ ${clock}  ·  ⚠ Your base is under attack!`, urgent: true };
      return { text: `⏱ ${clock}  ·  Destroy the enemy base!`, urgent: false };
    }
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
    this.hud.setRoomActions(this.roomActions(mine));
    this.hud.setSpectatorView(!!mine?.data.spectator);
    this.onPlayerCountChanged();
    this.hud.setTeamScore(
      this.mode === "teams"
        ? {
            blueKills: Number(this.room.state.blueKills ?? 0),
            redKills: Number(this.room.state.redKills ?? 0),
            blueCore: this.cores.get("blue")?.data.hp ?? CORE_MAX_HP,
            redCore: this.cores.get("red")?.data.hp ?? CORE_MAX_HP,
            myTeam: this.myTeam,
          }
        : null,
    );
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
      this.minimapExtras(),
    );

    if (mine) {
      const d = mine.data;
      this.hud.setHealth(d.hp, d.armor);
      this.hud.setBoots(d.alive ? d.boots : 0);
      this.hud.setLowHealth(d.alive && d.hp <= LOW_HP);

      // Weapon in hand + the weapon slots
      const held = slotOf(d, d.active);
      const gun = gunStats(held.weapon);
      this.hud.setWeapon(
        heldStats(held.weapon).name,
        gun ? { ammo: held.ammo, reserve: held.reserve, mag: gun.mag, thrown: gun.thrown } : null,
        d.reloading,
      );
      const slots: SlotInfo[] = [];
      for (let i = 0; i < SLOT_COUNT; i++) {
        const sl = slotOf(d, i);
        const g = gunStats(sl.weapon);
        const ammo = !g ? "" : g.thrown ? `×${sl.ammo + sl.reserve}` : `${sl.ammo}/${sl.reserve}`;
        slots.push({ name: sl.weapon ? heldStats(sl.weapon).name : "", ammo, active: i === d.active });
      }
      this.hud.setSlots(d.alive ? slots : null);
      const prompt = d.alive ? this.pickupPrompt(d) : "";
      this.hud.setPrompt(isTouchMode() ? prompt.replace(/^E:/, "✋") : prompt);
      this.touch?.setPickupHint(!!prompt);

      const by = this.killedBy ? `Eliminated by ${this.killedBy}` : "Eliminated";
      const switchHint = isTouchMode() ? "tap the screen to switch" : "click / Space / ← → to switch";
      if (d.spectator) {
        // Just watching: who, and how to switch.
        const watching = this.views.get(this.spectating)?.data;
        const n = this.alivePlayers().length;
        const side = watching && isTeam(watching.team) ? ` (${TEAM_NAME[watching.team]})` : "";
        const who = watching ? `Watching ${watching.name}${side}` : "Nobody to watch yet";
        this.hud.setDead(this.phase !== "ended", who, n > 1 ? switchHint : "", "👁 Spectating");
      } else if (d.alive || this.phase === "ended") {
        this.hud.setDead(false);
      } else if (this.phase === "live" && this.mode === "teams") {
        const secs = Math.max(1, Math.ceil((TEAM_RESPAWN_MS - (time - this.diedAt)) / 1000));
        this.hud.setDead(true, `${by} · back at your base in ${secs}…`);
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
    if (this.phase === "ended" && this.mode === "teams") {
      const st = this.room.state;
      const next = `Next match in ${st.phaseSecondsLeft}s`;
      const win = String(st.winnerTeam);
      const score = `${st.blueKills ?? 0} – ${st.redKills ?? 0} kills`;
      if (!isTeam(win)) this.hud.setBanner("Draw", `Nobody left on either side · ${next}`, false);
      else if (!this.myTeam) this.hud.setBanner(`🏆 ${TEAM_NAME[win]} team wins!`, `${score} · ${next}`, true);
      else if (win === this.myTeam) this.hud.setBanner("🏆 Victory!", `The ${TEAM_NAME[otherTeam(win)]} base is destroyed · ${next}`, true);
      else this.hud.setBanner("Defeat", `Your base was destroyed · ${score} · ${next}`, false);
    } else if (this.phase === "ended") {
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
      const teams = this.mode === "teams";
      const rows = [...this.views].map(([id, v]) => ({
        name: id === this.room.state.hostId ? `👑 ${v.data.name}` : v.data.name,
        kills: v.data.kills,
        deaths: v.data.deaths,
        isMe: id === this.room.sessionId,
        // Out of a solo match for good. (In a team match the dead are just respawning.)
        out: !teams && inMatch && !v.data.alive && !v.data.spectator,
        team: teams && !v.data.spectator ? v.data.team : undefined,
        spectator: v.data.spectator,
      }));
      this.hud.setScoreboard(rows);
    }
  }

  /** Warmup buttons: start (host), switch team (team mode), and spectate / play. */
  private roomActions(mine?: PlayerView) {
    const d = mine?.data;
    const before = this.phase === "warmup" || this.phase === "countdown";
    const { players } = this.counts();
    const max = Number(this.room.state.maxPlayers) || 0;
    const canStart =
      this.isHost && this.phase === "warmup" && players >= MATCH_MIN_PLAYERS && (this.mode !== "teams" || this.bothTeamsHavePlayers());
    let team: string | null = null;
    if (d && !d.spectator && this.mode === "teams" && before && isTeam(d.team)) {
      const other = otherTeam(d.team);
      if (this.teamCount(other) < Math.ceil(max / 2)) team = `⇄ Join ${TEAM_NAME[other]}`;
    }
    let spectate: string | null = null;
    if (d?.spectator) spectate = before && players < max ? "🎮 Play" : null;
    else if (d && before) spectate = "👁 Spectate";
    return { start: canStart ? `▶ Start match now (${players} players)` : null, team, spectate };
  }

  private teamCount(team: string): number {
    let n = 0;
    this.views.forEach((v) => {
      if (!v.data.spectator && v.data.team === team) n++;
    });
    return n;
  }

  private bothTeamsHavePlayers(): boolean {
    return this.teamCount("blue") > 0 && this.teamCount("red") > 0;
  }

  /** Tell main.ts (room card) how many are playing / watching, when it changes. */
  private lastCounts = "";
  private onPlayerCountChanged() {
    const { players, spectators } = this.counts();
    const key = `${players}:${spectators}`;
    if (key === this.lastCounts) return;
    this.lastCounts = key;
    this.onPlayerCount?.(players, spectators);
  }

  /** Team mode: bases and your teammates. Spectators see everyone. */
  private minimapExtras(): MinimapExtras {
    const spectator = !!this.views.get(this.room.sessionId)?.data.spectator;
    if (this.mode !== "teams" && !spectator) return {};
    const others: { x: number; y: number; color: string }[] = [];
    this.views.forEach((v, id) => {
      if (id === this.room.sessionId || !v.data.alive || v.data.spectator) return;
      if (!spectator && v.data.team !== this.myTeam) return; // enemies stay hidden
      const color = isTeam(v.data.team) ? TEAM_CSS[v.data.team] : `#${v.data.color.toString(16).padStart(6, "0")}`;
      others.push({ x: v.soldier.root.x, y: v.soldier.root.y, color });
    });
    const bases = [...this.cores.values()].map((c) => ({
      x: c.data.x,
      y: c.data.y,
      color: isTeam(c.data.team) ? TEAM_CSS[c.data.team] : "#ffffff",
      hp: c.data.hp / CORE_MAX_HP,
    }));
    return { others, bases };
  }

  /** "E: swap …" hint when standing on something that needs E. */
  private pickupPrompt(d: PlayerData): string {
    const near = this.nearestItem(this.me.x, this.me.y, ITEM_REACH);
    if (!near) return "";
    const it = near.data;
    if (it.kind === "vest" && it.armor <= d.armor) return `E: swap your vest (${d.armor}) for this one (${it.armor})`;
    if (it.kind === "boots" && it.charge <= d.boots) return `E: swap your boots (${d.boots}%) for these (${it.charge}%)`;
    if (it.kind !== "weapon") return "";
    const indexes = Array.from({ length: SLOT_COUNT }, (_, i) => i);
    const owned = indexes.some((i) => slotOf(d, i).weapon === it.weapon);
    if (owned) return "";
    const full = indexes.every((i) => slotOf(d, i).weapon);
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
      trailInMs: 0,
      nextHealFxAt: 0,
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
    // A baked "+" image (a Text object would make and upload its own texture each time).
    const key = "heal-plus";
    bakeShape(this, key, 14, 14, 2, (g) => {
      g.fillStyle(0x0b2a0b, 1); // dark outline
      g.fillRect(-2.5, -6.5, 5, 13);
      g.fillRect(-6.5, -2.5, 13, 5);
      g.fillStyle(0x6fdc6f, 1);
      g.fillRect(-1.25, -5.25, 2.5, 10.5);
      g.fillRect(-5.25, -1.25, 10.5, 2.5);
    });
    const n = particleCount(6, 2);
    for (let i = 0; i < n; i++) {
      const p = this.add
        .image(x + (Math.random() - 0.5) * 30, y + (Math.random() - 0.5) * 20, key)
        .setScale(0.5)
        .setDepth(32);
      this.tweens.add({ targets: p, y: p.y - 30, alpha: 0, delay: i * 40, duration: 600, onComplete: () => p.destroy() });
    }
  }

  // ---------- Bullets ----------

  private spawnBullet(shot: ShotEvent) {
    const gun = gunStats(shot.weapon) ?? gunStats("rifle")!;
    const vx = Math.cos(shot.angle) * gun.bulletSpeed;
    const vy = Math.sin(shot.angle) * gun.bulletSpeed;

    // Tracer: long and white for the sniper, thin for the machine gun, a fat rocket for the bazooka
    // A base turret's bolt glows in its team's color.
    const turretTeam = shot.owner.startsWith("core:") ? shot.owner.slice(5) : "";
    const look =
      shot.weapon === "turret"
        ? { len: 24, w: 5, c: isTeam(turretTeam) ? TEAM_COLOR[turretTeam] : 0xffffff }
        : shot.weapon === "sniper"
          ? { len: 34, w: 3, c: 0xffffff }
          : shot.weapon === "mg"
            ? { len: 14, w: 2, c: 0xffd27a }
            : shot.weapon === "bazooka"
              ? { len: 18, w: 7, c: 0x55603a }
              : { len: 16, w: 3, c: 0xffe08a };
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
      weapon: shot.weapon,
      smokeInMs: 0,
    });
    sfx.gunshot(startX, startY, shot.owner === this.room.sessionId, shot.weapon);

    // Muzzle flash (bigger for the sniper)
    const flashSize = shot.weapon === "bazooka" ? 16 : shot.weapon === "sniper" ? 12 : shot.weapon === "pistol" ? 5 : 7;
    const flash = this.add.circle(startX, startY, flashSize, 0xfff1b0, 1).setDepth(25);
    this.tweens.add({ targets: flash, scale: 0.2, alpha: 0, duration: 70, onComplete: () => flash.destroy() });

    // Recoil kick on the shooter
    if (shooter) {
      const kick = shot.weapon === "bazooka" ? 7 : shot.weapon === "sniper" ? 5 : 2;
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

  private updateBullets(time: number, delta: number) {
    this.bullets.forEach((b, id) => {
      const age = time - b.bornAt;
      // Position on the server's path, plus the on-screen gap fading to zero (ease-out).
      const t = Math.min(1, age / TRACER_BLEND_MS);
      const gap = (1 - t) * (1 - t);
      b.sprite.x = b.x0 + b.vx * (age / 1000) + b.offX * gap;
      b.sprite.y = b.y0 + b.vy * (age / 1000) + b.offY * gap;
      // Rockets leave a smoke trail.
      if (b.weapon === "bazooka") {
        b.smokeInMs -= delta;
        if (b.smokeInMs <= 0) {
          b.smokeInMs = 28 / qualitySettings().particles;
          const puff = this.add.circle(b.sprite.x, b.sprite.y, 5 + Math.random() * 3, 0xb8bcc4, 0.5).setDepth(14);
          this.tweens.add({ targets: puff, scale: 2.2, alpha: 0, duration: 650, onComplete: () => puff.destroy() });
        }
      }
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
    if (b?.weapon === "bazooka") return; // the "explosion" message shows the blast

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
    const n = particleCount(5, 2);
    for (let i = 0; i < n; i++) {
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

  // ---------- Explosives ----------

  private addGrenade(id: string, data: { x: number; y: number; owner: string }) {
    const shadow = this.add.ellipse(1.5, 2.5, 11, 8, 0x000000, 0.35);
    const body = this.add.circle(0, 0, 5.5, 0x3f4a2a, 1).setStrokeStyle(1.2, 0x232a17, 1);
    const shine = this.add.circle(-1.5, -1.5, 1.8, 0x6b7a48, 1);
    const light = this.add.circle(0, -4.5, 1.8, 0xff3a2a, 1);
    const obj = this.add.container(data.x, data.y, [shadow, body, shine, light]).setDepth(14);
    this.grenades.set(id, { obj, light, data, bornAt: this.time.now });
    sfx.grenadeThrow(data.x, data.y);
    // The thrower's arm swings forward.
    const arms = this.views.get(data.owner)?.soldier.arms;
    if (arms) {
      this.tweens.killTweensOf(arms);
      arms.setRotation(0.9);
      this.tweens.add({ targets: arms, rotation: 0, duration: 180, ease: "Cubic.easeOut" });
    }
  }

  /** Follow the server's grenade positions; the fuse light blinks faster and faster. */
  private updateGrenades(smoothing: number) {
    const fuse = gunStats("grenade")!.bulletLifeMs;
    this.grenades.forEach((g) => {
      g.obj.x += (g.data.x - g.obj.x) * Math.min(1, smoothing * 2);
      g.obj.y += (g.data.y - g.obj.y) * Math.min(1, smoothing * 2);
      g.obj.rotation += (Math.hypot(g.data.x - g.obj.x, g.data.y - g.obj.y) > 0.5 ? 0.25 : 0);
      const left = Math.max(0, 1 - (this.time.now - g.bornAt) / fuse);
      const period = 80 + left * 320;
      g.light.setVisible(Math.floor((this.time.now - g.bornAt) / period) % 2 === 0);
    });
  }

  /** Flash, fireball, shock ring, smoke, debris, a scorch mark, a shake and a boom. */
  private explosionEffect(ev: ExplosionEvent) {
    const { x, y, radius } = ev;
    const flash = this.add.circle(x, y, radius * 0.5, 0xfff4c2, 0.95).setDepth(27);
    this.tweens.add({ targets: flash, scale: 1.7, alpha: 0, duration: 200, onComplete: () => flash.destroy() });
    const fire = this.add.circle(x, y, radius * 0.38, 0xff7a1a, 0.9).setDepth(26);
    this.tweens.add({ targets: fire, scale: 2.3, alpha: 0, duration: 420, ease: "Cubic.easeOut", onComplete: () => fire.destroy() });
    const ring = this.add.circle(x, y, radius * 0.3).setStrokeStyle(4, 0xffd27a, 0.9).setDepth(26);
    this.tweens.add({ targets: ring, scale: 1 / 0.3, alpha: 0, duration: 320, ease: "Cubic.easeOut", onComplete: () => ring.destroy() });
    for (let i = 0, n = particleCount(10, 3); i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = radius * (0.2 + Math.random() * 0.5);
      const smoke = this.add.circle(x, y, 10 + Math.random() * 10, Math.random() < 0.5 ? 0x5a5e66 : 0x8a8f99, 0.55).setDepth(25);
      this.tweens.add({
        targets: smoke,
        x: x + Math.cos(a) * d,
        y: y + Math.sin(a) * d,
        scale: 2,
        alpha: 0,
        duration: 900 + Math.random() * 700,
        ease: "Cubic.easeOut",
        onComplete: () => smoke.destroy(),
      });
    }
    for (let i = 0, n = particleCount(14, 4); i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = radius * (0.5 + Math.random() * 0.7);
      const bit = this.add.circle(x, y, 1.5 + Math.random() * 2, Math.random() < 0.5 ? 0x2b2b2b : 0xffb347, 1).setDepth(26);
      this.tweens.add({
        targets: bit,
        x: x + Math.cos(a) * d,
        y: y + Math.sin(a) * d,
        alpha: 0,
        duration: 350 + Math.random() * 250,
        ease: "Cubic.easeOut",
        onComplete: () => bit.destroy(),
      });
    }
    // Scorch mark on the ground, fading away slowly.
    const scorch = this.add.circle(x, y, radius * 0.45, 0x1a1a1a, 0.45).setDepth(2);
    this.tweens.add({ targets: scorch, alpha: 0, delay: 6000, duration: 4000, onComplete: () => scorch.destroy() });

    // Shake the screen the closer you are.
    const cam = this.cameras.main;
    const dist = Math.hypot(cam.worldView.centerX - x, cam.worldView.centerY - y);
    if (dist < 700) cam.shake(260, 0.014 * (1 - dist / 700));
    sfx.explosion(x, y);

    for (const id of ev.hits) {
      const v = this.views.get(id);
      if (!v) continue;
      this.blood.bulletHit(v.soldier.root.x, v.soldier.root.y, Math.atan2(v.soldier.root.y - y, v.soldier.root.x - x));
      v.lastBulletHitAt = this.time.now;
    }
    if (ev.owner === this.room.sessionId && ev.hits.some((id) => id !== ev.owner)) sfx.hitMarker();
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
    const glow = this.add.image(0, 0, glowTexture(this, glowColor)).setScale(1 / ITEM_RES);
    // The icon is a texture baked once per item type and shared (see itemTexture below).
    const icon = this.add.image(0, 0, itemTexture(this, data.kind, data.weapon)).setScale(1 / ITEM_RES);
    if (data.kind === "weapon") icon.setRotation(-0.5); // at a slight angle, like it was dropped

    const obj = this.add.container(data.x, data.y, [glow, icon]).setDepth(5);
    // The glow pulses (see updateItems); each item starts at its own point of the pulse.
    this.items.set(id, { obj, data, glow, phase: Math.random() * GLOW_PULSE_MS * 2 });
  }

  /**
   * Every frame: hide items that are off screen (nothing to draw), and pulse the glow of the
   * visible ones. Same look as a yoyo "Sine.easeInOut" tween (to 1.15× size, 0.6 alpha over
   * GLOW_PULSE_MS), without ~100 separate tweens running.
   */
  private updateItems(time: number) {
    const v = this.cameras.main.worldView;
    const m = 60; // an item's glow is ~25 px: keep a margin so nothing pops in at the edge
    this.items.forEach((it) => {
      const onScreen = it.data.x > v.x - m && it.data.x < v.right + m && it.data.y > v.y - m && it.data.y < v.bottom + m;
      it.obj.setVisible(onScreen);
      if (!onScreen) return;
      const k = (1 - Math.cos((Math.PI * (time + it.phase)) / GLOW_PULSE_MS)) / 2; // 0 → 1 → 0, eased
      it.glow.setScale((1 + 0.15 * k) / ITEM_RES).setAlpha(1 - 0.4 * k);
    });
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

  /** Speed boots trail: a small puff that fades where you just were. */
  private speedPuff(x: number, y: number) {
    const puff = this.add
      .circle(x + (Math.random() - 0.5) * 10, y + (Math.random() - 0.5) * 10, 7, 0x4fe0b6, 0.35)
      .setDepth(4);
    this.tweens.add({ targets: puff, scale: 0.2, alpha: 0, duration: 380, onComplete: () => puff.destroy() });
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
      if (gun?.thrown) text = `Grenades ×${it.ammo + it.reserve}`;
      else text = heldStats(it.weapon).name + (gun ? ` · ${it.ammo}/${it.reserve}` : "");
    } else if (it.kind === "vest") text = `Vest · ${it.armor}`;
    else if (it.kind === "boots") text = `Speed boots · ${it.charge}%`;
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

/** Item icons are baked at this many pixels per world pixel. */
const ITEM_RES = 2;
/** Half a glow pulse (grow), in ms; the other half shrinks back. */
const GLOW_PULSE_MS = 800;

/** The soft ring under an item (r 22, faint fill + brighter outline), baked once per color. */
function glowTexture(scene: Phaser.Scene, color: number): string {
  const key = `item-glow-${color.toString(16)}`;
  bakeShape(scene, key, 48, 48, ITEM_RES, (g) => {
    g.fillStyle(color, 0.18);
    g.fillCircle(0, 0, 22);
    g.lineStyle(1.5, color, 0.6);
    g.strokeCircle(0, 0, 22);
  });
  return key;
}

/**
 * Texture key for an item lying on the ground, baked on first use and shared by every item
 * of that kind (a live Graphics per item would be redrawn every frame: ~100 items on the map).
 * Each drawing is centered on (0, 0) inside its box.
 */
function itemTexture(scene: Phaser.Scene, kind: string, weapon: string): string {
  if (kind === "weapon") {
    const key = `item-weapon-${weapon}`;
    // Weapons are drawn shifted so their middle sits near (0, 0): x within ±42, y within ±17.
    const shift = weapon === "sword" || weapon === "axe" ? -30 : weapon === "bazooka" ? -20 : weapon === "sniper" ? -22 : -18;
    bakeShape(scene, key, 84, 34, ITEM_RES, (g) => drawWeaponShape(g, weapon as WeaponId, shift, -9));
    return key;
  }
  if (kind === "vest") {
    bakeShape(scene, "item-vest", 26, 32, ITEM_RES, drawVestIcon);
    return "item-vest";
  }
  if (kind === "boots") {
    bakeShape(scene, "item-boots", 38, 28, ITEM_RES, drawBootsIcon);
    return "item-boots";
  }
  if (kind === "medkit") {
    bakeShape(scene, "item-medkit", 30, 24, ITEM_RES, (g) => {
      g.fillStyle(0x000000, 0.3);
      g.fillRoundedRect(-10, -7, 24, 18, 4);
      g.fillStyle(0xf2f2f2, 1);
      g.fillRoundedRect(-12, -10, 24, 18, 4);
      g.lineStyle(1.5, 0xb8b8b8, 1);
      g.strokeRoundedRect(-12, -10, 24, 18, 4);
      g.fillStyle(0xd62828, 1);
      g.fillRect(-2.5, -7, 5, 12);
      g.fillRect(-6.5, -3, 13, 4);
    });
    return "item-medkit";
  }
  // Ammo box
  bakeShape(scene, "item-ammo", 32, 26, ITEM_RES, (g) => {
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
  });
  return "item-ammo";
}
