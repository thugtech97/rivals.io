import Phaser from "phaser";
import type { Room } from "@colyseus/sdk";
import { client, SERVER_URL, type RoomListing } from "./network";
import { GameScene, type GameSceneData } from "./GameScene";
import { Hud } from "./hud";
import { sfx } from "./sound";
import { startLobbyBackdrop, stopLobbyBackdrop } from "./lobbyBackdrop";
import { TouchControls } from "./touchControls";
import { cycleQuality, getQuality, onQualityChange, QUALITY_LABEL, type Quality } from "./quality";
import { ARENA_ROOM, IDLE_KICK_CODE, LOBBY_ROOM } from "../../shared/constants";
import { MAX_SPECTATORS } from "../../shared/teams";
import { BOT_LEVEL_NAME, DEFAULT_PRACTICE_SIZE, isBotLevel, PRACTICE_SIZES, type BotLevel } from "../../shared/practice";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  lobby: $("lobby"),
  shade: $("lobby-shade"),
  name: $<HTMLInputElement>("player-name"),
  quickPlay: $<HTMLButtonElement>("quick-play"),
  status: $("lobby-status"),
  roomList: $<HTMLUListElement>("room-list"),
  error: $("lobby-error"),
  hud: $("hud"),
  hudRoom: $("hud-room"),
  hudPlayers: $("hud-players"),
  leave: $<HTMLButtonElement>("leave"),
  mute: $<HTMLButtonElement>("mute"),
  quality: $<HTMLButtonElement>("quality"),
  helpBtn: $<HTMLButtonElement>("help"),
  help: $("controls-help"),
  fullscreen: $<HTMLButtonElement>("fullscreen"),
  rotateGo: $<HTMLButtonElement>("rotate-go"),
  rotateIos: $("rotate-ios"),
  rotateSkip: $<HTMLButtonElement>("rotate-skip"),
  loader: $("loader"),
  loaderText: $("loader-text"),
  loaderSub: $("loader-sub"),
};

const hud = new Hud();
const touch = new TouchControls();

// ---------- Loading spinner ----------

function showLoader(text: string, sub = "") {
  ui.loaderText.textContent = text;
  ui.loaderSub.textContent = sub;
  ui.loader.hidden = false;
}
function hideLoader() {
  ui.loader.hidden = true;
}

// ---------- Fullscreen (toolbar button; phones also lock to landscape) ----------

/** Fullscreen, and (on Android) lock to landscape. iPhone browsers don't allow either. */
async function goFullscreenLandscape() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    await (screen.orientation as any)?.lock?.("landscape").catch(() => {});
  } catch {
    /* not supported (e.g. iPhone Safari) */
  }
}

ui.fullscreen.onclick = async () => {
  ui.fullscreen.blur();
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  else await goFullscreenLandscape();
};

/** When fullscreen last ended: the Esc that exits fullscreen must not also leave the room. */
let fullscreenEndedAt = 0;
function showFullscreen() {
  const on = !!document.fullscreenElement;
  if (!on) fullscreenEndedAt = performance.now();
  ui.fullscreen.title = on ? "Exit fullscreen" : "Fullscreen";
  ui.fullscreen.classList.toggle("on", on); // highlighted while on
}
document.addEventListener("fullscreenchange", showFullscreen);

// "Turn your phone sideways" screen (shown by CSS in portrait during a game)
const canFullscreen = typeof document.documentElement.requestFullscreen === "function";
ui.fullscreen.hidden = !canFullscreen; // iPhone Safari has no fullscreen for websites
ui.rotateGo.hidden = !canFullscreen; // iPhone: no fullscreen / rotation lock for websites…
ui.rotateIos.hidden = canFullscreen; // …so explain how to rotate instead
ui.rotateGo.onclick = () => goFullscreenLandscape();
ui.rotateSkip.onclick = () => document.body.classList.add("portrait-ok");

