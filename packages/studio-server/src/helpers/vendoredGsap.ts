// ---------------------------------------------------------------------------
// Tabario fork (TAB-697) — serve GSAP from our own origin, never a public CDN.
//
// Upstream injects `<script src="https://cdn.jsdelivr.net/npm/gsap@…">` into
// every preview and sub-composition document. Upstream ships Studio as a local
// developer tool, where that is fine. This fork embeds Studio in the Tabario
// product, which makes it three problems at once:
//
//   1. Availability. The preview IS the deliverable the customer came to
//      watch. If jsdelivr is blocked (corporate networks, some countries) or
//      degraded, GSAP never loads and the preview silently does not animate.
//   2. Determinism. `helpers/subComposition.ts` requested a FLOATING `gsap@3`,
//      so the CDN could serve a different build from one render to the next —
//      in a product whose premise is deterministic output. The three call
//      sites had also drifted apart (3.15.0 / 3.12.5 / floating 3).
//   3. Supply chain. A CDN script executes with full privileges in the
//      customer's page and upstream sets no `integrity` attribute anywhere.
//
// Serving the copy already installed in node_modules fixes all three: one
// version by construction, no third-party connection, no unpinned bytes.
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
import { openSync, closeSync, fstatSync, readSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import type { Hono } from "hono";

const require = createRequire(import.meta.url);

/**
 * Only these files may be served. GSAP's dist directory also contains source
 * maps and ESM bundles we never inject, and an open-ended path would turn this
 * route into an arbitrary-file reader rooted in node_modules.
 */
const ALLOWED_FILES = new Set(["gsap.min.js", "CustomEase.min.js", "MotionPathPlugin.min.js"]);

/** Guards against a pathological install; the real files are ~30-70 KB. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

let cachedVersion: string | null = null;
let cachedDistDir: string | null = null;

/**
 * The single GSAP version for previews and sub-compositions — read from the
 * installed package rather than hardcoded, so it cannot drift from the copy
 * actually being served.
 */
export function vendoredGsapVersion(): string {
  if (cachedVersion === null) {
    const pkg = require("gsap/package.json") as { version?: string };
    cachedVersion = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  }
  return cachedVersion;
}

function vendoredGsapDistDir(): string {
  if (cachedDistDir === null) {
    cachedDistDir = join(dirname(require.resolve("gsap/package.json")), "dist");
  }
  return cachedDistDir;
}

/**
 * Same-origin URL for a GSAP dist file.
 *
 * The `gsap@<version>` segment is deliberate, not decoration: preview.ts
 * matches `gsap@([\d.]+)` against a composition's own script tag to pin the
 * MotionPath plugin to the same minor (a skew triggers a GSAP compatibility
 * warning), and `htmlHasGsap` matches `.../gsap.min.js`. Keeping both shapes
 * means the surrounding upstream logic works unchanged.
 */
export function vendoredGsapUrl(file: string): string {
  return `/api/vendor/gsap@${vendoredGsapVersion()}/dist/${file}`;
}

/** `<script>` tag pointing at the vendored copy. */
export function vendoredGsapScriptTag(file: string): string {
  return `<script src="${vendoredGsapUrl(file)}"></script>`;
}

export function registerVendorRoutes(api: Hono): void {
  // The version segment is accepted but not matched against the installed
  // version: an older cached document asking for a superseded version should
  // still get working GSAP rather than a 404 that breaks the preview.
  // Hono needs a regex param here: a bare `gsap@:version` does not match a
  // literal prefix inside a segment, so every request 404'd and previews
  // loaded with no GSAP at all. Caught by vendorRoutes.integration.test.ts —
  // the unit tests all passed while this was broken.
  api.get("/vendor/:pkg{gsap@[0-9][0-9.]*}/dist/:file", (c) => {
    const file = c.req.param("file");
    if (!ALLOWED_FILES.has(file)) return c.json({ error: "not found" }, 404);

    let fd: number;
    try {
      // O_NOFOLLOW mirrors routes/fonts.ts: a symlink planted in node_modules
      // must not become a read of an arbitrary file.
      fd = openSync(join(vendoredGsapDistDir(), file), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return c.json({ error: "gsap asset not available" }, 404);
    }
    try {
      const stat = fstatSync(fd);
      if (stat.size > MAX_FILE_BYTES) return c.json({ error: "gsap asset too large" }, 413);
      const buffer = Buffer.alloc(stat.size);
      readSync(fd, buffer, 0, stat.size, 0);
      return new Response(buffer, {
        headers: {
          "Content-Type": "text/javascript; charset=utf-8",
          // Immutable: the URL carries the exact version, so a changed version
          // is a changed URL. Safe to cache hard, and it keeps repeated
          // preview reloads off the disk read path.
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return c.json({ error: "failed to read gsap asset" }, 500);
    } finally {
      closeSync(fd);
    }
  });
}
