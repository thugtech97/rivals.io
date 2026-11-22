import type { ArenaState, Player, WeaponSlot } from "../schema/ArenaState";
import { ARENA_SIZE, PICKUP_RADIUS, PLAYER_MAX_HP, PLAYER_RADIUS } from "../../../shared/constants";
import type { GameMap } from "../../../shared/map";
import { angleDelta, type InputState } from "../../../shared/movement";
import type { BotLevel } from "../../../shared/practice";
import { BASE_CLEAR_RADIUS, BASES, CORE_RADIUS, FOUNTAIN_RADIUS, isTeam, otherTeam, type Team } from "../../../shared/teams";
import { gunStats, heldStats, SLOT_COUNT, WEAPONS, type GunStats, type WeaponId } from "../../../shared/weapons";
import type { NavGrid, Point } from "./navGrid";

// One bot's "brain". Every server tick it looks at the game state and produces the same
// input a person would send (held keys + aim + fire), plus the odd action (switch weapon,
// reload, pick up, drop). It never touches the game state directly: the room applies its
// input with the normal rules, so bots can't do anything a player can't.
//
// Each tick:   think (every ~100-200ms, depends on difficulty)    → pick a target / a goal
//              move  (every tick)                                  → follow the path, strafe, dodge
//              aim   (every tick, limited turn speed + aim error)  → fire when lined up

/** What a bot can see and do (implemented by the room). */
export interface BotWorld {
  readonly state: ArenaState;
  readonly map: GameMap;
  readonly nav: NavGrid;
  readonly teams: boolean;
  readonly now: number;
  isOutsideZone(x: number, y: number): boolean;
  selectSlot(id: string, index: number): void;
  reload(id: string): void;
  pickup(id: string): void;
  dropSlot(id: string, index: number): void;
}

interface Profile {
  /** How long after spotting someone before the first shot. */
  reactionMs: number;
  /** Aim wobble (radians, each way). */
  aimError: number;
  /** How fast the aim can turn (radians per second). */
  turnRate: number;
  /** How far away it notices enemies. */
  sight: number;
  /** Time between decisions. */
  thinkMs: number;
  /** Automatic guns: fire in bursts of this long, then pause this long (0 = hold the trigger). */
  burstOn: number;
  burstOff: number;
  /** Chance of strafing (side-stepping) during a fight. */
  strafe: number;
  /** Back off to heal below this HP (0 = never). */
  retreatHp: number;
  /** Aim ahead of moving targets (0 = no, 1 = fully). */
  lead: number;
  /** Picks the right weapon for the distance (otherwise only switches when out of ammo). */
  smartWeapons: boolean;
  /** Uses grenades / the bazooka. */
  explosives: boolean;
  /** Runs from grenades. */
  dodge: boolean;
  /** Chance of going after the nearest enemy (vs. wandering) when there's nothing else to do. */
  hunt: number;
  /** How rough its idea of where that enemy is (px). */
  huntSpread: number;
  /** Swaps a weapon for a better one when its slots are full. */
  swapLoot: boolean;
  /** Heads into the next safe zone as soon as it's announced (otherwise only once it shrinks). */
  zoneEarly: boolean;
  /** Keeps chasing an enemy that ducked out of sight for this long. */
  memoryMs: number;
}

const PROFILES: Record<BotLevel, Profile> = {
  easy: {
    reactionMs: 750, aimError: 0.2, turnRate: 4.5, sight: 520, thinkMs: 230, burstOn: 450, burstOff: 700,
    strafe: 0.15, retreatHp: 0, lead: 0, smartWeapons: false, explosives: false, dodge: false,
    hunt: 0.35, huntSpread: 450, swapLoot: false, zoneEarly: false, memoryMs: 0,
  },
  medium: {
    reactionMs: 380, aimError: 0.1, turnRate: 9, sight: 680, thinkMs: 150, burstOn: 900, burstOff: 320,
    strafe: 0.6, retreatHp: 28, lead: 0.5, smartWeapons: true, explosives: true, dodge: false,
    hunt: 0.75, huntSpread: 260, swapLoot: true, zoneEarly: true, memoryMs: 1800,
  },
  hard: {
    reactionMs: 170, aimError: 0.04, turnRate: 18, sight: 860, thinkMs: 90, burstOn: 0, burstOff: 0,
    strafe: 1, retreatHp: 40, lead: 1, smartWeapons: true, explosives: true, dodge: true,
    hunt: 1, huntSpread: 120, swapLoot: true, zoneEarly: true, memoryMs: 3000,
  },
};

/** How much a bot wants each weapon lying on the ground. */
const LOOT_TIER: Partial<Record<WeaponId, number>> = {
  rifle: 6, shotgun: 5, mg: 5, sniper: 4, bazooka: 3, grenade: 3.5, pistol: 2, sword: 2, axe: 2, knife: 1.5,
};
/** Preferred fighting distance with each weapon (melee: as close as possible). */
const IDEAL_RANGE: Partial<Record<WeaponId, number>> = {
  pistol: 260, rifle: 330, shotgun: 120, mg: 260, sniper: 640, bazooka: 380, grenade: 260,
};
/** A grenade rolls about this far before it stops (throw speed² / 2·friction). */
const GRENADE_REACH = 320;
const ITEM_REACH = PLAYER_RADIUS + PICKUP_RADIUS + 4;
/** Hidden in a tree: a bot only notices you this close (unless you just gave yourself away). */
const TREE_SPOT_RANGE = 110;