let lobbyRoom: Room | undefined;
let gameRoom: Room | undefined;
let game: Phaser.Game | undefined;
let rooms: RoomListing[] = [];
let busy = false;

// ---------- Player name (remembered in this browser) ----------

try {
  ui.name.value = localStorage.getItem("rivals:name") ?? "";
} catch {}

function playerName(): string {
  const name = ui.name.value.trim() || `Player${Math.floor(Math.random() * 1000)}`;
  try {
    localStorage.setItem("rivals:name", ui.name.value.trim());
  } catch {}
  return name;
}

// ---------- Lobby: live room list ----------

function setStatus(state: "connecting" | "live" | "offline" | "paused", text: string) {
  ui.status.dataset.state = state;
  ui.status.textContent = text;
}

async function connectLobby() {
  if (lobbyPaused) return;
  setStatus("connecting", "Connecting…");
  renderRooms(); // shows the spinner until the list arrives
  try {
    lobbyRoom = await client.joinOrCreate(LOBBY_ROOM, { filter: { name: ARENA_ROOM } });
  } catch (err) {
    setStatus("offline", "Offline");
    renderRooms();
    showError(`Can't reach the game server at ${SERVER_URL}. Is it running? Retrying…`);
    setTimeout(connectLobby, 3000);
    return;
  }
  // Went idle while we were connecting: hang up straight away.
  if (lobbyPaused) {
    const r = lobbyRoom;
    lobbyRoom = undefined;
    r.leave().catch(() => {});
    return;
  }
  hideError();
  setStatus("live", "Live");

  // Full list on join, then incremental updates.
  lobbyRoom.onMessage("rooms", (list: RoomListing[]) => {
    rooms = list;
    renderRooms();
  });
  lobbyRoom.onMessage("+", ([roomId, room]: [string, RoomListing]) => {
    const i = rooms.findIndex((r) => r.roomId === roomId);
    if (i === -1) rooms.push(room);
    else rooms[i] = room;
    renderRooms();
  });
  lobbyRoom.onMessage("-", (roomId: string) => {
    rooms = rooms.filter((r) => r.roomId !== roomId);
    renderRooms();
  });
  lobbyRoom.onLeave(() => {
    lobbyRoom = undefined;
    // Unexpected disconnect (e.g. server restart) while still in the lobby: reconnect.
    if (!gameRoom && !busy && !lobbyPaused) setTimeout(connectLobby, 1000);
  });
}

// ---------- Idle lobby: hang up so the server can sleep ----------
//
// The Fly.io machine only sleeps when nobody is connected. A lobby left open in a
// forgotten tab would keep it awake (and billed), so we disconnect it when idle and
// reconnect as soon as the player is back. Games in progress are never touched.

const devParam = (name: string) => (import.meta.env.DEV ? Number(new URLSearchParams(location.search).get(name)) : 0);
/** No mouse/keyboard for this long → pause. (?lobbyIdle=seconds in dev, for testing) */
const LOBBY_IDLE_MS = (devParam("lobbyIdle") || 5 * 60) * 1000;
/** Tab in the background for this long → pause. (?lobbyHidden=seconds in dev) */
const LOBBY_HIDDEN_MS = (devParam("lobbyHidden") || 2 * 60) * 1000;

let lobbyPaused = false;
let lastActivity = Date.now();
let hiddenSince = document.hidden ? Date.now() : 0;

function markActive() {
  lastActivity = Date.now();
  if (lobbyPaused && !document.hidden) resumeLobby();
}
for (const ev of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) {
  window.addEventListener(ev, markActive, { passive: true });
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hiddenSince = Date.now();
  else {
    hiddenSince = 0;
    markActive();
  }
});

setInterval(
  () => {
    if (gameRoom || busy || lobbyPaused || ui.lobby.hidden) return;
    const now = Date.now();
    const idle = now - lastActivity >= LOBBY_IDLE_MS;
    const hiddenTooLong = document.hidden && hiddenSince > 0 && now - hiddenSince >= LOBBY_HIDDEN_MS;
    if (idle || hiddenTooLong) pauseLobby();
  },
  Math.min(15_000, LOBBY_HIDDEN_MS / 2, LOBBY_IDLE_MS / 2),
);

