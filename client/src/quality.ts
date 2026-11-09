// Graphics quality: Low / Medium / High. Weaker devices (phones, old laptops) can trade
// eye candy for a smoother frame rate. The choice is remembered on this device.

export type Quality = "low" | "medium" | "high";

export interface QualitySettings {
  /** Map textures are baked at this many pixels per world pixel (sharper = more GPU memory). */
  mapResolution: number;
  /** Multiplier for particle counts (blood droplets, smoke, debris, sparks). */
  particles: number;
  /** Most blood stains kept on the ground at once (oldest fade first). */
  maxStains: number;
  /** Most world sounds allowed to start within 100 ms (gunfire storms choke weak audio). */
  soundsPer100ms: number;
}

export const QUALITY_SETTINGS: Record<Quality, QualitySettings> = {
  low: { mapResolution: 1, particles: 0.35, maxStains: 40, soundsPer100ms: 6 },
  medium: { mapResolution: 1.2, particles: 0.65, maxStains: 110, soundsPer100ms: 10 },
  high: { mapResolution: 1.4, particles: 1, maxStains: 220, soundsPer100ms: 16 },
};

export const QUALITY_LABEL: Record<Quality, string> = { low: "Low", medium: "Medium", high: "High" };

const STORAGE_KEY = "rivals.quality";
const ORDER: Quality[] = ["high", "medium", "low"];

function isQuality(v: unknown): v is Quality {
  return v === "low" || v === "medium" || v === "high";
}

/** First visit: touch devices and machines with few CPU cores start on Medium. */
function defaultQuality(): Quality {
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const cores = navigator.hardwareConcurrency || 8;
  return coarse || cores <= 4 ? "medium" : "high";
}

function load(): Quality {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isQuality(saved)) return saved;
  } catch {
    // storage blocked (private mode): fall through to the default
  }
  return defaultQuality();
}

let current: Quality = load();
const listeners = new Set<(q: Quality) => void>();

export function getQuality(): Quality {
  return current;
}

export function qualitySettings(): QualitySettings {
  return QUALITY_SETTINGS[current];
}

export function setQuality(q: Quality) {
  if (q === current) return;
  current = q;
  try {
    localStorage.setItem(STORAGE_KEY, q);
  } catch {
    // not saved, but still applies for this session
  }
  listeners.forEach((fn) => fn(q));
}

/** High → Medium → Low → High… */
export function cycleQuality(): Quality {
  setQuality(ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]);
  return current;
}

/** Called whenever the quality changes. Returns a function that stops listening. */
export function onQualityChange(fn: (q: Quality) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Scale a particle count by the current quality (at least `min`). */
export function particleCount(base: number, min = 1): number {
  return Math.max(min, Math.round(base * QUALITY_SETTINGS[current].particles));
}