type Target = { kind: "player"; id: string; p: Player } | { kind: "core"; team: Team; x: number; y: number };

export class BotBrain {
  private readonly prof: Profile;
  private input: InputState = { left: false, right: false, up: false, down: false, fire: false, angle: 0 };
  private nextThinkAt = 0;
  private wasAlive = false;

  // Aim
  private aim = 0;
  private aimNoise = 0;
  private wantAngle: number | null = null;
  private wantFire = false;
  private fireTolerance = 0.15;
  private burstEnd = 0;
  private pauseEnd = 0;

  // Target
  private targetId = "";
  private lastSeenAt = -Infinity;
  private lastSeenPos: Point | null = null;
  private shootReadyAt = 0;
  private prevTargetPos: { x: number; y: number; t: number } | null = null;
  private targetVel = { x: 0, y: 0 };

  // Movement: either a path to follow or a direction to walk in.
  private path: Point[] = [];
  private pathIdx = 0;
  private pathGoal: Point | null = null;
  private segStart: Point = { x: 0, y: 0 };
  private repathAt = 0;
  private arriveDist = 24;
  private moveDir: Point | null = null;
  private strafeSign = 1;
  private strafeUntil = 0;
  private strafing = false;

  // Stuck detection
  private stuckCheckAt = 0;
  private stuckPos: Point = { x: 0, y: 0 };
  private unstickUntil = 0;
  private unstickDir: Point = { x: 0, y: 0 };

  // Goals
  private lootId = "";
  private lootDeadline = 0;
  private lootBlacklist = new Map<string, number>();
  private roamPoint: Point | null = null;
  private roamUntil = 0;
  private zoneGoal: Point | null = null;
  private zoneKey = "";
  private retreating = false;
  private nextGrenadeAt = 0;
  private switchReadyAt = 0;
  private lastCoreHp = new Map<string, number>();
  private coreHitAt = new Map<string, number>();
  /** What it's doing (for debugging: BOT_DEBUG=1 logs it). */
  goal = "";
  /** A side offset so teammates don't all walk the exact same line. */
  private lane = (Math.random() * 2 - 1) * 140;
  /** Guards wander about their post (a new spot every few seconds) instead of standing frozen. */
  private patrolAt = 0;
  private patrolDist = 0;
  /** Flank route: already went round the corner (heads straight for the enemy base now). */
  private flanked = false;

  constructor(
    readonly id: string,
    readonly level: BotLevel,
    /** Team mode: "defend" bots guard their own base (unless it's time to finish the enemy off). */
    public role: "attack" | "defend" = "attack",
    /** Team mode attackers: straight through the middle, or around one of the two empty corners. */
    public route: "mid" | "left" | "right" = "mid",
  ) {
    this.prof = PROFILES[level];
  }

  /** This tick's input for the bot (call every server tick). */
  update(w: BotWorld, me: Player, dtMs: number): InputState {
    const now = w.now;
    if (!me.alive || me.spectator) {
      this.wasAlive = false;
      return this.idle();
    }
    if (!this.wasAlive) this.onSpawn(me, now);
    if (w.state.matchPhase === "ended") return this.idle();

    if (now >= this.nextThinkAt) {
      this.think(w, me, now);
      this.nextThinkAt = now + this.prof.thinkMs * (0.8 + Math.random() * 0.4);
    }

    // Movement
    let mv = this.moveDir ?? this.followPath(me);
    if (this.prof.dodge) mv = this.dodgeGrenades(w, me, mv);
    this.checkStuck(me, mv, now);
    if (now < this.unstickUntil) mv = this.unstickDir;

    // Aim: turn (at a limited speed) toward the target, or where we're walking.
    const want = this.wantAngle ?? (mv && (mv.x || mv.y) ? Math.atan2(mv.y, mv.x) : this.aim);
    const maxTurn = (this.prof.turnRate * dtMs) / 1000;
    const delta = angleDelta(this.aim, want);
    this.aim += Math.max(-maxTurn, Math.min(maxTurn, delta));
    const lined = this.wantAngle !== null && Math.abs(angleDelta(this.aim, this.wantAngle)) <= this.fireTolerance;

    const i = this.input;
    i.left = !!mv && mv.x < -0.38;
    i.right = !!mv && mv.x > 0.38;
    i.up = !!mv && mv.y < -0.38;
    i.down = !!mv && mv.y > 0.38;
    i.fire = this.wantFire && lined && this.burstAllows(me, now);
    i.angle = this.aim;
    if (i.fire && heldStats(me.slots[me.active].weapon) === WEAPONS.grenade) this.nextGrenadeAt = now + 2600;
    return i;
  }

  private idle(): InputState {
    const i = this.input;
    i.left = i.right = i.up = i.down = i.fire = false;
    return i;
  }

  private onSpawn(me: Player, now: number) {
    this.wasAlive = true;
    this.aim = me.angle;
    this.path = [];
    this.pathGoal = null;
    this.moveDir = null;
    this.targetId = "";
    this.lastSeenPos = null;
    this.lootId = "";
    this.roamPoint = null;
    this.retreating = false;
    this.flanked = false;
    this.wantAngle = null;
    this.wantFire = false;
    this.stuckCheckAt = now + 700;
    this.stuckPos = { x: me.x, y: me.y };
    this.nextThinkAt = now + 150 + Math.random() * 250; // a moment to "look around"
  }

