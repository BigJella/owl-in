import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import { AdminError, type AdminService } from "./AdminService";
import { adminGuard } from "./security";

const count = z.number().int();
const createSchema = z.object({
  game: z.enum(["poker", "blackjack"]),
  name: z.string(),
  bigBlind: z.number().optional(),
  minBet: z.number().optional(),
  maxBots: count.optional(),
  maxAi: count.optional(),
});
const updateSchema = z.object({ maxBots: count.optional(), maxAi: count.nullable().optional() });
const modeSchema = z.object({ mode: z.enum(["script", "llm", "auto"]) });
const kickSchema = z.object({ timeoutMinutes: z.number().optional() });
const banSchema = z.object({ reason: z.string().max(200).nullable().optional() });
const bankrollSchema = z.object({ delta: z.number() });
const renameSchema = z.object({ name: z.unknown() });
const timeoutSchema = z.object({
  playerId: z.string(),
  scope: z.enum(["table", "site"]),
  roomId: z.string().nullable().optional(),
  minutes: z.number(),
  reason: z.string().max(200).nullable().optional(),
});
const clearTimeoutSchema = timeoutSchema.pick({ playerId: true, scope: true, roomId: true });

/** Parse a body or answer 400. */
function body<T>(schema: z.ZodType<T>, request: Request): T {
  const parsed = schema.safeParse(request.body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AdminError(400, issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request.");
  }
  return parsed.data;
}

/** Run a handler; AdminErrors become their status, anything else a 500. */
const handle = (fn: (request: Request) => unknown) => (request: Request, response: Response) => {
  try {
    const result = fn(request);
    response.json(result ?? { ok: true });
  } catch (error) {
    if (error instanceof AdminError) response.status(error.status).json({ error: error.message });
    else {
      console.error("[admin]", error);
      response.status(500).json({ error: "Something went wrong on the server." });
    }
  }
};

const param = (request: Request, name: string) => String(request.params[name] ?? "");

/** The management API, mounted at /api/admin (localhost only). See CLAUDE.md "Management API". */
export function adminRoutes(admin: AdminService): Router {
  const router = Router();
  router.use(adminGuard);
  router.use(express.json({ limit: "16kb" }));

  router.get("/snapshot", handle(() => admin.snapshot()));
  router.get("/tables", handle(() => admin.tables()));
  router.get("/tables/:id", handle((r) => admin.table(param(r, "id"))));
  router.post("/tables", handle((r) => admin.createTable(body(createSchema, r))));
  router.patch("/tables/:id", handle((r) => admin.updateTable(param(r, "id"), body(updateSchema, r))));
  router.post("/tables/:id/close", handle((r) => admin.closeTable(param(r, "id"))));
  router.post("/bots/:id/mode", handle((r) => admin.setBotMode(param(r, "id"), body(modeSchema, r).mode)));

  router.get("/players", handle(() => admin.players()));
  router.get("/players/:id/career", handle((r) => admin.career(param(r, "id"))));
  router.post("/players/:id/kick", handle((r) => admin.kick(param(r, "id"), body(kickSchema, r).timeoutMinutes ?? 0)));
  router.post("/players/:id/ban", handle((r) => admin.ban(param(r, "id"), body(banSchema, r).reason?.trim() || null)));
  router.post("/players/:id/unban", handle((r) => admin.unban(param(r, "id"))));
  router.post("/players/:id/bankroll", handle((r) => admin.adjustBankroll(param(r, "id"), body(bankrollSchema, r).delta)));
  router.post("/players/:id/rename", handle((r) => admin.rename(param(r, "id"), body(renameSchema, r).name)));

  router.get("/timeouts", handle(() => admin.timeouts()));
  router.put("/timeouts", handle((r) => admin.setTimeout(body(timeoutSchema, r))));
  router.delete("/timeouts", handle((r) => admin.clearTimeout(body(clearTimeoutSchema, r))));

  router.get(
    "/llm",
    handle((r) => {
      const limit = Number(r.query.limit ?? 100);
      return admin.llm(Number.isFinite(limit) ? limit : 100);
    }),
  );

  router.use((_request, response) => response.status(404).json({ error: "No such admin endpoint." }));
  return router;
}
