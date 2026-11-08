import Phaser from "phaser";
import type { Room } from "@colyseus/sdk";
import { client, SERVER_URL, type RoomListing } from "./network";
import { GameScene, type GameSceneData } from "./GameScene";
import { Hud } from "./hud";
import { ARENA_ROOM, LOBBY_ROOM } from "../../shared/constants";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  lobby: $("lobby"),
  name: $<HTMLInputElement>("player-name"),
  quickPlay: $<HTMLButtonElement>("quick-play"),
  status: $("lobby-status"),
  roomList: $<HTMLUListElement>("room-list"),
  createForm: $<HTMLFormElement>("create-form"),
  roomName: $<HTMLInputElement>("room-name"),
  maxPlayers: $<HTMLSelectElement>("max-players"),
  error: $("lobby-error"),
  hud: $("hud"),
  hudRoom: $("hud-room"),
  hudPlayers: $("hud-players"),
  leave: $<HTMLButtonElement>("leave"),
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

async function connectLobby() {
  ui.status.textContent = "Connecting…";
  try {
    lobbyRoom = await client.joinOrCreate(LOBBY_ROOM, { filter: { name: ARENA_ROOM } });
  } catch (err) {
    ui.status.textContent = "Offline";
    showError(`Can't reach the game server at ${SERVER_URL}. Is it running? Retrying…`);
    setTimeout(connectLobby, 3000);
    return;
  }
  hideError();
  ui.status.textContent = "Live";

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
  if (rooms.length === 0) {
    const empty = document.createElement("li");
    empty.className = "room-empty";
    empty.textContent = "No rooms yet. Create one or hit Quick play!";
    ui.roomList.append(empty);
    return;
  }

  for (const room of rooms) {
    const full = room.locked || room.clients >= room.maxClients;
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

    const count = document.createElement("span");
    count.className = "room-count";
    count.textContent = `${room.clients}/${room.maxClients}`;

    const join = document.createElement("button");
    join.className = "btn btn-small";
    join.textContent = full ? "Full" : "Join";
    join.disabled = full;
    join.onclick = () => enterGame(() => client.joinById(room.roomId, { playerName: playerName() }));

    li.append(info, count, join);
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
      maxPlayers: Number(ui.maxPlayers.value),
    }),
  );
};

async function enterGame(connect: () => Promise<Room>) {
  if (busy || gameRoom) return;
  busy = true;
  hideError();
  try {
    gameRoom = await connect();
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
  ui.hud.hidden = false;

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
  ui.lobby.hidden = false;
  // 1000 = we left on purpose; anything else means we were disconnected.
  if (code !== undefined && code !== 1000) showError("Disconnected from the room.");
  connectLobby();
}

function leaveGame() {
  gameRoom?.leave();
}

ui.leave.onclick = leaveGame;
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && gameRoom) leaveGame();
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
connectLobby();