  // ---------- Decisions ----------

  private think(w: BotWorld, me: Player, now: number) {
    for (const [id, until] of this.lootBlacklist) if (now >= until) this.lootBlacklist.delete(id);
    this.trackCores(w, now);
    this.moveDir = null;
    this.wantFire = false;
    this.wantAngle = null;

    const target = this.pickTarget(w, me, now);
    const dist = target ? Math.hypot(target.x() - me.x, target.y() - me.y) : null;
    this.manageWeapons(w, me, dist, now);

    // Low on health: get out (and heal) first, shooting back on the way if possible.
    const p = this.prof;
    if (p.retreatHp > 0) {
      // (Team mode: the fountain is a long walk back, so only when it's really bad.)
      if (me.hp < (w.teams ? p.retreatHp * 0.6 : p.retreatHp)) this.retreating = true;
      else if (me.hp >= (w.teams ? 90 : p.retreatHp + 30)) this.retreating = false;
    }

    if (target?.t.kind === "player") {
      this.goal = `fight ${target.t.p.name}`;
      this.fight(w, me, target.t, dist!, now);
      return;
    }
    if (target?.t.kind === "core") {
      this.goal = "core";
      this.shootAt(me, target.t.x, target.t.y, dist!, CORE_RADIUS, now);
    }
    this.roam(w, me, now, !!target);
  }

  /** The enemy to fight: closest one in sight (sticking with the current one), or the enemy core in range. */
  private pickTarget(w: BotWorld, me: Player, now: number) {
    const p = this.prof;
    let best: { t: Target; score: number } | undefined;
    w.state.players.forEach((other, id) => {
      if (id === this.id || !other.alive || other.spectator) return;
      if (w.teams && other.team === me.team) return;
      const d = Math.hypot(other.x - me.x, other.y - me.y);
      if (d > p.sight) return;
      // Hiding in a tree: invisible from further away, unless they just shot or got hit.
      if (d > TREE_SPOT_RANGE && now >= other.revealedUntil && w.map.treeAt(other.x, other.y)) return;
      if (!w.nav.sightClear(me.x, me.y, other.x, other.y, PLAYER_RADIUS - 6)) return;
      let score = d;
      if (id === this.targetId) score -= 160; // don't flip between targets every moment
      if (this.level === "hard") score -= (PLAYER_MAX_HP - other.hp) * 1.5; // finish off the wounded
      if (!best || score < best.score) best = { t: { kind: "player", id, p: other }, score };
    });

    // Team mode: the enemy core, if it's in range and in view. Near it, the objective comes
    // first: only an enemy right on top of us is worth turning away from it for.
    let coreTarget: { t: Target; x: () => number; y: () => number } | undefined;
    if (w.teams && isTeam(me.team) && !this.retreating) {
      const core = w.state.cores.get(otherTeam(me.team));
      if (core && core.hp > 0) {
        const d = Math.hypot(core.x - me.x, core.y - me.y);
        const reach = weaponReach(me.slots[me.active].weapon) * 0.92 + CORE_RADIUS;
        if (d <= reach && w.nav.sightClear(me.x, me.y, core.x, core.y, CORE_RADIUS + 4)) {
          coreTarget = { t: { kind: "core", team: core.team as Team, x: core.x, y: core.y }, x: () => core.x, y: () => core.y };
        }
      }
    }
    const closeEnemy = best?.t.kind === "player" && Math.hypot(best.t.p.x - me.x, best.t.p.y - me.y) < 260;

    if (best && best.t.kind === "player" && (!coreTarget || closeEnemy)) {
      const t = best.t;
      if (t.id !== this.targetId || now - this.lastSeenAt > 1500) {
        // A new enemy: it takes a moment to react.
        this.shootReadyAt = now + p.reactionMs * (0.75 + Math.random() * 0.5);
        this.prevTargetPos = null;
        this.aimNoise = (Math.random() * 2 - 1) * p.aimError * 1.5; // first shots are the shakiest
      }
      this.targetId = t.id;
      this.lastSeenAt = now;
      this.lastSeenPos = { x: t.p.x, y: t.p.y };
      // How fast it's moving (for aiming ahead of it).
      if (this.prevTargetPos && now > this.prevTargetPos.t) {
        const dt = (now - this.prevTargetPos.t) / 1000;
        this.targetVel = { x: (t.p.x - this.prevTargetPos.x) / dt, y: (t.p.y - this.prevTargetPos.y) / dt };
      } else this.targetVel = { x: 0, y: 0 };
      this.prevTargetPos = { x: t.p.x, y: t.p.y, t: now };
      return { t: best.t, x: () => t.p.x, y: () => t.p.y };
    }

    if (coreTarget) {
      this.targetVel = { x: 0, y: 0 };
      if (this.targetId !== "core") this.shootReadyAt = now + p.reactionMs;
      this.targetId = "core";
      return coreTarget;
    }
    if (this.targetId === "core") this.targetId = "";
    return undefined;
  }

