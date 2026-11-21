import { PLAYER_MAX_HP } from "../../shared/constants";
import { VEST_ARMOR } from "../../shared/weapons";
import { Minimap } from "./minimap";

/** One weapon slot as shown in the HUD. */
export interface SlotInfo {
  name: string; // "" = empty
  ammo: string; // "12/24" for guns, "" for melee
  active: boolean;
}

// The in-game HTML overlay: health, ammo, scoreboard, kill feed and death screen.
// Each setter only touches the DOM when the value actually changed.

const $ = (id: string) => document.getElementById(id)!;

export interface ScoreRow {
  name: string;
  kills: number;
  deaths: number;
  isMe: boolean;
  /** Eliminated from the current match (shown faded). */
  out: boolean;
  /** Team mode: "blue" | "red" (rows are grouped by team). */
  team?: string;
  /** Only watching (listed last, without a score). */
  spectator?: boolean;
}

/** One part of the top status line: the same text everywhere, or [full, short for small screens]. */
export type ZonePart = string | [full: string, short: string];

/** Team mode: the score strip at the top (kills per team and each base's health). */
export interface TeamScore {
  blueKills: number;
  redKills: number;
  /** Each base's health, 0..1 of full. */
  blueCore: number;
  redCore: number;
  /** Your team ("" while spectating): its side gets highlighted. */
  myTeam: string;
}

/** The buttons under the match info. null = hidden. */
export interface RoomActions {
  start: string | null;
  team: string | null;
  spectate: string | null;
}

export class Hud {
  private el = {
    root: $("combat-hud"),
    hpFill: $("hp-fill"),
    hpText: $("hp-text"),
    ammo: $("ammo"),
    reserve: $("reserve"),
    ammoNote: $("ammo-note"),
    score: $("scoreboard"),
    feed: $("killfeed"),
    death: $("death"),
    deathText: $("death-text"),
    spectating: $("spectating"),
    zoneInfo: $("zone-info"),
    zoneWarning: $("zone-warning"),
    hurtFlash: $("hurt-flash"),
    lowHp: $("low-hp"),
    banner: $("match-banner"),
    bannerTitle: $("banner-title"),
    bannerSub: $("banner-sub"),
    armorRow: $("armor-row"),
    armorFill: $("armor-fill"),
    armorText: $("armor-text"),
    bootsRow: $("boots-row"),
    bootsFill: $("boots-fill"),
    bootsText: $("boots-text"),
    weaponName: $("weapon-name"),
    ammoLine: $("ammo-line"),
    slots: $("weapon-slots"),
    prompt: $("pickup-prompt"),
    startMatch: $("start-match") as HTMLButtonElement,
    switchTeam: $("switch-team") as HTMLButtonElement,
    toggleSpectate: $("toggle-spectate") as HTMLButtonElement,
    deathTitle: $("death-title"),
    teamScore: $("team-score"),
    blueKills: $("blue-kills"),
    redKills: $("red-kills"),
    blueCore: $("blue-core"),
    redCore: $("red-core"),
  };
  private last: Record<string, string> = {};
  /** Touch screens: tapping a weapon slot selects it. */
  onSlotTap?: (index: number) => void;
  /** The host pressed "Start match". */
  onStartMatch?: () => void;
  /** Team mode: "Switch to Red / Blue". */
  onSwitchTeam?: () => void;
  /** "Spectate" / "Play". */
  onToggleSpectate?: () => void;

  constructor() {
    this.el.slots.addEventListener("pointerdown", (e) => {
      const li = (e.target as HTMLElement).closest("li");
      if (!li || !this.onSlotTap) return;
      e.preventDefault();
      this.onSlotTap([...this.el.slots.children].indexOf(li));
    });
    // .blur(): so Space / Enter don't press the button again
    this.el.startMatch.onclick = () => {
      this.el.startMatch.blur();
      this.onStartMatch?.();
    };
    this.el.switchTeam.onclick = () => {
      this.el.switchTeam.blur();
      this.onSwitchTeam?.();
    };
    this.el.toggleSpectate.onclick = () => {
      this.el.toggleSpectate.blur();
      this.onToggleSpectate?.();
    };
  }
  readonly minimap = new Minimap($("minimap") as HTMLCanvasElement);

  show() {
    this.el.root.hidden = false;
    this.el.feed.replaceChildren();
    this.last = {};
  }

  hide() {
    this.el.root.hidden = true;
    this.el.death.hidden = true;
    this.el.zoneWarning.hidden = true;
    this.el.lowHp.classList.remove("show");
    this.el.hurtFlash.classList.remove("show");
    this.el.banner.hidden = true;
    this.el.startMatch.hidden = true;
    this.el.switchTeam.hidden = true;
    this.el.toggleSpectate.hidden = true;
    this.el.teamScore.hidden = true;
    this.el.root.classList.remove("spectator-view");
    this.el.prompt.hidden = true;
  }

