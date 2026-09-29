import { Hono } from "hono";
import type { StudioApiAdapter } from "./types.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerPreviewRoutes } from "./routes/preview.js";
import { registerLintRoutes } from "./routes/lint.js";
import { registerRenderRoutes } from "./routes/render.js";
import { registerImageThumbnailRoutes } from "./routes/imageThumbnail.js";
import { registerThumbnailRoutes } from "./routes/thumbnail.js";
import { registerWaveformRoutes } from "./routes/waveform.js";
import { registerFontRoutes } from "./routes/fonts.js";
import { registerRegistryRoutes } from "./routes/registry.js";
import { registerSelectionRoutes } from "./routes/selection.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerGlobalAssetRoutes } from "./routes/globalAssets.js";
import { AgentRuntime } from "./agent/runtime.js";
import { registerAgentRoutes, registerAgentWriteLock } from "./routes/agent.js";
import { registerVendorRoutes } from "./helpers/vendoredGsap.js";
import { registerGoogleFontProxyRoutes } from "./helpers/googleFontProxy.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { replaceWithProjectDirMissing } from "./helpers/projectDirMissing.js";
import { folderGone, isProjectRootMissing } from "./helpers/safePath.js";

/**
 * Create a Hono sub-app with all studio API routes.
 *
 * Both the vite dev server and CLI embedded server mount this app
 * under /api, each providing their own adapter for host-specific behavior.
 */
export function createStudioApi(adapter: StudioApiAdapter): Hono {
  const api = new Hono();
  const agentRuntime = new AgentRuntime(adapter);

  registerAgentWriteLock(api, agentRuntime);
  api.use(async function answerProjectDirMissingAfterErrorHandlers(c, next) {
    const hostHeaders = new Headers(c.res.headers);
    await next();
    if (isProjectRootMissing(c.error)) replaceWithProjectDirMissing(c, hostHeaders);
  });
  api.use("/projects/:id/*", async function answerProjectDirMissingForVanishedFolder(c, next) {
    const hostHeaders = new Headers(c.res.headers);
    const dirBeforeRoute = await Promise.resolve()
      .then(() => adapter.resolveProject(c.req.param("id")))
      .then(
        (project) => project?.dir,
        () => undefined,
      );
    await next();
    if (c.res.status >= 403 && dirBeforeRoute && folderGone(dirBeforeRoute))
      replaceWithProjectDirMissing(c, hostHeaders);
  });

  registerProjectRoutes(api, adapter);
  registerFileRoutes(api, adapter);
  registerPreviewRoutes(api, adapter);
  registerLintRoutes(api, adapter);
  registerRenderRoutes(api, adapter);
  registerThumbnailRoutes(api, adapter);
  registerImageThumbnailRoutes(api, adapter);
  registerSelectionRoutes(api, adapter);
  registerMediaRoutes(api, adapter);
  registerWaveformRoutes(api, adapter);
  registerFontRoutes(api);
  registerRegistryRoutes(api, adapter);
  registerGlobalAssetRoutes(api);
  registerAgentRoutes(api, adapter, agentRuntime);
  // Tabario fork (TAB-697): serves GSAP from our own origin so previews
  // never depend on a public CDN. See helpers/vendoredGsap.ts.
  registerVendorRoutes(api);
  // Tabario fork (TAB-697): proxies Google Fonts so the customer's browser
  // never connects to Google directly. See helpers/googleFontProxy.ts.
  registerGoogleFontProxyRoutes(api);
  registerHistoryRoutes(api, adapter);

  return api;
}
