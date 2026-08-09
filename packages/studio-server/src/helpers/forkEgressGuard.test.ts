// ---------------------------------------------------------------------------
// Tabario fork (TAB-697) — "confirm nothing else egresses", enforced.
//
// Fork-owned file: it does not exist upstream, so it never conflicts on a
// rebase. It scans the customer-facing Studio source (studio + studio-server)
// for third-party hosts and fails on anything not explicitly justified below.
//
// This is the part that keeps working after we stop paying attention. The
// audit that produced this ticket was a point-in-time grep; upstream is very
// active (272 commits between v0.7.86 and v0.7.94), and a rebase that adds a
// new CDN, analytics beacon or font host would otherwise ship to Tabario's
// customers unnoticed.
//
// If this test fails, the correct fix is almost always to route the new
// dependency through our own origin — not to widen the baseline.
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = join(HERE, "..", "..", "..");
const SCANNED = [join(PACKAGES_DIR, "studio", "src"), join(PACKAGES_DIR, "studio-server", "src")];

/**
 * Hosts that may appear in a network position. Every entry needs a reason —
 * "it was already there" is not one.
 */
const ALLOWED_HOSTS = new Set([
  // Serving hosts that are ours or the user's own machine.
  "localhost",
  "127.0.0.1",
  // Not network destinations: XML/schema namespace identifiers, doc links.
  "www.w3.org",
  "schema.org",
  "react.dev",
  "developer.mozilla.org",
  "github.com",
  "docs.hyperframes.com",
  "hyperframes.com",
  // Test-only sentinels that are never fetched.
  "media.invalid",
  "studio.local",
  "host",
  "example.com",
]);

/**
 * Known third-party hosts that are present in source but provably unreachable
 * at runtime. Each MUST name what makes it unreachable and what asserts that.
 */
const JUSTIFIED_UNREACHABLE: Record<string, string> = {
  "us.i.posthog.com":
    "PostHog transports in studio/src/telemetry/client.ts and studio/src/utils/studioTelemetry.ts. " +
    "Both gate every send on browserTelemetryAllowed(), which this fork holds hard OFF " +
    "(studio/src/telemetry/policy.ts). Asserted by studio/src/telemetry/policy.forkEgress.test.ts. " +
    "The constants are deliberately left in place to keep the upstream diff small across rebases.",
  // The server — not the customer's browser — fetches the font FAMILY LIST and
  // the stylesheet/binaries. That is Tabario infrastructure talking to Google,
  // which is out of scope for this ticket (the scope is customer-browser
  // egress) and already fails soft to a curated fallback list.
  "fonts.google.com":
    "studio-server only: font family list, server-side, falls back to a static list.",
  "fonts.googleapis.com":
    "studio-server only: helpers/googleFontProxy.ts fetches css2 server-side.",
  "fonts.gstatic.com":
    "studio-server only: helpers/googleFontProxy.ts proxies font binaries server-side.",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

interface Hit {
  host: string;
  file: string;
  line: number;
}

function scanForHosts(): Hit[] {
  const hits: Hit[] = [];
  for (const root of SCANNED) {
    for (const file of sourceFiles(root)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((text, index) => {
        // Skip comments — the fork's own explanatory notes name the hosts they
        // removed, and flagging those would make the guard unusable.
        const trimmed = text.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        for (const match of text.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
          hits.push({ host: match[1], file: relative(PACKAGES_DIR, file), line: index + 1 });
        }
      });
    }
  }
  return hits;
}

describe("Tabario fork: customer-facing Studio does not egress to third parties", () => {
  const hits = scanForHosts();

  it("finds no third-party host that is neither allowed nor justified", () => {
    const unexpected = hits.filter(
      (h) => !ALLOWED_HOSTS.has(h.host) && JUSTIFIED_UNREACHABLE[h.host] === undefined,
    );
    // Rendered so a failure names the file:line to fix, not just a count.
    expect(unexpected.map((h) => `${h.host} (${h.file}:${h.line})`)).toEqual([]);
  });

  it("keeps GSAP off public CDNs — the preview must not depend on jsdelivr", () => {
    // subComposition.ts previously requested a FLOATING `gsap@3` from jsdelivr,
    // so the CDN could serve a different build between renders.
    expect(hits.filter((h) => h.host.endsWith("jsdelivr.net"))).toEqual([]);
    expect(hits.filter((h) => h.host.endsWith("unpkg.com"))).toEqual([]);
  });

  it("keeps the client off Google Fonts directly (server-side proxy only)", () => {
    const clientGoogleFontRefs = hits.filter(
      (h) =>
        (h.host === "fonts.googleapis.com" || h.host === "fonts.gstatic.com") &&
        h.file.startsWith("studio/"),
    );
    // A `preconnect` counts: it opens the connection and discloses the IP
    // before any font is requested.
    expect(clientGoogleFontRefs.map((h) => `${h.file}:${h.line}`)).toEqual([]);
  });

  it("documents a reason for every justified-unreachable host", () => {
    for (const [host, reason] of Object.entries(JUSTIFIED_UNREACHABLE)) {
      expect(reason.length, `${host} needs a real justification`).toBeGreaterThan(40);
    }
  });
});

/**
 * TAB-747. Vendoring a file instead of fetching it from a CDN trades a network
 * dependency for a *module-resolution* dependency, and a bundler cannot see the
 * second one.
 *
 * `vendoredGsap.ts` resolves `gsap/package.json` through `createRequire` at run
 * time. `packages/cli` BUNDLES this package into `dist/cli.js` via tsup, so
 * studio-server's own `dependencies` are never installed when the CLI is packed
 * and installed on its own — only `packages/cli`'s are. Declaring `gsap` here
 * and nowhere else produced a packed CLI that died on startup with
 * `Cannot find module 'gsap/package.json'`, while every test in this repo
 * passed: inside the workspace, bun hoists `gsap` to the root `node_modules`
 * and the resolution walks up to it.
 *
 * The bug was therefore invisible to the monorepo by construction. This test is
 * the only thing that makes the packaged shape visible from inside it.
 */
describe("runtime-resolved packages are declared where they get installed", () => {
  it("declares gsap on packages/cli, not only on studio-server", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");

    const here = dirname(fileURLToPath(import.meta.url));
    const cliPkg = JSON.parse(
      readFileSync(join(here, "..", "..", "..", "cli", "package.json"), "utf-8"),
    ) as { dependencies?: Record<string, string> };

    expect(
      cliPkg.dependencies?.gsap,
      "packages/cli must declare gsap: it is the package that actually gets installed, " +
        "and vendoredGsap.ts resolves it at runtime through createRequire",
    ).toBeDefined();
  });
});