function pauseLobby() {
  lobbyPaused = true;
  const r = lobbyRoom;
  lobbyRoom = undefined;
  r?.leave().catch(() => {});
  stopLobbyBackdrop(); // the animated map isn't needed while nobody is looking
  setStatus("paused", "Paused");
  rooms = [];
  renderRooms();
}

function resumeLobby() {
  lobbyPaused = false;
  lastActivity = Date.now();
  startLobbyBackdrop();
  connectLobby();
}

// Dev builds only: lets tests check whether the lobby is connected.
if (import.meta.env.DEV) (window as any).__lobbyConnected = () => !!lobbyRoom;

function renderRooms() {
  // The menu's "Rooms" button shows how many rooms you could join right now.
  const open = rooms.filter((r) => roomState(r) === "open").length;
  $("rooms-count").textContent = open ? String(open) : "";
  ui.roomList.replaceChildren();
  if (lobbyRoom) setStatus("live", rooms.length ? `Live · ${rooms.length} room${rooms.length === 1 ? "" : "s"}` : "Live");
  if (lobbyPaused) {
    const note = document.createElement("li");
    note.className = "room-empty";
    const title = document.createElement("b");
    title.textContent = "Paused while you were away";
    note.append(title, "Move the mouse or press a key to see live rooms again.");
    ui.roomList.append(note);
    return;
  }
  // Still connecting (or retrying): spinner instead of "no rooms".
  const waiting = !lobbyRoom && (ui.status.dataset.state === "connecting" || ui.status.dataset.state === "offline");
  if (waiting && rooms.length === 0) {
    const li = document.createElement("li");
    li.className = "room-empty";
    const spin = document.createElement("span");
    spin.className = "mini-spinner";
    const text = document.createElement("span");
    text.textContent = ui.status.dataset.state === "offline" ? "Can't reach the server, retrying…" : "Connecting to the server…";
    li.append(spin, text);
    ui.roomList.append(li);
    return;
  }
  if (rooms.length === 0) {
    const empty = document.createElement("li");
    empty.className = "room-empty";
    const title = document.createElement("b");
    title.textContent = "No rooms yet";
    empty.append(title, "Create one, or hit Quick play to start your own.");
    ui.roomList.append(empty);
    return;
  }

  for (const room of rooms) {
    const state = roomState(room);
    const m = room.metadata;
    const teams = m?.mode === "teams";
    const players = m?.players ?? room.clients;
    const maxPlayers = m?.maxPlayers ?? room.maxClients;
    const li = document.createElement("li");
    li.className = "room";

    const info = document.createElement("div");
    info.className = "room-info";
    const name = document.createElement("div");
    name.className = "room-name";
    name.textContent = room.metadata?.roomName ?? room.roomId;
    const host = document.createElement("div");
    host.className = "room-host";
    const mode = document.createElement("span");
    mode.className = `mode-tag ${teams ? "mode-teams" : "mode-solo"}`;
    const side = Math.ceil(maxPlayers / 2);
    mode.textContent = teams ? `⚔️ Teams ${side}v${side}` : "🏆 Solo";
    host.append(mode, ` Host: ${m?.hostName ?? "?"}`);
    info.append(name, host);

    // Player count, a little fill bar, and an Open / In game / Full badge
    const meta = document.createElement("div");
    meta.className = "room-meta";
    const count = document.createElement("span");
    count.className = "room-count";
    count.textContent = `👥 ${players}/${maxPlayers}` + (m?.spectators ? ` · 👁 ${m.spectators}` : "");
    const fill = document.createElement("div");
    fill.className = "room-fill";
    const bar = document.createElement("span");
    bar.style.width = `${Math.min(100, (players / Math.max(1, maxPlayers)) * 100)}%`;
    fill.append(bar);
    const badge = document.createElement("span");
    badge.className = `badge badge-${state}`;
    badge.textContent = state === "full" ? "Full" : state === "ingame" ? "In game" : "Open";
    meta.append(count, fill, badge);

    const join = document.createElement("button");
    join.className = state === "open" ? "btn btn-small btn-secondary" : "btn btn-small";
    join.textContent = "Join";
    join.disabled = state !== "open";
    join.onclick = () =>
      enterGame(() => client.joinById(room.roomId, { playerName: playerName() }), {
        button: join,
        text: `Joining ${room.metadata?.roomName ?? "room"}…`,
      });

    // Watch: always possible (even mid-match) while there are spectator seats.
    const watch = document.createElement("button");
    watch.className = "btn btn-small btn-watch";
    watch.textContent = "👁 Watch";
    watch.title = "Spectate this room";
    watch.disabled = (m?.spectators ?? 0) >= MAX_SPECTATORS;
    watch.onclick = () =>
      enterGame(() => client.joinById(room.roomId, { playerName: playerName(), spectate: true }), {
        button: watch,
        text: `Watching ${room.metadata?.roomName ?? "room"}…`,
      });

    const buttons = document.createElement("div");
    buttons.className = "room-buttons";
    buttons.append(join, watch);
    li.append(info, meta, buttons);
    ui.roomList.append(li);
  }
}

