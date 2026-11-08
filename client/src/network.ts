import { Client } from "@colyseus/sdk";
import { DEFAULT_SERVER_PORT } from "../../shared/constants";

// In dev the game server runs next to Vite on port 2567. Using the page's hostname
// means friends on your Wi-Fi can open http://<your-ip>:5173 and still reach the server.
// Override with VITE_SERVER_URL (e.g. wss://game.example.com) when you deploy.
const protocol = location.protocol === "https:" ? "wss" : "ws";
export const SERVER_URL: string =
  import.meta.env.VITE_SERVER_URL ?? `${protocol}://${location.hostname}:${DEFAULT_SERVER_PORT}`;

export const client = new Client(SERVER_URL);

/** One entry in the lobby's room list (what the server's LobbyRoom sends). */
export interface RoomListing {
  roomId: string;
  name: string;
  clients: number;
  maxClients: number;
  locked?: boolean;
  metadata?: { roomName: string; hostName: string };
}