  /** Health bar, plus the blue vest bar when wearing one. */
  setHealth(hp: number, armor = 0) {
    if (!this.changed("hp", `${hp}:${armor}`)) return;
    const pct = Math.max(0, hp / PLAYER_MAX_HP) * 100;
    this.el.hpFill.style.width = `${pct}%`;
    this.el.hpFill.dataset.level = pct > 50 ? "ok" : pct > 25 ? "warn" : "low";
    this.el.hpText.textContent = String(hp);
    this.el.armorRow.hidden = armor <= 0;
    this.el.armorFill.style.width = `${Math.min(100, (armor / VEST_ARMOR) * 100)}%`;
    this.el.armorText.textContent = String(armor);
  }

  /** Speed boots charge (0-100 %, 0 hides the bar). */
  setBoots(pct: number) {
    if (!this.changed("boots", pct)) return;
    this.el.bootsRow.hidden = pct <= 0;
    this.el.bootsFill.style.width = `${Math.min(100, pct)}%`;
    this.el.bootsText.textContent = `${pct}%`;
  }

  /** The weapon in hand: name and ammo (gun = null for melee). */
  setWeapon(name: string, gun: { ammo: number; reserve: number; mag: number; thrown?: boolean } | null, reloading: boolean) {
    if (!this.changed("weapon", `${name}:${gun?.ammo}:${gun?.reserve}:${reloading}`)) return;
    this.el.weaponName.textContent = name;
    this.el.ammoLine.hidden = !gun;
    this.el.ammoLine.dataset.thrown = String(!!gun?.thrown);
    if (!gun) {
      this.el.ammoNote.textContent = name === "Fists" ? "Find a weapon!" : "Melee · click to swing";
      return;
    }
    if (gun.thrown) {
      // Grenades: just how many you have.
      this.el.ammo.textContent = `×${gun.ammo + gun.reserve}`;
      this.el.ammo.dataset.low = "false";
      this.el.ammoNote.textContent = "Click to throw";
      return;
    }
    this.el.ammo.textContent = String(gun.ammo);
    this.el.ammo.dataset.low = String(gun.ammo <= Math.ceil(gun.mag / 4));
    this.el.reserve.textContent = String(gun.reserve);
    this.el.ammoNote.textContent = reloading
      ? "Reloading…"
      : gun.ammo === 0 && gun.reserve === 0
        ? "Out of ammo: find ammo, or G to drop it"
        : gun.ammo === 0
          ? "Press R to reload"
          : "";
  }

  /** The weapon slots (null = hide, e.g. while dead). */
  setSlots(slots: SlotInfo[] | null) {
    const key = slots ? slots.map((s) => `${s.name}:${s.ammo}:${s.active}`).join("|") : "none";
    if (!this.changed("slots", key)) return;
    this.el.slots.hidden = !slots;
    if (!slots) return;
    this.el.slots.replaceChildren(
      ...slots.map((s, i) => {
        const li = document.createElement("li");
        li.classList.toggle("active", s.active);
        li.classList.toggle("empty", !s.name);
        const keyEl = document.createElement("span");
        keyEl.className = "key";
        keyEl.textContent = String(i + 1);
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = s.name || "Empty";
        li.append(keyEl, name);
        if (s.ammo) {
          const ammo = document.createElement("span");
          ammo.className = "slot-ammo";
          ammo.textContent = s.ammo;
          li.append(ammo);
        }
        return li;
      }),
    );
  }

  /** Hint like "E: swap your Rifle for the Sniper" (empty = hide). */
  setPrompt(text: string) {
    if (!this.changed("prompt", text)) return;
    this.el.prompt.textContent = text;
    this.el.prompt.hidden = !text;
  }

  setScoreboard(rows: ScoreRow[]) {
    // Team mode: Blue, then Red. Then still in the match first, then by kills. Spectators last.
    const group = (r: ScoreRow) => (r.spectator ? 3 : r.team === "blue" ? 0 : r.team === "red" ? 1 : 2);
    rows.sort(
      (a, b) =>
        group(a) - group(b) ||
        Number(a.out) - Number(b.out) ||
        b.kills - a.kills ||
        a.deaths - b.deaths ||
        a.name.localeCompare(b.name),
    );
    const key = rows.map((r) => `${r.name}:${r.kills}:${r.deaths}:${r.isMe}:${r.out}:${r.team}:${r.spectator}`).join("|");
    if (!this.changed("score", key)) return;

    this.el.score.replaceChildren(
      ...rows.map((r) => {
        const li = document.createElement("li");
        li.classList.toggle("me", r.isMe);
        li.classList.toggle("out", r.out);
        li.classList.toggle("spectator", !!r.spectator);
        if (r.team) li.dataset.team = r.team;
        const name = document.createElement("span");
        name.textContent = r.spectator ? `👁 ${r.name}` : r.name;
        const kd = document.createElement("span");
        kd.className = "kd";
        kd.textContent = r.spectator ? "watching" : `${r.kills} / ${r.deaths}`;
        li.append(name, kd);
        return li;
      }),
    );
  }

