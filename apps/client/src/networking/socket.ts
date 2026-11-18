import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@owl-in/shared";

const TOKEN_KEY = "owl-in:token";
const NAME_KEY = "owl-in:name";
const CAREER_KEY = "owl-in:career-public";

function storage(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return value ?? null;
  }
}

// getRandomValues (unlike randomUUID) also works on plain-http LAN addresses.
const freshToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Stable per-browser id so a refresh (or brief disconnect) reclaims your seat. A malformed stored token is replaced. */
function sessionToken(): string {
  const stored = storage(TOKEN_KEY);
  return stored && /^[0-9a-f]{32}$/.test(stored) ? stored : storage(TOKEN_KEY, freshToken())!;
}

export const savedName = () => storage(NAME_KEY);
export const saveName = (name: string) => storage(NAME_KEY, name);
/** Public / private career choice; null until the player has made it (older browsers get asked once). */
export const savedCareerPublic = (): boolean | null => {
  const value = storage(CAREER_KEY);
  return value === "public" ? true : value === "private" ? false : null;
};
export const saveCareerPublic = (isPublic: boolean) => storage(CAREER_KEY, isPublic ? "public" : "private");

// Same host the page came from, so phones/laptops on the LAN reach the server too.
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? `${location.protocol}//${location.hostname}:3000`;

/** One shared, fully typed connection. A misspelled event name is a compile error. */
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SERVER_URL, {
  auth: { token: sessionToken() },
});

/** The server rejected our token: start a new browser identity and reconnect (identify runs again on connect). */
export function resetToken() {
  socket.auth = { token: storage(TOKEN_KEY, freshToken())! };
  socket.disconnect().connect();
}
