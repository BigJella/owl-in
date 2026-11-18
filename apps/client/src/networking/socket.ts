import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@owl-in/shared";

const TOKEN_KEY = "owl-in:token";
const NAME_KEY = "owl-in:name";

function storage(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return value ?? null;
  }
}

/** Stable per-browser id so a refresh (or brief disconnect) reclaims your seat. */
function sessionToken(): string {
  // getRandomValues (unlike randomUUID) also works on plain-http LAN addresses.
  const fresh = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  return storage(TOKEN_KEY) ?? storage(TOKEN_KEY, fresh())!;
}

export const savedName = () => storage(NAME_KEY);
export const saveName = (name: string) => storage(NAME_KEY, name);

// Same host the page came from, so phones/laptops on the LAN reach the server too.
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? `${location.protocol}//${location.hostname}:3000`;

/** One shared, fully typed connection. A misspelled event name is a compile error. */
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SERVER_URL, {
  auth: { token: sessionToken() },
});
