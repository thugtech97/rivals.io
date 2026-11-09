// All game sounds, synthesized live with the Web Audio API (no audio files needed).
// World sounds take an (x, y): they get quieter with distance from the listener
// (your soldier, or whoever you're spectating) and pan left/right by direction.

const HEAR_FULL = 180; // px: full volume up to here...
const HEAR_MAX = 1300; // ...silent beyond this
const MUTE_KEY = "rivals:muted";

/** How each gun sounds: crack/body filter frequencies, thump pitch, length, loudness, how far it carries. */
const GUN_VOICES: Record<string, { crack: number; body: number; thump: number; decay: number; vol: number; reach: number }> = {
  pistol: { crack: 3200, body: 3000, thump: 180, decay: 0.09, vol: 0.75, reach: 0.9 },
  rifle: { crack: 2500, body: 2600, thump: 140, decay: 0.14, vol: 1, reach: 1 },
  mg: { crack: 2200, body: 2200, thump: 120, decay: 0.1, vol: 0.85, reach: 1.05 },
  sniper: { crack: 1800, body: 1800, thump: 80, decay: 0.32, vol: 1.25, reach: 1.6 },
  bazooka: { crack: 900, body: 1400, thump: 70, decay: 0.4, vol: 1.1, reach: 1.4 },
};