  /** A fight with a soldier: aim, shoot, and move (keep a good distance, strafe, or back off). */
  private fight(w: BotWorld, me: Player, t: { id: string; p: Player }, dist: number, now: number) {
    const p = this.prof;
    // Aim ahead of a moving target (by how long the bullet takes to get there).
    const gun = gunStats(me.slots[me.active].weapon);
    let ax = t.p.x;
    let ay = t.p.y;
    if (gun && p.lead > 0 && !gun.thrown) {
      const fly = Math.min(0.8, dist / gun.bulletSpeed) * p.lead;
      ax += this.targetVel.x * fly;
      ay += this.targetVel.y * fly;
    }
    this.shootAt(me, ax, ay, dist, PLAYER_RADIUS, now);

    // Where to go: zone trouble and running away come first (still shooting).
    const urgent = this.zoneUrgent(w, me);
    if (urgent) return this.goTo(w, me, urgent, now, 60);
    if (this.retreating) {
      const safe = this.retreatPoint(w, me);
      if (safe) return this.goTo(w, me, safe, now, 40);
      return this.walk(me.x - t.p.x, me.y - t.p.y, this.strafeVec(me, t.p, now), 1);
    }

    const weapon = (me.slots[me.active].weapon || "fists") as WeaponId;
    const melee = WEAPONS[weapon].kind === "melee";
    const reach = weaponReach(weapon);
    const ideal = melee ? 0 : Math.min(IDEAL_RANGE[weapon] ?? 300, reach * 0.8);
    let radial = 0;
    if (melee || dist > ideal + 70) radial = 1;
    else if (dist < ideal - 70) radial = -1;

    // Too far and no straight way there: path to them.
    if (radial > 0 && (dist > reach || melee) && !w.nav.walkClear(me.x, me.y, t.p.x, t.p.y)) {
      return this.goTo(w, me, { x: t.p.x, y: t.p.y }, now, 10);
    }
    const side = this.strafeVec(me, t.p, now);
    if (radial === 0 && !side) {
      this.path = [];
      this.moveDir = { x: 0, y: 0 }; // stand and shoot
      return;
    }
    this.walk(t.p.x - me.x, t.p.y - me.y, side, radial);
  }

  /** Aim at a point and fire once the reaction time has passed and it's in range. */
  private shootAt(me: Player, x: number, y: number, dist: number, targetRadius: number, now: number) {
    const p = this.prof;
    // The wobble drifts around instead of jumping every shot.
    this.aimNoise = this.aimNoise * 0.6 + (Math.random() * 2 - 1) * p.aimError * 0.7;
    this.aimNoise = Math.max(-p.aimError * 1.5, Math.min(p.aimError * 1.5, this.aimNoise));
    this.wantAngle = Math.atan2(y - me.y, x - me.x) + this.aimNoise;
    this.fireTolerance = Math.atan2(targetRadius, Math.max(dist, 1)) + 0.06;

    const slot = me.slots[me.active];
    const weapon = (slot.weapon || "fists") as WeaponId;
    const stats = heldStats(weapon);
    if (now < this.shootReadyAt) return;
    if (stats.kind === "melee") {
      this.wantFire = dist - PLAYER_RADIUS - targetRadius <= stats.range + 4;
      return;
    }
    if (slot.ammo <= 0 || me.reloading) return;
    if (stats.splash && dist < stats.splash.radius + 20) return; // would blow ourselves up
    this.wantFire = dist - targetRadius <= weaponReach(weapon) * (this.level === "easy" ? 1.1 : 0.97);
  }

  /** Nobody to fight: go somewhere useful (safe zone, health, loot, the enemy base, or hunting). */
  private roam(w: BotWorld, me: Player, now: number, shootingCore: boolean) {
    const urgent = this.zoneUrgent(w, me);
    if (urgent) {
      this.goal = "zone!";
      return this.goTo(w, me, urgent, now, 60);
    }

    if (this.retreating) {
      const safe = this.retreatPoint(w, me);
      this.goal = "retreat";
      if (safe) return this.goTo(w, me, safe, now, 40);
    }

    if (shootingCore) {
      // In range of the enemy core: keep shooting it, side-stepping a little.
      const core = w.state.cores.get(otherTeam(me.team as Team))!;
      const side = this.strafeVec(me, core, now);
      if (side) this.walk(core.x - me.x, core.y - me.y, side, 0);
      else this.moveDir = { x: 0, y: 0 };
      return;
    }

    const zone = this.zoneSafePoint(w, me);
    if (zone) {
      this.goal = "zone";
      return this.goTo(w, me, zone, now, 60);
    }

    const loot = this.pickLoot(w, me, now);
    if (loot) {
      this.goal = `loot ${w.state.items.get(loot.id)?.kind ?? ""}`;
      const d = Math.hypot(loot.item.x - me.x, loot.item.y - me.y);
      if (d <= ITEM_REACH + 6 && loot.swap) {
        // Slots full: hold the weakest weapon and swap it for this one (E).
        const worst = this.worstSlot(me);
        if (worst >= 0 && worst !== me.active) w.selectSlot(this.id, worst);
        w.pickup(this.id);
        this.lootBlacklist.set(loot.id, now + 3000); // don't stand here trying forever
      }
      return this.goTo(w, me, { x: loot.item.x, y: loot.item.y }, now, 6);
    }

    // Just lost sight of someone: check where they went.
    if (this.lastSeenPos && now - this.lastSeenAt < this.prof.memoryMs) {
      this.goal = "chase";
      return this.goTo(w, me, this.lastSeenPos, now, 30);
    }

    if (w.teams && isTeam(me.team)) return this.teamObjective(w, me, now);
    this.hunt(w, me, now);
  }

