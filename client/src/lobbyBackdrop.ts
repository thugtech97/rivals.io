import Phaser from "phaser";
import { ARENA_SIZE } from "../../shared/constants";
import { GameMap, newMapSeed } from "../../shared/map";
import { renderMap } from "./mapRender";

// The lobby's background: a real random game map, slowly drifting under a blur
// (the blur and darkening are CSS on #lobby-bg). Runs only while the lobby is shown.

/** Lower than in-game: it's blurred anyway, so save GPU memory. */
const BACKDROP_RESOLUTION = 0.7;
const BACKDROP_ZOOM = 0.8;
/** Seconds per slow pan from one spot to the next. */
const PAN_SECONDS = 28;

class BackdropScene extends Phaser.Scene {
  private focus = { x: ARENA_SIZE / 2, y: ARENA_SIZE / 2 };

  constructor() {
    super("backdrop");
  }

  create() {
    const map = new GameMap(newMapSeed());
    renderMap(this, map, BACKDROP_RESOLUTION);

    const cam = this.cameras.main;
    cam.setBackgroundColor("#0b0d12");
    cam.setZoom(BACKDROP_ZOOM);
    cam.setBounds(0, 0, ARENA_SIZE, ARENA_SIZE);
    this.focus = this.randomSpot();
    cam.centerOn(this.focus.x, this.focus.y);
    this.panToNext();
  }

  update() {
    this.cameras.main.centerOn(this.focus.x, this.focus.y);
  }

  /** Drift to a random spot, then pick another, forever. */
  private panToNext() {
    const to = this.randomSpot();
    this.tweens.add({
      targets: this.focus,
      x: to.x,
      y: to.y,
      duration: PAN_SECONDS * 1000,
      ease: "Sine.easeInOut",
      onComplete: () => this.panToNext(),
    });
  }

  private randomSpot() {
    const m = 500;
    return { x: m + Math.random() * (ARENA_SIZE - m * 2), y: m + Math.random() * (ARENA_SIZE - m * 2) };
  }
}

let backdrop: Phaser.Game | undefined;

export function startLobbyBackdrop() {
  if (backdrop) return;
  backdrop = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "lobby-bg",
    backgroundColor: "#0b0d12",
    scale: { mode: Phaser.Scale.RESIZE, width: "100%", height: "100%" },
    input: false, // purely decorative: no mouse/keyboard handling
    audio: { noAudio: true },
    banner: false,
    scene: [BackdropScene],
  });
}

/** Free the GPU for the real game. */
export function stopLobbyBackdrop() {
  backdrop?.destroy(true);
  backdrop = undefined;
}
