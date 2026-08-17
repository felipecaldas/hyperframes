import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";
import { AgentRuntime } from "../agent/runtime.js";
import {
  isAgentProvider,
  isAgentRequestKind,
  type AgentProvider,
  type AgentRequestKind,
  type AgentRunRequest,
} from "../agent/types.js";

const MAX_PROMPT_BYTES = 128 * 1024;
const NONCE_HEADER = "x-hyperframes-agent-nonce";

function requestHostname(c: Context): string {
  const host = c.req.raw.headers.get("host") ?? new URL(c.req.url).host;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return "";
  }
}

function isLoopback(c: Context): boolean {
  const hostname = requestHostname(c).toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isAgentBridgeEnabled(c: Context, adapter: StudioApiAdapter): boolean {
  return adapter.agentBridgeEnabled !== false && isLoopback(c);
}

function isSameOrigin(c: Context): boolean {
  if (c.req.raw.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = c.req.raw.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (c.req.raw.headers.get("host") ?? new URL(c.req.url).host);
  } catch {
    return false;
  }
}

function mutationGuard(
  c: Context,
  adapter: StudioApiAdapter,
  runtime: AgentRuntime,
): Response | null {
  if (!isAgentBridgeEnabled(c, adapter))
    return c.json(
      { error: "Tabario AI is available only through the secured Studio server." },
      403,
    );
  if (!isSameOrigin(c)) return c.json({ error: "Cross-origin agent request rejected." }, 403);
  if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
    return c.json({ error: "Agent mutations require application/json." }, 415);
  }
  if (c.req.header(NONCE_HEADER) !== runtime.nonce) {
    return c.json({ error: "Invalid Tabario AI session nonce." }, 403);
  }
  return null;
}

type RequestRecord = Record<string, unknown>;

/** Body of a mutation request, or null when it is not a JSON object. */
function asRecord(value: unknown): RequestRecord | null {
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value)) : null;
}

function hasValidRunFields(body: RequestRecord): boolean {
  return (
    isAgentProvider(body.provider) &&
    isAgentRequestKind(body.kind) &&
    typeof body.prompt === "string"
  );
}

function hasValidRunOptions(body: RequestRecord): boolean {
  const registryItemOk = body.registryItem === undefined || typeof body.registryItem === "string";
  const newThreadOk = body.newThread === undefined || typeof body.newThread === "boolean";
  return registryItemOk && newThreadOk;
}

function parseRunRequest(value: unknown): AgentRunRequest | null {
  const body = asRecord(value);
  if (!body || !hasValidRunFields(body) || !hasValidRunOptions(body)) return null;
  return {
    provider: body.provider as AgentProvider,
    kind: body.kind as AgentRequestKind,
    prompt: body.prompt as string,
    ...(typeof body.registryItem === "string" ? { registryItem: body.registryItem } : {}),
    ...(typeof body.newThread === "boolean" ? { newThread: body.newThread } : {}),
  };
}

type GuardedMutation =
  | { ok: true; project: ResolvedProject; body: unknown }
  | { ok: false; response: Response };

/**
 * Shared prelude for the project-scoped agent mutations: nonce/origin guard,
 * project resolution, then the JSON body (null when absent or malformed).
 */
async function guardProjectMutation(
  c: Context,
  adapter: StudioApiAdapter,
  runtime: AgentRuntime,
): Promise<GuardedMutation> {
  const rejected = mutationGuard(c, adapter, runtime);
  if (rejected) return { ok: false, response: rejected };
  // Outside a typed route handler Hono widens the param to string | undefined;
  // an empty id simply fails resolution below and yields the same 404.
  const project = await adapter.resolveProject(c.req.param("id") ?? "");
  if (!project) return { ok: false, response: c.json({ error: "Project not found" }, 404) };
  const body: unknown = await c.req.json().catch(() => null);
  return { ok: true, project, body };
}