  /** Team mode: push to the enemy base, or guard our own. */
  private teamObjective(w: BotWorld, me: Player, now: number) {
    const mine = me.team as Team;
    const enemy = otherTeam(mine);
    const own = w.state.cores.get(mine);
    const theirs = w.state.cores.get(enemy);
    const home = BASES[mine];
    const homeDist = Math.hypot(me.x - home.x, me.y - home.y);
    const underAttack = now - (this.coreHitAt.get(mine) ?? -Infinity) < 4000;

    const finishThem = !!theirs && !!own && theirs.hp / theirs.maxHp < 0.35 && own.hp / own.maxHp > 0.6;
    if ((underAttack && homeDist < 1500) || (this.role === "defend" && !finishThem)) {
      // Stand guard between our base and the middle of the map (go right to the core if it's being hit).
      const guard = underAttack ? 180 : 380;
      this.goal = underAttack ? "defend!" : "guard";
      if (now >= this.patrolAt) {
        this.patrolAt = now + 3000 + Math.random() * 3000;
        this.patrolDist = (Math.random() * 2 - 1) * 120;
        this.lane = (Math.random() * 2 - 1) * 220;
      }
      return this.goTo(w, me, this.basePoint(mine, guard + this.patrolDist), now, 40);
    }
    const reach = weaponReach(me.slots[me.active].weapon);
    const standoff = Math.max(140, Math.min(560, reach * 0.8));
    // Flankers go round an empty corner first, so not every push piles into the middle.
    if (this.route !== "mid" && !this.flanked) {
      const corner = this.route === "left" ? { x: 420, y: 420 } : { x: ARENA_SIZE - 420, y: ARENA_SIZE - 420 };
      if (Math.hypot(me.x - corner.x, me.y - corner.y) < 260) this.flanked = true;
      else {
        this.goal = `flank ${this.route}`;
        return this.goTo(w, me, { x: corner.x + this.lane * 0.5, y: corner.y - this.lane * 0.5 }, now, 120);
      }
    }
    this.goal = "push";
    this.goTo(w, me, this.basePoint(enemy, standoff), now, 50);
  }

  /** A spot `dist` from a team's core, toward the middle of the map (offset by this bot's lane). */
  private basePoint(team: Team, dist: number): Point {
    const b = BASES[team];
    const mx = ARENA_SIZE / 2 - b.x;
    const my = ARENA_SIZE / 2 - b.y;
    const len = Math.hypot(mx, my);
    const ux = mx / len;
    const uy = my / len;
    return {
      x: clampArena(b.x + ux * dist - uy * this.lane),
      y: clampArena(b.y + uy * dist + ux * this.lane),
    };
  }

  /** Solo: go after the nearest enemy (roughly), or wander about. */
  private hunt(w: BotWorld, me: Player, now: number) {
    this.goal = "hunt";
    if (!this.roamPoint || now >= this.roamUntil || Math.hypot(this.roamPoint.x - me.x, this.roamPoint.y - me.y) < 60) {
      this.roamUntil = now + 2500 + Math.random() * 2000;
      let prey: Player | undefined;
      let preyD = Infinity;
      if (Math.random() < this.prof.hunt) {
        w.state.players.forEach((o, id) => {
          if (id === this.id || !o.alive || o.spectator || (w.teams && o.team === me.team)) return;
          const d = Math.hypot(o.x - me.x, o.y - me.y);
          if (d < preyD) {
            preyD = d;
            prey = o;
          }
        });
      }
      const s = this.prof.huntSpread;
      if (prey) {
        this.roamPoint = {
          x: clampArena(prey.x + (Math.random() * 2 - 1) * s),
          y: clampArena(prey.y + (Math.random() * 2 - 1) * s),
        };
      } else {
        const z = w.state.zone;
        const area = z.phase === "waiting" ? { x: 0, y: 0, w: ARENA_SIZE, h: ARENA_SIZE } : { x: z.x, y: z.y, w: z.size, h: z.size };
        this.roamPoint = w.nav.randomOpenSpot(area);
      }
    }
    this.goTo(w, me, this.roamPoint, now, 40);
  }

  // ---------- Safe zone (solo) ----------

  /** Outside the zone right now: the way back in. */
  private zoneUrgent(w: BotWorld, me: Player): Point | null {
    if (w.teams || !w.isOutsideZone(me.x, me.y)) return null;
    return this.zoneTarget(w);
  }

  /** The next safe square is announced and we're not in it (or close to its edge): head in. */
  private zoneSafePoint(w: BotWorld, me: Player): Point | null {
    if (w.teams) return null;
    const z = w.state.zone;
    if (z.phase === "waiting" || (z.phase === "hold" && !this.prof.zoneEarly)) return null;
    const m = Math.min(80, z.nextSize * 0.15);
    const inside = me.x > z.nextX + m && me.y > z.nextY + m && me.x < z.nextX + z.nextSize - m && me.y < z.nextY + z.nextSize - m;
    return inside ? null : this.zoneTarget(w);
  }