// ---------- Creating / joining a game room ----------

/**
 * Open = you can play in it now. Rooms are never locked (so spectators can always get in):
 * a room that's mid-match or has no playing seats left shows as "In game" / "Full".
 */
function roomState(room: RoomListing): "open" | "ingame" | "full" {
  const m = room.metadata;
  const phase = m?.phase ?? (room.locked ? "live" : "warmup");
  if (phase === "live" || phase === "ended") return "ingame";
  const full = m?.players !== undefined && m.maxPlayers !== undefined ? m.players >= m.maxPlayers : room.clients >= room.maxClients;
  return full ? "full" : "open";
}

/** Quick play: the fullest open room (it starts sooner), else a fresh one of our own. */
async function quickPlay(): Promise<Room> {
  const name = playerName();
  const open = rooms
    .filter((r) => roomState(r) === "open")
    .sort((a, b) => (b.metadata?.players ?? b.clients) - (a.metadata?.players ?? a.clients));
  for (const room of open) {
    try {
      return await client.joinById(room.roomId, { playerName: name });
    } catch {
      // Filled up or started a moment ago: try the next one.
    }
  }
  return client.create(ARENA_ROOM, { playerName: name });
}

ui.quickPlay.onclick = () => enterGame(quickPlay, { button: ui.quickPlay, text: "Finding a match…" });

// ---------- New room / Practice vs bots (one card, a toggle picks which) ----------
//
// Both share Mode and Size. A new room is online (others can join from the list); a practice
// room is private and the server fills every free seat with bots.

const setup = {
  form: $<HTMLFormElement>("setup-form"),
  roomName: $<HTMLInputElement>("room-name"),
  sizes: $("sizes"),
  sizeLabel: $("size-label"),
  note: $("setup-note"),
  go: $<HTMLButtonElement>("setup-go"),
};
const ROOM_SIZES = [2, 4, 8, 10, 16];
const checkedValue = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value;
const isPractice = () => checkedValue("setup") === "practice";
const isTeams = () => checkedValue("mode") === "teams";

/** Last choices (remembered in this browser). Practice and rooms each keep their own size. */
const saved = (() => {
  const d = { mode: "solo", level: "medium", roomSize: 8, practiceSize: DEFAULT_PRACTICE_SIZE as number };
  try {
    const s = JSON.parse(localStorage.getItem("rivals:setup") ?? "{}");
    return {
      mode: s.mode === "teams" ? "teams" : "solo",
      level: isBotLevel(s.level) ? (s.level as string) : d.level,
      roomSize: ROOM_SIZES.includes(s.roomSize) ? (s.roomSize as number) : d.roomSize,
      practiceSize: (PRACTICE_SIZES as readonly number[]).includes(s.practiceSize) ? (s.practiceSize as number) : d.practiceSize,
    };
  } catch {
    return d;
  }
})();

