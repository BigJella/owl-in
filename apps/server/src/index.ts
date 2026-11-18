import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { HouseBank } from "./economy/HouseBank";
import { PlayerRegistry } from "./players/PlayerRegistry";
import { RoomManager } from "./rooms/RoomManager";
import type { GameServer } from "./networking/types";
import { LOBBY_CHANNEL, registerConnection } from "./networking/handlers/connectionHandler";

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io: GameServer = new Server(httpServer, {
  cors: { origin: "*" },
});

const registry = new PlayerRegistry();
const bank = new HouseBank();
const rooms = new RoomManager({
  bank,
  onRoomsChanged: (list) => io.to(LOBBY_CHANNEL).emit("poker:rooms", list),
});
rooms.seed();

const publishLobby = () =>
  io.emit("lobby-updated", { playersOnline: registry.onlineCount(), pokerPlayers: rooms.humanCount() });

app.get("/health", (_request, response) => {
  response.json({ status: "ok", playersOnline: registry.onlineCount(), rooms: rooms.list() });
});

io.on("connection", (socket) => registerConnection(socket, { registry, rooms, publishLobby }));

const port = Number(process.env.PORT ?? 3000);
httpServer.listen(port, "0.0.0.0", () => {
  console.log(`OWL IN server listening on http://localhost:${port}`);
});