  private zoneTarget(w: BotWorld): Point {
    const z = w.state.zone;
    const key = `${Math.round(z.nextX)}:${Math.round(z.nextY)}:${Math.round(z.nextSize)}`;
    if (key !== this.zoneKey || !this.zoneGoal) {
      this.zoneKey = key;
      const size = z.nextSize || z.size;
      const x = z.nextSize ? z.nextX : z.x;
      const y = z.nextSize ? z.nextY : z.y;
      const inset = size * 0.25;
      this.zoneGoal = w.nav.randomOpenSpot({ x: x + inset, y: y + inset, w: size - inset * 2, h: size - inset * 2 });
    }
    return this.zoneGoal;
  }

  // ---------- Health ----------

  /** Somewhere to heal: the fountain at our base (teams), or the closest medkit. */
  private retreatPoint(w: BotWorld, me: Player): Point | null {
    if (w.teams && isTeam(me.team)) {
      const b = BASES[me.team];
      if (Math.hypot(me.x - b.x, me.y - b.y) < FOUNTAIN_RADIUS - 50) return null; // healing already
      return this.basePoint(me.team, FOUNTAIN_RADIUS * 0.5);
    }
    let best: Point | null = null;
    let bestD = 1200;
    w.state.items.forEach((it) => {
      if (it.kind !== "medkit") return;
      const d = Math.hypot(it.x - me.x, it.y - me.y);
      if (d < bestD) {
        bestD = d;
        best = { x: it.x, y: it.y };
      }
    });
    return best;
  }

  // ---------- Loot ----------

  private pickLoot(w: BotWorld, me: Player, now: number) {
    // Already carrying a good gun with ammo: only grab what's close by (get on with the fight).
    const armed = me.slots.some((s) => slotTier(s) >= 4 && s.ammo + s.reserve >= (gunStats(s.weapon)?.mag ?? 0));
    const radius = armed ? (w.teams ? 280 : 550) : w.teams ? 650 : 1000;
    let best: { id: string; item: { x: number; y: number }; swap: boolean; score: number } | undefined;
    w.state.items.forEach((item, id) => {
      if (this.lootBlacklist.has(id)) return;
      const d = Math.hypot(item.x - me.x, item.y - me.y);
      if (d > radius) return;
      if (w.teams && isTeam(me.team)) {
        const eb = BASES[otherTeam(me.team)];
        if (Math.hypot(item.x - eb.x, item.y - eb.y) < BASE_CLEAR_RADIUS + 150) return; // not worth the turret
      }
      if (!w.teams && w.isOutsideZone(item.x, item.y)) return;
      const { value, swap } = this.itemValue(me, item);
      if (value <= 0) return;
      let score = value / (d + 200);
      if (id === this.lootId) score *= 1.5;
      if (!best || score > best.score) best = { id, item, swap, score };
    });
    if (!best) {
      this.lootId = "";
      return undefined;
    }
    const found = best as { id: string; item: { x: number; y: number }; swap: boolean; score: number };
    if (found.id !== this.lootId) {
      this.lootId = found.id;
      const d = Math.hypot(found.item.x - me.x, found.item.y - me.y);
      this.lootDeadline = now + 3000 + (d / 200) * 1000 * 2;
    } else if (now > this.lootDeadline) {
      // Can't get there: forget about it for a while.
      this.lootBlacklist.set(found.id, now + 20_000);
      this.lootId = "";
      return undefined;
    }
    return found;
  }

  /** How much this bot wants an item (0 = not at all), and whether it would need a swap (E). */
  private itemValue(
    me: Player,
    item: { kind: string; weapon: string; armor: number; charge: number },
  ): { value: number; swap: boolean } {
    const no = { value: 0, swap: false };
    switch (item.kind) {
      case "medkit":
        return { value: me.hp < 35 ? 10 : me.hp <= 60 ? 5 : 0, swap: false };
      case "vest":
        return { value: item.armor > me.armor + 10 ? 4 : 0, swap: false };
      case "boots":
        return { value: item.charge > me.boots + 20 && me.boots < 25 ? 1.5 : 0, swap: false };
      case "ammo": {
        const hungry = me.slots.some((s) => {
          const g = gunStats(s.weapon);
          return g && g.boxAmmo > 0 && s.reserve < g.maxReserve * 0.5;
        });
        return { value: hungry ? 3 : 0, swap: false };
      }
      case "weapon": {
        const owned = me.slots.find((s) => s.weapon === item.weapon);
        if (owned) {
          const g = gunStats(item.weapon);
          return { value: g && owned.reserve < g.maxReserve * 0.5 ? 2 : 0, swap: false };
        }
        let tier = LOOT_TIER[item.weapon as WeaponId] ?? 0;
        if (item.weapon === "grenade" || item.weapon === "bazooka") tier = this.prof.explosives ? tier : 0.5;
        if (me.slots.some((s) => !s.weapon)) return { value: tier, swap: false };
        if (!this.prof.swapLoot) return no;
        const worst = this.worstSlot(me);
        const worstTier = worst >= 0 ? slotTier(me.slots[worst]) : Infinity;
        return tier >= worstTier + 2 ? { value: tier - worstTier, swap: true } : no;
      }
    }
    return no;
  }