function rememberSetup() {
  const size = Number(checkedValue("size"));
  if (isPractice()) saved.practiceSize = size || saved.practiceSize;
  else saved.roomSize = size || saved.roomSize;
  saved.mode = isTeams() ? "teams" : "solo";
  saved.level = checkedValue("level") ?? saved.level;
  try {
    localStorage.setItem("rivals:setup", JSON.stringify(saved));
  } catch {}
}

/** Show the fields for the current choice, the size buttons (1v1… in teams) and a one-line summary. */
function renderSetup() {
  const practice = isPractice();
  const teams = isTeams();
  for (const el of setup.form.querySelectorAll<HTMLElement>("[data-for]")) el.hidden = el.dataset.for !== (practice ? "practice" : "room");
  const list: number[] = practice ? [...PRACTICE_SIZES] : ROOM_SIZES;
  const fallback = practice ? saved.practiceSize : saved.roomSize;
  const selected = Number(checkedValue("size")) || fallback;
  const pick = list.includes(selected) ? selected : fallback;
  setup.sizeLabel.textContent = teams ? "Team size" : "Players";
  setup.sizes.replaceChildren(
    ...list.map((n) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "size";
      input.value = String(n);
      input.checked = n === pick;
      input.onchange = () => showSetupNote();
      const text = document.createElement("span");
      text.textContent = teams ? `${n / 2}v${n / 2}` : String(n);
      label.append(input, text);
      return label;
    }),
  );
  setup.go.textContent = practice ? "🤖 Start practice" : "Create & join";
  showSetupNote();
}

function showSetupNote() {
  const n = Number(checkedValue("size")) || 2;
  const teams = isTeams();
  if (!isPractice()) {
    setup.note.textContent = teams
      ? "Blue vs Red. Respawn at your base, destroy the enemy's core to win."
      : "Last soldier standing. The zone closes in.";
    return;
  }
  const level = (BOT_LEVEL_NAME[(checkedValue("level") ?? "medium") as BotLevel] ?? "Medium").toLowerCase();
  const bots = (k: number) => `${k} ${level} bot${k === 1 ? "" : "s"}`;
  setup.note.textContent = teams
    ? n === 2
      ? `You vs ${bots(1)}, base against base. Private, just for you.`
      : `You + ${n / 2 - 1} bot${n / 2 === 2 ? "" : "s"} vs ${bots(n / 2)}. Private, just for you.`
    : `You vs ${bots(n - 1)}, last soldier standing. Private, just for you.`;
}

for (const [name, value] of [["mode", saved.mode], ["level", saved.level]] as const) {
  for (const r of document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
    r.checked = r.value === value;
    r.onchange = () => renderSetup();
  }
}

/** Create room and Practice share the form: switch it over (each remembers its own size). */
function setSetupKind(kind: "room" | "practice") {
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="setup"]')) r.checked = r.value === kind;
  document.querySelectorAll<HTMLInputElement>('input[name="size"]').forEach((s) => (s.checked = false));
  $("setup-title").textContent = kind === "practice" ? "Practice vs bots" : "Create a room";
  renderSetup();
}
setSetupKind("room");

// ---------- Lobby pages ----------
//
// The menu is on the left, the panel on its right (below it on narrow screens). The panel
// shows How to play unless a menu button picked something else: #practice, #create, #rooms
// (URL hashes, so the browser's Back button works, and links to them do).

