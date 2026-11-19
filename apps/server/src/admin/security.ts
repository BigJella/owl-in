import type { NextFunction, Request, Response } from "express";

/** The request came from this computer (never trusts X-Forwarded-For). */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address === "127.0.0.1" || address.startsWith("127.") || address === "::ffff:127.0.0.1";
}

/** A browser page served from this computer (any port): the admin panel, or the server itself. */
export function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname, protocol } = new URL(origin);
    return (protocol === "http:" || protocol === "https:") && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]");
  } catch {
    return false;
  }
}

/** Writes must send this header. A plain form post from another website can't, so it can't act as the admin. */
export const ADMIN_HEADER = "x-owl-admin";

/**
 * Localhost only, and safe against other websites open in the admin's browser:
 * - the connection must come from this computer;
 * - a browser request (with an Origin) must come from a page served by this computer;
 * - anything that changes state needs `X-Owl-Admin: 1` (forces a CORS preflight in browsers).
 * curl and the itcan.do bridge send no Origin and pass as long as they run on this computer.
 */
export function adminGuard(request: Request, response: Response, next: NextFunction) {
  if (!isLoopback(request.socket.remoteAddress)) {
    response.status(403).json({ error: "The management API is only available on this computer." });
    return;
  }
  const origin = request.headers.origin;
  if (origin !== undefined) {
    if (!isLocalOrigin(origin)) {
      response.status(403).json({ error: "Requests from other websites are not allowed." });
      return;
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", `Content-Type, ${ADMIN_HEADER}`);
  }
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  if (request.method !== "GET" && request.headers[ADMIN_HEADER] !== "1") {
    response.status(403).json({ error: `Send the header "X-Owl-Admin: 1" with every change.` });
    return;
  }
  next();
}
