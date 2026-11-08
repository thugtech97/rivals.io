import Phaser from "phaser";
import type { Room } from "@colyseus/sdk";
import { client, SERVER_URL, type RoomListing } from "./network";
import { GameScene, type GameSceneData } from "./GameScene";
import { Hud } from "./hud";
import { sfx } from "./sound";
import { startLobbyBackdrop, stopLobbyBackdrop } from "./lobbyBackdrop";
import { ARENA_ROOM, LOBBY_ROOM } from "../../shared/constants";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  lobby: $("lobby"),
  shade: $("lobby-shade"),
  name: $<HTMLInputElement>("player-name"),
  quickPlay: $<HTMLButtonElement>("quick-play"),
  status: $("lobby-status"),
  roomList: $<HTMLUListElement>("room-list"),
  createForm: $<HTMLFormElement>("create-form"),
  roomName: $<HTMLInputElement>("room-name"),
  error: $("lobby-error"),
  hud: $("hud"),
  hudRoom: $("hud-room"),
  hudPlayers: $("hud-players"),
  leave: $<HTMLButtonElement>("leave"),
  mute: $<HTMLButtonElement>("mute"),
  helpBtn: $<HTMLButtonElement>("help"),
  help: $("controls-help"),
};

const hud = new Hud();

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

function setStatus(state: "connecting" | "live" | "offline", text: string) {
  ui.status.dataset.state = state;
  ui.status.textContent = text;
}

async function connectLobby() {
  setStatus("connecting", "Connecting…");
  try {
    lobbyRoom = await client.joinOrCreate(LOBBY_ROOM, { filter: { name: ARENA_ROOM } });
  } catch (err) {
    setStatus("offline", "Offline");
    showError(`Can't reach the game server at ${SERVER_URL}. Is it running? Retrying…`);
    setTimeout(connectLobby, 3000);
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
    if (!gameRoom && !busy) setTimeout(connectLobby, 1000);
  });
}

function renderRooms() {
  ui.roomList.replaceChildren();
  if (lobbyRoom) setStatus("live", rooms.length ? `Live · ${rooms.length} room${rooms.length === 1 ? "" : "s"}` : "Live");
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
    const isFull = room.clients >= room.maxClients;
    // Locked but not full = a match is being played right now.
    const state = isFull ? "full" : room.locked ? "ingame" : "open";
    const li = document.createElement("li");
    li.className = "room";

    const info = document.createElement("div");
    info.className = "room-info";
    const name = document.createElement("div");
    name.className = "room-name";
    name.textContent = room.metadata?.roomName ?? room.roomId;
    const host = document.createElement("div");
    host.className = "room-host";
    host.textContent = `Host: ${room.metadata?.hostName ?? "?"}`;
    info.append(name, host);

    // Player count, a little fill bar, and an Open / In game / Full badge
    const meta = document.createElement("div");
    meta.className = "room-meta";
    const count = document.createElement("span");
    count.className = "room-count";
    count.textContent = `👥 ${room.clients}/${room.maxClients}`;
    const fill = document.createElement("div");
    fill.className = "room-fill";
    const bar = document.createElement("span");
    bar.style.width = `${Math.min(100, (room.clients / room.maxClients) * 100)}%`;
    fill.append(bar);
    const badge = document.createElement("span");
    badge.className = `badge badge-${state}`;
    badge.textContent = state === "full" ? "Full" : state === "ingame" ? "In game" : "Open";
    meta.append(count, fill, badge);

    const join = document.createElement("button");
    join.className = state === "open" ? "btn btn-small btn-secondary" : "btn btn-small";
    join.textContent = "Join";
    join.disabled = state !== "open";
    join.onclick = () => enterGame(() => client.joinById(room.roomId, { playerName: playerName() }));

    li.append(info, meta, join);
    ui.roomList.append(li);
  }
}

// ---------- Creating / joining a game room ----------

ui.quickPlay.onclick = () =>
  enterGame(() => client.joinOrCreate(ARENA_ROOM, { playerName: playerName() }));

ui.createForm.onsubmit = (e) => {
  e.preventDefault();
  enterGame(() =>
    client.create(ARENA_ROOM, {
      playerName: playerName(),
      roomName: ui.roomName.value.trim(),
      maxPlayers: Number(document.querySelector<HTMLInputElement>('input[name="max-players"]:checked')?.value ?? 8),
    }),
  );
};

async function enterGame(connect: () => Promise<Room>) {
  if (busy || gameRoom) return;
  sfx.unlock(); // browsers only allow sound after a click: this is that click
  busy = true;
  hideError();
  try {
    gameRoom = await connect();
    // Dev builds only: the room is reachable from the console as window.__room (handy for testing).
    if (import.meta.env.DEV) (window as any).__room = gameRoom;
  } catch (err) {
    showError(`Couldn't join: ${err instanceof Error ? err.message : String(err)}`);
    busy = false;
    return;
  }

  // Leave the lobby while playing; we rejoin it when we come back.
  await lobbyRoom?.leave().catch(() => {});
  lobbyRoom = undefined;
  busy = false;

  ui.hudRoom.textContent = "";
  ui.hudPlayers.textContent = "";
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
    onPlayerCount: (n) => (ui.hudPlayers.textContent = `${n} player${n === 1 ? "" : "s"}`),
    onMuteToggle: showMute,
  };
  game.scene.add("game", GameScene, true, sceneData);

  gameRoom.onLeave((code) => backToLobby(code));
}

function backToLobby(code?: number) {
  game?.destroy(true);
  game = undefined;
  gameRoom = undefined;
  hud.hide();
  ui.hud.hidden = true;
  setHelp(false);
  ui.lobby.hidden = false;
  ui.shade.hidden = false;
  startLobbyBackdrop();
  // 1000 = we left on purpose; anything else means we were disconnected.
  if (code !== undefined && code !== 1000) showError("Disconnected from the room.");
  connectLobby();
}

function leaveGame() {
  gameRoom?.leave();
}

ui.leave.onclick = leaveGame;

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
  if (!gameRoom) return;
  if (e.key === "Escape") leaveGame();
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
