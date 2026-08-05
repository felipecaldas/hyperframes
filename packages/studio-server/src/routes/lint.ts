import type { Hono } from "hono";
import type { StudioApiAdapter } from "../types.js";
import { lintProject } from "../helpers/projectLint.js";

export function registerLintRoutes(api: Hono, adapter: StudioApiAdapter): void {
  api.get("/projects/:id/lint", async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    try {
      return c.json({ findings: await lintProject(adapter, project.dir) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Lint failed: ${msg}` }, 500);
    }
  });
}