const PAGES: Record<string, { panel: string; init?: () => void }> = {
  practice: { panel: "setup", init: () => setSetupKind("practice") },
  create: { panel: "setup", init: () => setSetupKind("room") },
  rooms: { panel: "rooms" },
  help: { panel: "help" },
};
const lobbyPages = $("lobby-pages");
const menuButtons: Record<string, HTMLElement> = {
  practice: $("open-practice"),
  create: $("open-create"),
  rooms: $("open-rooms"),
  help: $("open-help"),
};
/** True once we've opened a page ourselves (then ← can simply go back in history). */
let pageOpenedHere = false;

function showPage() {
  const name = PAGES[location.hash.slice(1)] ? location.hash.slice(1) : "help";
  const page = PAGES[name];
  for (const [n, b] of Object.entries(menuButtons)) b.classList.toggle("active", n === name);
  for (const el of lobbyPages.querySelectorAll<HTMLElement>("[data-panel]")) el.hidden = el.dataset.panel !== page.panel;
  page.init?.();
  if (!location.hash) pageOpenedHere = false;
}

function openPage(name: string) {
  // Narrow screens: the panel is under the menu, so bring it into view.
  if (matchMedia("(max-width: 820px)").matches) lobbyPages.scrollIntoView({ behavior: "smooth", block: "start" });
  const current = location.hash.slice(1) || "help";
  if (current === name) return;
  if (name === "help") return backToMenu(); // the default page: no hash
  // Switching pages replaces the entry, so Back returns to How to play instead of stepping through them.
  if (PAGES[location.hash.slice(1)]) {
    history.replaceState(null, "", `#${name}`);
    showPage();
    return;
  }
  pageOpenedHere = true;
  location.hash = name;
}

function backToMenu() {
  if (pageOpenedHere) history.back();
  else history.replaceState(null, "", location.pathname + location.search);
  showPage();
}

window.addEventListener("hashchange", showPage);
$("open-practice").onclick = () => openPage("practice");
$("open-create").onclick = () => openPage("create");
$("open-rooms").onclick = () => openPage("rooms");
$("open-help").onclick = () => openPage("help");
showPage();

setup.form.onsubmit = (e) => {
  e.preventDefault();
  rememberSetup();
  const practice = isPractice();
  const options = {
    playerName: playerName(),
    mode: isTeams() ? "teams" : "solo",
    maxPlayers: Number(checkedValue("size")) || (practice ? DEFAULT_PRACTICE_SIZE : 8),
    ...(practice ? { practice: checkedValue("level") ?? "medium" } : { roomName: setup.roomName.value.trim() }),
  };
  enterGame(() => client.create(ARENA_ROOM, options), {
    button: setup.go,
    text: practice ? "Setting up the bots…" : "Creating your room…",
  });
};

async function enterGame(connect: () => Promise<Room>, loading: { button: HTMLButtonElement; text: string }) {
  if (busy || gameRoom) return;
  sfx.unlock(); // browsers only allow sound after a click: this is that click
  busy = true;
  hideError();
  loading.button.classList.add("loading");
  showLoader(loading.text);
  // A sleeping Fly.io server takes a few seconds to wake up: say so instead of looking stuck.
  const slow = setTimeout(() => showLoader(loading.text, "Waking up the server, this can take a few seconds…"), 2500);
  try {
    gameRoom = await connect();
    // Dev builds only: the room is reachable from the console as window.__room (handy for testing).
    if (import.meta.env.DEV) (window as any).__room = gameRoom;
  } catch (err) {
    clearTimeout(slow);
    hideLoader();
    loading.button.classList.remove("loading");
    showError(`Couldn't join: ${err instanceof Error ? err.message : String(err)}`);
    busy = false;
    return;
  }
  clearTimeout(slow);
  loading.button.classList.remove("loading");
  showLoader("Building the map…");

  // Leave the lobby while playing; we rejoin it when we come back.
  await lobbyRoom?.leave().catch(() => {});
  lobbyRoom = undefined;
  busy = false;

  ui.hudRoom.textContent = "";
  ui.hudPlayers.textContent = "";
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  showPage(); // back in the lobby later: start on the menu
  ui.lobby.hidden = true;
  ui.shade.hidden = true;
  stopLobbyBackdrop();
  ui.hud.hidden = false;
  showHelpFor(8000); // show the controls for a few seconds, then H / ? brings them back

  game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    backgroundColor: "#0b0d12",
    scale: { mode: Phaser.Scale.RESIZE, width: "100%", height: "100%" },
  });
  const sceneData: GameSceneData = {
    room: gameRoom,
    hud,
    onRoomName: (name) => (ui.hudRoom.textContent = name),
    onPlayerCount: (n, watching) =>
      (ui.hudPlayers.textContent = `${n} player${n === 1 ? "" : "s"}` + (watching ? ` · 👁 ${watching} watching` : "")),
    onMuteToggle: showMute,
    touch,
    onReady: hideLoader,
  };
  game.scene.add("game", GameScene, true, sceneData);
  document.body.classList.add("in-game");

  gameRoom.onLeave((code) => backToLobby(code));
}

