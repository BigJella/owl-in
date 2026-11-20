import type { AdminLogPage, AdminLogQuery, AdminSnapshot, CareerView, HandRecord, LlmStats } from "@owl-in/shared";

/** Same server the player site uses. The API only answers requests from this computer. */
const BASE = `${import.meta.env.VITE_SERVER_URL ?? `${location.protocol}//${location.hostname}:3000`}/api/admin`;

export const isLocalPage = () => ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-Owl-Admin": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server.");
  }
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, data.error ?? `Request failed (${response.status}).`);
  return data;
}

export const api = {
  snapshot: () => request<AdminSnapshot>("GET", "/snapshot"),
  career: (playerId: string) => request<CareerView>("GET", `/players/${playerId}/career`),
  sessionHands: (playerId: string, sessionId: string) => request<HandRecord[]>("GET", `/players/${playerId}/sessions/${sessionId}`),
  llm: (limit = 200) => request<LlmStats>("GET", `/llm?limit=${limit}`),
  log: (query: AdminLogQuery) => {
    const params = new URLSearchParams();
    if (query.kinds) params.set("kinds", query.kinds.join(","));
    if (query.game) params.set("game", query.game);
    if (query.tableId) params.set("tableId", query.tableId);
    if (query.playerId) params.set("playerId", query.playerId);
    if (query.q) params.set("q", query.q);
    if (query.humansOnly) params.set("humansOnly", "1");
    if (query.before !== undefined) params.set("before", String(query.before));
    if (query.after !== undefined) params.set("after", String(query.after));
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    return request<AdminLogPage>("GET", `/log?${params}`);
  },
  createTable: (body: { game: "poker" | "blackjack"; name: string; bigBlind?: number; minBet?: number; maxBots?: number; maxAi?: number }) =>
    request("POST", "/tables", body),
  updateTable: (id: string, body: { maxBots?: number; maxAi?: number }) => request("PATCH", `/tables/${id}`, body),
  closeTable: (id: string) => request("POST", `/tables/${id}/close`),
  botMode: (botId: string, mode: "script" | "llm" | "auto") => request("POST", `/bots/${botId}/mode`, { mode }),
  kick: (playerId: string, timeoutMinutes: number) => request("POST", `/players/${playerId}/kick`, { timeoutMinutes }),
  ban: (playerId: string, reason: string) => request("POST", `/players/${playerId}/ban`, { reason }),
  unban: (playerId: string) => request("POST", `/players/${playerId}/unban`),
  bankroll: (playerId: string, delta: number) => request("POST", `/players/${playerId}/bankroll`, { delta }),
  rename: (playerId: string, name: string) => request("POST", `/players/${playerId}/rename`, { name }),
  setTimeout: (body: { playerId: string; scope: "table" | "site"; roomId?: string | null; minutes: number; reason?: string }) =>
    request("PUT", "/timeouts", body),
  clearTimeout: (body: { playerId: string; scope: "table" | "site"; roomId?: string | null }) => request("DELETE", "/timeouts", body),
};
