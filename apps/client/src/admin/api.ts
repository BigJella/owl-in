import type { AdminSnapshot, LlmStats } from "@owl-in/shared";

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
  llm: (limit = 200) => request<LlmStats>("GET", `/llm?limit=${limit}`),
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