export class Sfx {
  private ctx: BaseAudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private listener = { x: 0, y: 0 };
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === "1";
    } catch {}
  }

  /** Browsers only allow audio after a click/key press: call this from one. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as any).webkitAudioContext;
      if (!AC) return;
      this.useContext(new AC());
    }
    if (this.ctx instanceof AudioContext && this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Use a specific audio context (also lets tests render sounds offline). */
  useContext(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    // A limiter that only kicks in when lots of sounds pile up (so they don't distort).
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.knee.value = 4;
    comp.ratio.value = 10;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    this.master.connect(comp).connect(ctx.destination);
    // One second of white noise, reused by every noisy sound.
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? "1" : "0");
    } catch {}
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.02);
    return this.muted;
  }

  /** Where "your ears" are in the world. */
  setListener(x: number, y: number) {
    this.listener.x = x;
    this.listener.y = y;
  }

  // ---------- Weapons ----------

  /** Each gun has its own voice: pistol pop, rifle crack, machine gun rattle, sniper boom. */
  gunshot(x: number, y: number, mine: boolean, weapon = "rifle") {
    const v = GUN_VOICES[weapon] ?? GUN_VOICES.rifle;
    const out = this.at(x, y, (mine ? 0.55 : 0.45) * v.vol, v.reach);
    if (!out) return;
    const { ctx, node, t } = out;
    // Sharp crack
    this.noiseHit(node, t, { type: "highpass", freq: v.crack, vol: 0.7, decay: 0.035 });
    // Body of the bang, darker the further away
    const far = this.distance(x, y) / (HEAR_MAX * v.reach);
    this.noiseHit(node, t, { type: "lowpass", freq: v.body - far * 1600, vol: 1, decay: v.decay, sweepTo: 300 });
    // Low thump
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(v.thump, t);
    osc.frequency.exponentialRampToValueAtTime(v.thump / 3, t + v.decay * 0.8);
    this.env(osc, node, t, 0.9, v.decay);
    // The sniper's shot rolls on for a moment
    if (weapon === "sniper") this.noiseHit(node, t + 0.06, { type: "lowpass", freq: 500, vol: 0.5, decay: 0.5, sweepTo: 150 });
    // The rocket's whoosh as it leaves the tube
    if (weapon === "bazooka") this.noiseHit(node, t + 0.03, { type: "bandpass", freq: 700, vol: 0.8, decay: 0.6, sweepTo: 2400 });
  }

  /** A rocket or grenade going off: a big boom that carries far. */
  explosion(x: number, y: number) {
    const out = this.at(x, y, 1, 2.2);
    if (!out) return;
    const { ctx, node, t } = out;
    const far = this.distance(x, y) / (HEAR_MAX * 2.2);
    this.noiseHit(node, t, { type: "highpass", freq: 1400, vol: 0.6 * (1 - far), decay: 0.1 }); // crack
    this.noiseHit(node, t, { type: "lowpass", freq: 2600 - far * 2000, vol: 1, decay: 1.1, sweepTo: 90 }); // blast
    this.noiseHit(node, t + 0.15, { type: "lowpass", freq: 400, vol: 0.5, decay: 1.2, sweepTo: 60 }); // rumble
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(95, t);
    osc.frequency.exponentialRampToValueAtTime(28, t + 0.7);
    this.env(osc, node, t, 1, 0.8);
  }

  /** Grenade thrown: a quick whoosh. */
  grenadeThrow(x: number, y: number) {
    const out = this.at(x, y, 0.25);
    if (!out) return;
    this.noiseHit(out.node, out.t, { type: "bandpass", freq: 700, vol: 1, decay: 0.16, sweepTo: 2000 });
  }

  /** Melee whoosh: shorter for a knife, heavier for an axe. */
  swing(x: number, y: number, weapon: string) {
    const out = this.at(x, y, weapon === "fists" ? 0.18 : 0.3);
    if (!out) return;
    const len = weapon === "knife" || weapon === "fists" ? 0.12 : weapon === "axe" ? 0.24 : 0.2;
    this.noiseHit(out.node, out.t, { type: "bandpass", freq: weapon === "axe" ? 500 : 900, vol: 1, decay: len, sweepTo: 2600 });
  }

  /** A blade / axe / fist connecting. */
  meleeHit(x: number, y: number, weapon: string) {
    const out = this.at(x, y, 0.55);
    if (!out) return;
    this.noiseHit(out.node, out.t, { type: "lowpass", freq: weapon === "axe" ? 350 : 550, vol: 1, decay: weapon === "axe" ? 0.16 : 0.1 });
    if (weapon === "knife" || weapon === "sword") {
      this.noiseHit(out.node, out.t, { type: "highpass", freq: 4000, vol: 0.35, decay: 0.05 }); // slice
    }
  }

  /** A vest stopping (part of) a hit: metallic tink. */
  armorHit(x: number, y: number) {
    const out = this.at(x, y, 0.3);
    if (!out) return;
    [2400, 3700].forEach((f) => {
      const osc = out.ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f;
      this.env(osc, out.node, out.t, 0.5, 0.09);
    });
  }

  /** Switching weapons: a gun rack-click, or a blade "shing". */
  equip(weapon: string) {
    const out = this.ui(0.3);
    if (!out) return;
    const { node, t } = out;
    if (weapon === "knife" || weapon === "sword" || weapon === "axe") {
      this.noiseHit(node, t, { type: "highpass", freq: 5000, vol: 0.6, decay: 0.18 });
    } else if (weapon) {
      this.noiseHit(node, t, { type: "highpass", freq: 2200, vol: 0.7, decay: 0.03 });
      this.noiseHit(node, t + 0.07, { type: "bandpass", freq: 1400, vol: 0.5, decay: 0.05 });
    } else {
      this.noiseHit(node, t, { type: "lowpass", freq: 600, vol: 0.4, decay: 0.05 }); // empty hands
    }
  }

  /** Mouse held with no ammo at all. */
  dryFire() {
    const out = this.ui(0.35);
    if (!out) return;
    this.noiseHit(out.node, out.t, { type: "highpass", freq: 3500, vol: 0.8, decay: 0.015 });
  }

  reloadStart() {
    const out = this.ui(0.4);
    if (!out) return;
    const { node, t } = out;
    this.noiseHit(node, t, { type: "highpass", freq: 3000, vol: 0.7, decay: 0.02 }); // mag release
    this.noiseHit(node, t + 0.12, { type: "bandpass", freq: 1200, vol: 0.5, decay: 0.12, sweepTo: 600 }); // mag out
  }

  reloadEnd() {
    const out = this.ui(0.45);
    if (!out) return;
    const { node, t } = out;
    this.noiseHit(node, t, { type: "bandpass", freq: 900, vol: 0.6, decay: 0.05 }); // mag in
    this.noiseHit(node, t + 0.11, { type: "highpass", freq: 2500, vol: 0.8, decay: 0.03 }); // charging handle
    this.noiseHit(node, t + 0.16, { type: "highpass", freq: 2000, vol: 0.6, decay: 0.03 });
  }

  // ---------- Impacts ----------

  /** Bullet hit a wall, car, tree… */
  impact(x: number, y: number) {
    const out = this.at(x, y, 0.25);
    if (!out) return;
    this.noiseHit(out.node, out.t, { type: "bandpass", freq: 1800 + Math.random() * 1500, vol: 1, decay: 0.05 });
  }

  /** Bullet hit a soldier. */
  fleshHit(x: number, y: number) {
    const out = this.at(x, y, 0.5);
    if (!out) return;
    this.noiseHit(out.node, out.t, { type: "lowpass", freq: 500, vol: 1, decay: 0.09 });
  }

  /** "Tick" confirming that YOUR bullet hit someone. */
  hitMarker() {
    const out = this.ui(0.18);
    if (!out) return;
    const osc = out.ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 1900;
    this.env(osc, out.node, out.t, 1, 0.05);
  }

  /** You lost HP. */
  hurt() {
    const out = this.ui(0.35);
    if (!out) return;
    const osc = out.ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(110, out.t);
    osc.frequency.exponentialRampToValueAtTime(60, out.t + 0.15);
    const lp = out.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 400;
    lp.connect(out.node);
    this.env(osc, lp, out.t, 0.8, 0.18);
  }

  death(x: number, y: number) {
    const out = this.at(x, y, 0.5);
    if (!out) return;
    const { ctx, node, t } = out;
    this.noiseHit(node, t, { type: "lowpass", freq: 700, vol: 0.9, decay: 0.3, sweepTo: 120 });
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.45);
    this.env(osc, node, t, 0.5, 0.5);
  }

  // ---------- Movement & items ----------

  footstep(x: number, y: number, mine: boolean) {
    const out = this.at(x, y, mine ? 0.22 : 0.16);
    if (!out) return;
    this.noiseHit(out.node, out.t, { type: "lowpass", freq: 380 + Math.random() * 260, vol: 1, decay: 0.07 });
    this.noiseHit(out.node, out.t + 0.01, { type: "bandpass", freq: 1800, vol: 0.12, decay: 0.03 }); // grit
  }

  /** Someone picked something up (kind: weapon | ammo | vest | medkit | boots). */
  pickup(x: number, y: number, mine: boolean, kind = "ammo") {
    const out = mine ? this.ui(0.5) : this.at(x, y, 0.35);
    if (!out) return;
    const { ctx, node, t } = out;
    if (kind === "vest") {
      this.noiseHit(node, t, { type: "lowpass", freq: 700, vol: 0.8, decay: 0.12 }); // heavy fabric / plate
      this.noiseHit(node, t + 0.1, { type: "bandpass", freq: 1500, vol: 0.5, decay: 0.08 }); // velcro
    } else if (kind === "medkit") {
      this.noiseHit(node, t, { type: "bandpass", freq: 3000, vol: 0.4, decay: 0.08 }); // bandage rip
    } else if (kind === "boots") {
      this.noiseHit(node, t, { type: "lowpass", freq: 1200, vol: 0.6, decay: 0.06 }); // laces pulled
      this.noiseHit(node, t + 0.06, { type: "bandpass", freq: 1800, vol: 0.4, decay: 0.05 });
    } else {
      this.noiseHit(node, t, { type: "highpass", freq: 2200, vol: 0.7, decay: 0.03 }); // clack
      this.noiseHit(node, t + 0.07, { type: "highpass", freq: 2600, vol: 0.6, decay: 0.03 });
    }
    if (!mine) return;
    // Little chime for your own pickup (a soft rising "heal" for medkits)
    const notes = kind === "medkit" ? [523, 659, 784] : kind === "boots" ? [587, 880, 1175] : [660, 990];
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = kind === "medkit" ? "sine" : "triangle";
      osc.frequency.value = f;
      this.env(osc, node, t + 0.08 + i * 0.07, 0.35, kind === "medkit" ? 0.3 : 0.16);
    });
  }

  // ---------- Match ----------

  countdownBeep(final: boolean) {
    const out = this.ui(final ? 0.6 : 0.45);
    if (!out) return;
    const osc = out.ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = final ? 1320 : 880;
    this.env(osc, out.node, out.t, 0.4, final ? 0.45 : 0.15);
  }

  win() {
    this.melody([523, 659, 784, 1047], 0.13, "triangle", 0.4);
  }

  lose() {
    this.melody([392, 330, 262], 0.18, "triangle", 0.35);
  }

  // ---------- Building blocks ----------

  /** A world sound at (x, y): returns where to connect it, or null if muted / too far. */
  private at(x: number, y: number, vol: number, reach = 1) {
    if (!this.ctx || this.muted) return null;
    const d = this.distance(x, y);
    const max = HEAR_MAX * reach; // loud things (a sniper) carry further
    if (d >= max) return null;
    const fall = d <= HEAR_FULL ? 1 : 1 - (d - HEAR_FULL) / (max - HEAR_FULL);
    const g = this.ctx.createGain();
    g.gain.value = vol * fall * fall;
    if ("createStereoPanner" in this.ctx) {
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, (x - this.listener.x) / 700));
      g.connect(pan).connect(this.master);
    } else {
      g.connect(this.master);
    }
    return { ctx: this.ctx, node: g as AudioNode, t: this.ctx.currentTime };
  }

  /** A sound "in your head" (UI / your own gear): no distance, no panning. */
  private ui(vol: number) {
    if (!this.ctx || this.muted) return null;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    g.connect(this.master);
    return { ctx: this.ctx, node: g as AudioNode, t: this.ctx.currentTime };
  }

  private distance(x: number, y: number) {
    return Math.hypot(x - this.listener.x, y - this.listener.y);
  }

  /** Filtered noise with a fast attack and exponential decay. */
  private noiseHit(
    dest: AudioNode,
    t: number,
    o: { type: BiquadFilterType; freq: number; vol: number; decay: number; sweepTo?: number },
  ) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = o.type;
    filter.frequency.setValueAtTime(o.freq, t);
    if (o.sweepTo) filter.frequency.exponentialRampToValueAtTime(o.sweepTo, t + o.decay);
    // Filtering white noise down to a narrow/low band throws away most of its energy,
    // so boost it back: otherwise low thuds (footsteps) come out nearly silent.
    const boost = o.type === "highpass" ? 1 : Math.min(7, Math.sqrt(11025 / o.freq));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.vol * boost, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.decay);
    src.connect(filter).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + o.decay + 0.02);
  }

  /** Play an oscillator with a quick attack and exponential decay. */
  private env(osc: OscillatorNode, dest: AudioNode, t: number, vol: number, decay: number) {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + decay + 0.02);
  }

  private melody(notes: number[], step: number, type: OscillatorType, vol: number) {
    const out = this.ui(vol);
    if (!out) return;
    notes.forEach((f, i) => {
      const osc = out.ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = f;
      this.env(osc, out.node, out.t + i * step, 0.8, i === notes.length - 1 ? 0.6 : step * 1.6);
    });
  }
}

/** The game's one sound player. */
export const sfx = new Sfx();

// Dev builds only: reachable from the browser console as window.__sfx (handy for testing sounds).
if (import.meta.env.DEV) (window as any).__sfx = sfx;
