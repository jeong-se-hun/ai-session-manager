import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import { runDoctor } from "./doctor";
import { permanentlyDeleteSessions, restoreSessions, setArchived, trashSessions } from "./operations";
import { getSessionDetail, listSessions } from "./scanner";
import { generateSessionSummary } from "./summary";
import type { ArchiveFilter, SortKey, TrashFilter } from "../shared/types";

const server = Fastify({ logger: true });
const port = Number(process.env.PORT ?? 3766);

const filterSchema = z.object({
  search: z.string().optional(),
  cwd: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  archive: z.enum(["all", "active", "archived"]).optional(),
  trash: z.enum(["all", "normal", "trashed"]).optional(),
  sort: z.enum(["updatedDesc", "updatedAsc", "createdDesc", "tokensDesc", "tokensAsc", "sizeDesc", "sizeAsc"]).optional(),
  limit: z.coerce.number().min(1).max(2000).optional()
});

const idsSchema = z.object({
  sessionIds: z.array(z.string().min(1)).min(1).max(200)
});

await server.register(cors, {
  origin: ["http://127.0.0.1:3767", "http://localhost:3767"]
});

server.get("/api/health", async () => ({ ok: true, checkedAt: new Date().toISOString() }));

server.get("/api/sessions", async (request) => {
  const query = filterSchema.parse(request.query);
  return listSessions({
    ...query,
    archive: query.archive as ArchiveFilter | undefined,
    trash: query.trash as TrashFilter | undefined,
    sort: query.sort as SortKey | undefined
  });
});

server.get("/api/sessions/:id", async (request) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  return getSessionDetail(params.id);
});

server.post("/api/sessions/:id/summary", async (request) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  return { sessionId: params.id, summary: await generateSessionSummary(params.id) };
});

server.post("/api/trash", async (request) => {
  const body = idsSchema.parse(request.body);
  return { results: await trashSessions(body.sessionIds) };
});

server.post("/api/restore", async (request) => {
  const body = idsSchema.parse(request.body);
  return { results: restoreSessions(body.sessionIds) };
});

server.post("/api/archive", async (request) => {
  const body = idsSchema.extend({ archived: z.boolean() }).parse(request.body);
  return { results: await setArchived(body.sessionIds, body.archived) };
});

server.post("/api/delete-permanent", async (request) => {
  const body = idsSchema.parse(request.body);
  return { results: await permanentlyDeleteSessions(body.sessionIds) };
});

server.get("/api/doctor", async () => runDoctor());

server.setErrorHandler((error, _request, reply) => {
  server.log.error(error);
  const message = error instanceof Error ? error.message : "Unknown error";
  const name = error instanceof Error ? error.name : "Error";
  reply.status(400).send({
    error: name,
    message
  });
});

await server.listen({ host: "127.0.0.1", port });
