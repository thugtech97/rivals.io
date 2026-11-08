import { Server, LobbyRoom, WebSocketTransport } from "colyseus";
import { ArenaRoom } from "./rooms/ArenaRoom";
import { ARENA_ROOM, DEFAULT_SERVER_PORT, LOBBY_ROOM } from "../../shared/constants";

const port = Number(process.env.PORT) || DEFAULT_SERVER_PORT;

const server = new Server({
  transport: new WebSocketTransport(),
  greet: false,
});

// The lobby pushes the live list of arena rooms to every connected browser.
server.define(LOBBY_ROOM, LobbyRoom);

// Each arena is one game room. Realtime listing makes it show up in the lobby.
server.define(ARENA_ROOM, ArenaRoom).enableRealtimeListing();

await server.listen(port);
console.log(`rivals.io game server listening on ws://localhost:${port}`);