export function registerAgentRoutes(
  api: Hono,
  adapter: StudioApiAdapter,
  runtime: AgentRuntime,
): void {
  api.get("/projects/:id/agent/capabilities", async (c) => {
    if (!isAgentBridgeEnabled(c, adapter) || !isSameOrigin(c)) {
      return c.json({
        enabled: false,
        reason: "Tabario AI is disabled when Studio is not behind its secured loopback server.",
        providers: {},
      });
    }
    return c.json({ enabled: true, nonce: runtime.nonce, providers: await runtime.capabilities() });
  });

  api.get("/projects/:id/agent/threads", async (c) => {
    if (!isAgentBridgeEnabled(c, adapter) || !isSameOrigin(c))
      return c.json({ error: "Tabario AI unavailable." }, 403);
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    return c.json({ threads: runtime.threads(project) });
  });

  api.post("/projects/:id/agent/threads/reset", async (c) => {
    const guarded = await guardProjectMutation(c, adapter, runtime);
    if (!guarded.ok) return guarded.response;
    const record = asRecord(guarded.body);
    if (!isAgentProvider(record?.provider)) return c.json({ error: "Invalid provider" }, 400);
    return c.json({ thread: runtime.resetThread(guarded.project) });
  });

  api.post("/projects/:id/agent/runs", async (c) => {
    const guarded = await guardProjectMutation(c, adapter, runtime);
    if (!guarded.ok) return guarded.response;
    const request = parseRunRequest(guarded.body);
    if (!request) return c.json({ error: "Invalid agent run request" }, 400);
    const promptBytes = Buffer.byteLength(request.prompt, "utf-8");
    if (promptBytes === 0 || promptBytes > MAX_PROMPT_BYTES) {
      return c.json({ error: `Prompt must be between 1 byte and ${MAX_PROMPT_BYTES} bytes.` }, 413);
    }
    const capabilities = await runtime.capabilities();
    if (!capabilities[request.provider].available) {
      return c.json(
        {
          error: `${request.provider} is unavailable.`,
          guidance: capabilities[request.provider].guidance,
        },
        503,
      );
    }
    try {
      const job = runtime.start(guarded.project, request);
      return c.json({ jobId: job.id }, 202);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  api.get("/agent/runs/:jobId/events", (c) => {
    if (!isAgentBridgeEnabled(c, adapter) || !isSameOrigin(c))
      return c.json({ error: "Tabario AI unavailable." }, 403);
    const job = runtime.getJob(c.req.param("jobId"));
    if (!job) return c.json({ error: "Run not found" }, 404);
    const lastId = Number(c.req.header("last-event-id") ?? "0");
    return streamSSE(c, async (stream) => {
      let cursor = Number.isFinite(lastId) && lastId > 0 ? lastId : 0;
      while (!stream.aborted) {
        while (cursor < job.events.length) {
          const event = job.events[cursor++];
          if (!event) continue;
          await stream.writeSSE({
            id: String(event.id),
            event: event.type,
            data: JSON.stringify(event),
          });
        }
        if (job.terminal) return;
        await new Promise<void>((resolveWait) => {
          const unsubscribe = runtime.subscribe(job.id, () => {
            unsubscribe();
            clearTimeout(timer);
            resolveWait();
          });
          const timer = setTimeout(() => {
            unsubscribe();
            resolveWait();
          }, 10_000);
        });
      }
    });
  });

  api.post("/agent/runs/:jobId/cancel", (c) => {
    const rejected = mutationGuard(c, adapter, runtime);
    if (rejected) return rejected;
    return runtime.cancel(c.req.param("jobId"))
      ? c.json({ cancelled: true })
      : c.json({ error: "Run is not active" }, 409);
  });

  api.post("/agent/runs/:jobId/undo", async (c) => {
    const rejected = mutationGuard(c, adapter, runtime);
    if (rejected) return rejected;
    try {
      const result = await runtime.undo(c.req.param("jobId"));
      if (result.conflicts.length > 0) {
        return c.json({ error: "Undo conflict", conflicts: result.conflicts }, 409);
      }
      return c.json({ undone: true, findings: result.findings ?? [] });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });
}

export function registerAgentWriteLock(api: Hono, runtime: AgentRuntime): void {
  api.use("*", async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
      return next();
    }
    if (/^\/projects\/[^/]+\/agent\//.test(c.req.path) || /^\/agent\/runs\//.test(c.req.path)) {
      return next();
    }
    const match = /^\/projects\/([^/]+)/.exec(c.req.path);
    const projectId = match?.[1];
    if (projectId && runtime.isProjectLocked(decodeURIComponent(projectId))) {
      return c.json({ error: "Studio writes are locked while the agent is working." }, 423);
    }
    return next();
  });
}