  /** Team mode score strip (null hides it, e.g. in solo mode). */
  setTeamScore(score: TeamScore | null) {
    const key = score ? `${score.blueKills}:${score.redKills}:${score.blueCore}:${score.redCore}:${score.myTeam}` : "none";
    if (!this.changed("teamScore", key)) return;
    this.el.teamScore.hidden = !score;
    if (!score) return;
    this.el.blueKills.textContent = String(score.blueKills);
    this.el.redKills.textContent = String(score.redKills);
    this.el.blueCore.style.width = `${Math.max(0, Math.min(1, score.blueCore) * 100)}%`;
    this.el.redCore.style.width = `${Math.max(0, Math.min(1, score.redCore) * 100)}%`;
    this.el.teamScore.dataset.mine = score.myTeam;
  }

  /** Start match / switch team / spectate-or-play buttons. */
  setRoomActions(a: RoomActions) {
    if (!this.changed("actions", `${a.start}:${a.team}:${a.spectate}`)) return;
    const set = (btn: HTMLButtonElement, label: string | null) => {
      btn.hidden = label === null;
      btn.textContent = label ?? "";
    };
    set(this.el.startMatch, a.start);
    set(this.el.switchTeam, a.team);
    set(this.el.toggleSpectate, a.spectate);
  }

  /** Spectators don't need health, ammo or weapon slots. */
  setSpectatorView(on: boolean) {
    if (!this.changed("spectatorView", on)) return;
    this.el.root.classList.toggle("spectator-view", on);
  }

  addKill(killer: string, victim: string, weapon = "") {
    const li = document.createElement("li");
    const k = document.createElement("b");
    k.textContent = killer;
    const v = document.createElement("b");
    v.textContent = victim;
    const w = document.createElement("span");
    w.className = "kill-weapon";
    w.textContent = weapon ? ` [${weapon}] ` : " ▸ ";
    li.append(k, w, v);
    this.el.feed.prepend(li);
    while (this.el.feed.children.length > 5) this.el.feed.lastElementChild?.remove();
    setTimeout(() => li.remove(), 5000);
  }

  /**
   * Match clock + zone countdown, e.g. "⏱ 2:13 · 👥 5 alive · Zone shrinks in 0:47". Each part
   * stays on one line (the line breaks between parts) and has a short form for small screens.
   */
  setZoneInfo(parts: ZonePart[], urgent: boolean) {
    if (!this.changed("zoneInfo", `${JSON.stringify(parts)}:${urgent}`)) return;
    this.el.zoneInfo.replaceChildren(
      ...parts.map((part) => {
        const [full, short] = typeof part === "string" ? [part, part] : part;
        const el = document.createElement("span");
        el.className = "zone-part";
        const f = document.createElement("span");
        f.className = "full";
        f.textContent = full;
        el.append(f);
        if (short !== full) {
          const s = document.createElement("span");
          s.className = "short";
          s.textContent = short;
          el.append(s);
        }
        return el;
      }),
    );
    this.el.zoneInfo.dataset.urgent = String(urgent);
  }

  /** Big center banner (match winner). Pass null to hide it. */
  setBanner(title: string | null, subtitle = "", gold = false) {
    if (!this.changed("banner", `${title}:${subtitle}:${gold}`)) return;
    this.el.banner.hidden = title === null;
    this.el.bannerTitle.textContent = title ?? "";
    this.el.bannerSub.textContent = subtitle;
    this.el.banner.classList.toggle("gold", gold);
  }

  /** Red flash around the screen edges when you get hurt. */
  hurtFlash() {
    const el = this.el.hurtFlash;
    el.classList.remove("show");
    void el.offsetWidth; // restart the CSS animation
    el.classList.add("show");
  }

  /** Slow red pulse around the screen edges while you're badly hurt. */
  setLowHealth(low: boolean) {
    if (!this.changed("lowHp", low)) return;
    this.el.lowHp.classList.toggle("show", low);
  }

  setOutsideZone(outside: boolean) {
    if (!this.changed("outside", outside)) return;
    this.el.zoneWarning.hidden = !outside;
  }

  /** "You died" panel (or with another `title`, the spectator panel). `spectating` is an extra line. */
  setDead(dead: boolean, message = "", spectating = "", title = "You died") {
    if (!this.changed("dead", `${dead}:${message}:${spectating}:${title}`)) return;
    this.el.death.hidden = !dead;
    this.el.deathTitle.textContent = title;
    this.el.death.classList.toggle("watching", title !== "You died");
    this.el.deathText.textContent = message;
    this.el.spectating.textContent = spectating;
    this.el.spectating.hidden = !spectating;
  }

  private changed(key: string, value: unknown): boolean {
    const s = String(value);
    if (this.last[key] === s) return false;
    this.last[key] = s;
    return true;
  }
}
