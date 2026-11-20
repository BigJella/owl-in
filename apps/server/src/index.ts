import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "socket.io";
import { HouseBank } from "./economy/HouseBank";
import { PlayerRegistry } from "./players/PlayerRegistry";
import { RoomManager } from "./rooms/RoomManager";
import { BlackjackRoomManager } from "./rooms/BlackjackRoomManager";
import { MemoryStatsStore } from "./stats/MemoryStatsStore";
import { formatDD } from "@owl-in/shared";
import { readLlmConfig } from "./ai/llmConfig";
import { claudeAvailable, createClaudeCliComplete } from "./ai/claudeCli";
import { LlmTelemetry } from "./ai/LlmTelemetry";
import type { CompleteFn, LlmDecisionLog } from "./ai/LlmStrategy";
import { AdminService } from "./admin/AdminService";
import { adminRoutes } from "./admin/adminRoutes";
import { Moderation } from "./admin/Moderation";
import { EventLog } from "./admin/EventLog";
import type { GameServer } from "./networking/types";
import { BLACKJACK_LOBBY_CHANNEL, LOBBY_CHANNEL, registerConnection } from "./networking/handlers/connectionHandler";

const app = express();
const httpServer = createServer(app);
const io: GameServer = new Server(httpServer, {
  cors: { origin: "*" },
});

const registry = new PlayerRegistry();
const bank = new HouseBank();
// Career stats and hand history, in memory like bankrolls (a restart wipes both).
const stats = new MemoryStatsStore();
// Bans, sitewide and per-table timeouts (in memory too).
const moderation = new Moderation();
// The admin panel's Logging tab: every hand, LLM decision and admin action (in memory).
const eventLog = new EventLog();

// LLM bots ask the local Claude Code CLI. Each poker table starts with OWL_DEFAULT_BOTS bots, OWL_LLM_BOTS of
// them LLM bots (defaults 4 and 2); admins change both per table.
const llmConfig = readLlmConfig();
let complete: CompleteFn | null = null;
if (await claudeAvailable(llmConfig.bin)) {
  complete = createClaudeCliComplete(llmConfig);
  console.log(`LLM bots: ${llmConfig.defaultMaxAi} of ${llmConfig.defaultMaxBots} bots per new table, ${llmConfig.model} via "${llmConfig.bin}"`);
} else {
  console.warn(`LLM bots: "${llmConfig.bin}" not found or not working; LLM bots will play by script.`);
}
const telemetry = new LlmTelemetry(complete !== null, llmConfig.model);
const logLlmDecision = (d: LlmDecisionLog) => {
  telemetry.record(d);
  const action = d.action.type === "raise" ? `raise to ${formatDD(d.action.to)}` : d.action.type;
  const bot = { playerId: null, name: d.bot, kind: "bot" as const };
  eventLog.add({
    at: d.at,
    kind: "llm",
    game: "poker",
    table: { id: d.tableId, name: d.table },
    summary: `${d.bot}: ${action} · ${(d.ms / 1000).toFixed(1)}s${d.fallback ? ` · script fallback (${d.fallback})` : ""}`,
    players: [bot],
    llm: { bot, handId: d.handId, action, ms: d.ms, costUsd: d.costUsd, fallback: d.fallback },
  });
  console.log(`[llm] ${d.table} #${d.handId} ${d.bot}: ${action} (${d.ms}ms)${d.fallback ? ` fallback: ${d.fallback}` : ""}`);
};

const rooms = new RoomManager({
  bank,
  stats,
  moderation,
  eventLog,
  defaults: { maxBots: llmConfig.defaultMaxBots, maxAi: llmConfig.defaultMaxAi },
  llm: { complete, log: logLlmDecision },
  onRoomsChanged: (list) => io.to(LOBBY_CHANNEL).emit("poker:rooms", list),
});
rooms.seed();
const blackjack = new BlackjackRoomManager({
  bank,
  stats,
  moderation,
  eventLog,
  onRoomsChanged: (list) => io.to(BLACKJACK_LOBBY_CHANNEL).emit("blackjack:rooms", list),
});
blackjack.seed();

const publishLobby = () =>
  io.emit("lobby-updated", {
    playersOnline: registry.onlineCount(),
    pokerPlayers: rooms.humanCount(),
    blackjackPlayers: blackjack.humanCount(),
  });

// Management API (localhost only). Mounted before the permissive CORS below, which must never answer for it.
const admin = new AdminService({ registry, rooms, blackjack, bank, moderation, telemetry, stats, eventLog, publishLobby });
app.use("/api/admin", adminRoutes(admin));

app.use(cors());
app.use(express.json());

// The hackathon presentation (one self-contained file, built by `npm run present:build`). Served from here so it is
// same-origin with the management API and can show live data; opened from disk it falls back to sample data.
const PRESENTATION = resolve(import.meta.dirname, "../../../presentation/owl-in.html");
app.get("/present", (_request, response) => {
  if (existsSync(PRESENTATION)) response.sendFile(PRESENTATION);
  else response.status(404).send("Build the presentation first: npm run present:build");
});

app.get("/health", (_request, response) => {
  response.json({ status: "ok", playersOnline: registry.onlineCount(), rooms: rooms.list(), blackjack: blackjack.list() });
});

io.on("connection", (socket) => registerConnection(socket, { registry, rooms, blackjack, stats, moderation, publishLobby }));

const port = Number(process.env.PORT ?? 3000);
httpServer.listen(port, "0.0.0.0", () => {
  console.log(`OWL IN server listening on http://localhost:${port} (admin API: /api/admin, this computer only)`);
  console.log(`Presentation (live data): http://localhost:${port}/present`);
});
