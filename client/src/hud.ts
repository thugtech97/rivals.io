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
    weaponName: $("weapon-name"),
    ammoLine: $("ammo-line"),
    slots: $("weapon-slots"),
    prompt: $("pickup-prompt"),
  };
  private last: Record<string, string> = {};
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

  /** The weapon in hand: name and ammo (gun = null for melee). */
  setWeapon(name: string, gun: { ammo: number; reserve: number; mag: number } | null, reloading: boolean) {
    if (!this.changed("weapon", `${name}:${gun?.ammo}:${gun?.reserve}:${reloading}`)) return;
    this.el.weaponName.textContent = name;
    this.el.ammoLine.hidden = !gun;
    if (!gun) {
      this.el.ammoNote.textContent = name === "Fists" ? "Find a weapon!" : "Melee · click to swing";
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

  /** The three weapon slots (null = hide, e.g. while dead). */
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
    // Still in the match first, then by kills.
    rows.sort((a, b) => Number(a.out) - Number(b.out) || b.kills - a.kills || a.deaths - b.deaths);
    const key = rows.map((r) => `${r.name}:${r.kills}:${r.deaths}:${r.isMe}:${r.out}`).join("|");
    if (!this.changed("score", key)) return;

    this.el.score.replaceChildren(
      ...rows.map((r) => {
        const li = document.createElement("li");
        li.classList.toggle("me", r.isMe);
        li.classList.toggle("out", r.out);
        const name = document.createElement("span");
        name.textContent = r.name;
        const kd = document.createElement("span");
        kd.className = "kd";
        kd.textContent = `${r.kills} / ${r.deaths}`;
        li.append(name, kd);
        return li;
      }),
    );
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

  /** Match clock + zone countdown, e.g. "02:13 · Zone appears in 0:47". */
  setZoneInfo(text: string, urgent: boolean) {
    if (!this.changed("zoneInfo", `${text}:${urgent}`)) return;
    this.el.zoneInfo.textContent = text;
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

  /** "You died" panel. `spectating` is an extra line shown while watching other players. */
  setDead(dead: boolean, message = "", spectating = "") {
    if (!this.changed("dead", `${dead}:${message}:${spectating}`)) return;
    this.el.death.hidden = !dead;
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