function backToLobby(code?: number) {
  game?.destroy(true);
  game = undefined;
  gameRoom = undefined;
  hideLoader();
  touch.setShown(false);
  document.body.classList.remove("in-game");
  hud.hide();
  ui.hud.hidden = true;
  setHelp(false);
  ui.lobby.hidden = false;
  ui.shade.hidden = false;
  startLobbyBackdrop();
  // 1000 = we left on purpose; anything else means we were disconnected.
  if (code === IDLE_KICK_CODE) showError("You were away for 10 minutes, so you left the room. Jump back in anytime!");
  else if (code !== undefined && code !== 1000) showError("Lost connection to the room (the server may have restarted). Please join again.");
  connectLobby();
}

function leaveGame() {
  gameRoom?.leave();
}

ui.leave.onclick = leaveGame;

// Graphics quality Low / Medium / High (also the Q key in game). Remembered on this device.
function showQuality(q: Quality) {
  const prefix = document.createElement("span");
  prefix.className = "quality-prefix";
  prefix.textContent = "Quality: ";
  ui.quality.replaceChildren(prefix, QUALITY_LABEL[q]);
}
ui.quality.onclick = () => {
  cycleQuality();
  ui.quality.blur(); // so Space / Enter don't press it again
};
onQualityChange(showQuality);
showQuality(getQuality());

// Sound on/off (also the M key in game)
function showMute(muted: boolean) {
  ui.mute.textContent = muted ? "🔇" : "🔊";
}
ui.mute.onclick = () => {
  sfx.unlock();
  showMute(sfx.toggleMute());
  ui.mute.blur(); // so Space / Enter don't press it again
};
showMute(sfx.muted);

// Controls card: H or the ? button toggles it
let helpTimer = 0;
let helpOpen = false;
function setHelp(show: boolean) {
  clearTimeout(helpTimer);
  helpOpen = show;
  ui.help.hidden = !show;
  ui.helpBtn.classList.toggle("on", show);
}
function showHelpFor(ms: number) {
  setHelp(true);
  helpTimer = window.setTimeout(() => setHelp(false), ms);
}
ui.helpBtn.onclick = () => {
  setHelp(!helpOpen);
  ui.helpBtn.blur();
};

window.addEventListener("keydown", (e) => {
  if (!gameRoom) {
    if (e.key === "Escape" && !ui.lobby.hidden && location.hash) backToMenu();
    return;
  }
  // In fullscreen the browser uses Esc to exit it; only leave on an Esc of its own.
  const exitingFullscreen = !!document.fullscreenElement || performance.now() - fullscreenEndedAt < 500;
  if (e.key === "Escape" && !exitingFullscreen) leaveGame();
  if (e.key === "h" || e.key === "H") setHelp(!helpOpen);
});

// ---------- Helpers ----------

function showError(message: string) {
  ui.error.textContent = message;
  ui.error.hidden = false;
}
function hideError() {
  ui.error.hidden = true;
}

renderRooms();
startLobbyBackdrop();
connectLobby();