  private worstSlot(me: Player): number {
    let worst = -1;
    let tier = Infinity;
    me.slots.forEach((s, i) => {
      const t = slotTier(s);
      if (t < tier) {
        tier = t;
        worst = i;
      }
    });
    return worst;
  }

  // ---------- Weapons ----------

  private manageWeapons(w: BotWorld, me: Player, dist: number | null, now: number) {
    // Throw away guns with no ammo left at all (frees the slot for something better).
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = me.slots[i];
      const g = gunStats(s.weapon);
      if (g && s.ammo + s.reserve <= 0) {
        w.dropSlot(this.id, i);
        return;
      }
    }

    const active = me.slots[me.active];
    let best = me.active;
    let bestScore = this.weaponScore(active, dist, now);
    const current = bestScore;
    // Easy bots only change weapons between fights (or when this one is useless).
    if (this.prof.smartWeapons || dist === null || current <= 0.01) {
      for (let i = 0; i < SLOT_COUNT; i++) {
        if (i === me.active || !me.slots[i].weapon) continue;
        const s = this.weaponScore(me.slots[i], dist, now);
        if (s > bestScore) {
          bestScore = s;
          best = i;
        }
      }
    }
    const worthIt = current <= 0.01 || bestScore > current * 1.3;
    if (best !== me.active && worthIt && now >= this.switchReadyAt) {
      w.selectSlot(this.id, best);
      this.switchReadyAt = now + 900;
      return;
    }

