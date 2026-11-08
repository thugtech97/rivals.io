import { MAG_SIZE, PLAYER_MAX_HP } from "../../shared/constants";

// The in-game HTML overlay: health, ammo, scoreboard, kill feed and death screen.
// Each setter only touches the DOM when the value actually changed.

const $ = (id: string) => document.getElementById(id)!;

export interface ScoreRow {
  name: string;
  kills: number;
  deaths: number;
  isMe: boolean;
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
  };
  private last: Record<string, string> = {};

  show() {
    this.el.root.hidden = false;
    this.el.feed.replaceChildren();
    this.last = {};
  }

  hide() {
    this.el.root.hidden = true;
    this.el.death.hidden = true;
  }

  setHealth(hp: number) {
    if (!this.changed("hp", hp)) return;
    const pct = Math.max(0, hp / PLAYER_MAX_HP) * 100;
    this.el.hpFill.style.width = `${pct}%`;
    this.el.hpFill.dataset.level = pct > 50 ? "ok" : pct > 25 ? "warn" : "low";
    this.el.hpText.textContent = String(hp);
  }

  setAmmo(ammo: number, reserve: number, reloading: boolean) {
    if (!this.changed("ammo", `${ammo}/${reserve}/${reloading}`)) return;
    this.el.ammo.textContent = String(ammo);
    this.el.ammo.dataset.low = String(ammo <= Math.ceil(MAG_SIZE / 4));
    this.el.reserve.textContent = String(reserve);
    this.el.ammoNote.textContent = reloading
      ? "Reloading…"
      : ammo === 0 && reserve === 0
        ? "Out of ammo, find a crate!"
        : ammo === 0
          ? "Press R to reload"
          : "";
  }

  setScoreboard(rows: ScoreRow[]) {
    rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    const key = rows.map((r) => `${r.name}:${r.kills}:${r.deaths}:${r.isMe}`).join("|");
    if (!this.changed("score", key)) return;

    this.el.score.replaceChildren(
      ...rows.map((r) => {
        const li = document.createElement("li");
        if (r.isMe) li.className = "me";
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

  addKill(killer: string, victim: string) {
    const li = document.createElement("li");
    const k = document.createElement("b");
    k.textContent = killer;
    const v = document.createElement("b");
    v.textContent = victim;
    li.append(k, " ▸ ", v);
    this.el.feed.prepend(li);
    while (this.el.feed.children.length > 5) this.el.feed.lastElementChild?.remove();
    setTimeout(() => li.remove(), 5000);
  }

  setDead(dead: boolean, message = "") {
    if (!this.changed("dead", `${dead}:${message}`)) return;
    this.el.death.hidden = !dead;
    this.el.deathText.textContent = message;
  }

  private changed(key: string, value: unknown): boolean {
    const s = String(value);
    if (this.last[key] === s) return false;
    this.last[key] = s;
    return true;
  }
}