    // Reload: when the magazine is empty, or between fights when it isn't full.
    const gun = gunStats(active.weapon);
    if (gun && !gun.thrown && !me.reloading && active.reserve > 0 && active.ammo < gun.mag) {
      const calm = dist === null && now - this.lastSeenAt > 1200;
      if (active.ammo === 0 || (calm && active.ammo < gun.mag * 0.7)) w.reload(this.id);
    }
  }

  /** How good a weapon is right now (at `dist` from the target, or in general when null). */
  private weaponScore(slot: WeaponSlot, dist: number | null, now: number): number {
    const id = (slot.weapon || "fists") as WeaponId;
    const stats = heldStats(id);
    if (stats.kind === "melee") {
      const dps = (stats.damage * 1000) / stats.swingMs;
      if (dist === null) return dps * 0.15;
      return dist - PLAYER_RADIUS * 2 <= stats.range + 30 ? dps * 1.5 : dps * 0.02;
    }
    const g = stats as GunStats;
    if (slot.ammo + slot.reserve <= 0) return 0;
    if (g.thrown && (!this.prof.explosives || now < this.nextGrenadeAt)) return 0.005;
    if (g.splash && !this.prof.explosives) return 0.005;
    let dps = (g.damage * (g.pellets ?? 1) * g.mag * 1000) / (g.mag * g.fireMs + g.reloadMs);
    if (g.splash) dps *= 1.5;
    if (slot.ammo <= 0) dps *= 0.6;
    if (dist === null) return g.thrown ? dps * 0.05 : dps;
    if (g.splash && dist < g.splash.radius + 40) return 0.01;
    if (g.thrown) return dist > 140 && dist < GRENADE_REACH ? dps * 1.3 : 0.01;
    if (dist > weaponReach(id)) return dps * 0.05;
    // Shotgun: the share of pellets that still hit once the fan is wider than a soldier.
    if (g.pellets) dps *= Math.min(1, (PLAYER_RADIUS * 2) / Math.max(1, dist * Math.tan(g.spread) * 2));
    if (id === "sniper") dps *= dist > 450 ? 3 : dist < 200 ? 0.5 : 1;
    if (g.spread > 0.06 && dist > 400) dps *= 0.6;
    return dps;
  }

  private burstAllows(me: Player, now: number): boolean {
    const p = this.prof;
    const gun = gunStats(me.slots[me.active].weapon);
    if (!p.burstOn || !gun || gun.fireMs > 300) return true; // single shots: no bursts
    if (now >= this.pauseEnd) {
      this.burstEnd = now + p.burstOn * (0.7 + Math.random() * 0.6);
      this.pauseEnd = this.burstEnd + p.burstOff * (0.7 + Math.random() * 0.6);
    }
    return now < this.burstEnd;
  }

  // ---------- Moving ----------

  /** Head for a point (pathfinding around walls). `arrive`: how close counts as there. */
  private goTo(w: BotWorld, me: Player, goal: Point, now: number, arrive: number) {
    this.arriveDist = arrive;
    const moved = !this.pathGoal || Math.hypot(this.pathGoal.x - goal.x, this.pathGoal.y - goal.y) > 60;
    if (!moved && now < this.repathAt && this.path.length) return;
    this.pathGoal = { ...goal };
    this.repathAt = now + 1200 + Math.random() * 600;
    this.segStart = { x: me.x, y: me.y };
    this.pathIdx = 0;
    if (w.nav.walkClear(me.x, me.y, goal.x, goal.y)) {
      this.path = [{ ...goal }];
      return;
    }
    this.path = w.nav.findPath(me.x, me.y, goal.x, goal.y) ?? [{ ...goal }];
  }

  /** Walk toward/away from something (`radial` 1 / -1 / 0) plus an optional side-step. */
  private walk(dx: number, dy: number, side: Point | null, radial: number) {
    this.path = [];
    this.pathGoal = null;
    const len = Math.hypot(dx, dy) || 1;
    let x = (dx / len) * radial + (side?.x ?? 0);
    let y = (dy / len) * radial + (side?.y ?? 0);
    const l = Math.hypot(x, y);
    if (l > 0.01) {
      x /= l;
      y /= l;
    }
    this.moveDir = { x, y };
  }

  /** Side-stepping during a fight (switches direction every so often). */
  private strafeVec(me: Player, from: { x: number; y: number }, now: number): Point | null {
    if (now >= this.strafeUntil) {
      this.strafeUntil = now + 500 + Math.random() * 900;
      this.strafing = Math.random() < this.prof.strafe;
      this.strafeSign = Math.random() < 0.5 ? 1 : -1;
    }
    if (!this.strafing) return null;
    const dx = from.x - me.x;
    const dy = from.y - me.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: (-dy / len) * this.strafeSign, y: (dx / len) * this.strafeSign };
  }

  /**
   * Follow the current path. Steers at a point a little way down the current leg (not the
   * corner itself), so 8-way movement stays close to the planned line.
   */
  private followPath(me: Player): Point | null {
    while (this.pathIdx < this.path.length) {
      const wp = this.path[this.pathIdx];
      const last = this.pathIdx === this.path.length - 1;
      if (Math.hypot(wp.x - me.x, wp.y - me.y) > (last ? this.arriveDist : 18)) break;
      this.segStart = wp;
      this.pathIdx++;
    }
    if (this.pathIdx >= this.path.length) return null;
    const a = this.segStart;
    const b = this.path[this.pathIdx];
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const segLen = Math.hypot(sx, sy);
    let tx = b.x;
    let ty = b.y;
    if (segLen > 1) {
      const t = ((me.x - a.x) * sx + (me.y - a.y) * sy) / (segLen * segLen);
      const ahead = Math.min(1, Math.max(0, t) + 40 / segLen);
      tx = a.x + sx * ahead;
      ty = a.y + sy * ahead;
    }
    const dx = tx - me.x;
    const dy = ty - me.y;
    const len = Math.hypot(dx, dy);
    return len > 0.5 ? { x: dx / len, y: dy / len } : null;
  }

  /** Get away from grenades about to go off. */
  private dodgeGrenades(w: BotWorld, me: Player, mv: Point | null): Point | null {
    const splash = gunStats("grenade")!.splash!;
    let ax = 0;
    let ay = 0;
    w.state.grenades.forEach((g) => {
      const owner = w.state.players.get(g.owner);
      if (w.teams && owner && g.owner !== this.id && owner.team === me.team) return; // teammates' grenades don't hurt
      const dx = me.x - g.x;
      const dy = me.y - g.y;
      const d = Math.hypot(dx, dy);
      if (d > splash.radius + 40) return;
      const push = 1 - d / (splash.radius + 40);
      ax += (dx / (d || 1)) * push * 3;
      ay += (dy / (d || 1)) * push * 3;
    });
    if (!ax && !ay) return mv;
    const x = ax + (mv?.x ?? 0);
    const y = ay + (mv?.y ?? 0);
    const l = Math.hypot(x, y) || 1;
    return { x: x / l, y: y / l };
  }

  /** Walking into a wall and getting nowhere: step aside for a moment and plan again. */
  private checkStuck(me: Player, mv: Point | null, now: number) {
    if (now < this.stuckCheckAt) return;
    const moving = !!mv && (Math.abs(mv.x) > 0.38 || Math.abs(mv.y) > 0.38);
    const moved = Math.hypot(me.x - this.stuckPos.x, me.y - this.stuckPos.y);
    if (moving && moved < 12 && now >= this.unstickUntil) {
      const a = Math.atan2(mv!.y, mv!.x) + (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2 + Math.random() * 0.8);
      this.unstickDir = { x: Math.cos(a), y: Math.sin(a) };
      this.unstickUntil = now + 300 + Math.random() * 300;
      this.repathAt = 0; // plan a new path after
      this.roamPoint = null;
    }
    this.stuckCheckAt = now + 700;
    this.stuckPos = { x: me.x, y: me.y };
  }

  /** Notice when a core takes damage (team bots rush home to defend). */
  private trackCores(w: BotWorld, now: number) {
    w.state.cores.forEach((core, team) => {
      const before = this.lastCoreHp.get(team);
      if (before !== undefined && core.hp < before) this.coreHitAt.set(team, now);
      this.lastCoreHp.set(team, core.hp);
    });
  }
}

/** How far a weapon reaches (guns: bullet range; grenades: how far they roll; melee: arm's length). */
function weaponReach(weapon: string): number {
  const s = heldStats(weapon);
  if (s.kind === "melee") return s.range + PLAYER_RADIUS * 2;
  if (s.thrown) return GRENADE_REACH;
  return (s.bulletSpeed * s.bulletLifeMs) / 1000;
}

/** How much a weapon in a slot is worth keeping (empty guns are worth nothing). */
function slotTier(s: WeaponSlot): number {
  if (!s.weapon) return -1;
  const g = gunStats(s.weapon);
  if (g && s.ammo + s.reserve <= 0) return 0;
  return LOOT_TIER[s.weapon as WeaponId] ?? 1;
}

function clampArena(v: number): number {
  return Math.max(PLAYER_RADIUS + 10, Math.min(ARENA_SIZE - PLAYER_RADIUS - 10, v));
}
