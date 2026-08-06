// Tabario fork (TAB-697) — exercises the vendor routes through a real Hono app.
//
// The unit tests cover URL shape and CSS rewriting; this covers the thing that
// actually breaks a preview: whether the route MATCHES and returns the bytes.
// The `gsap@<version>` path segment embeds an `@` in a Hono pattern, which is
// exactly the kind of thing that silently 404s and takes the preview's
// animation with it.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { registerVendorRoutes, vendoredGsapUrl, vendoredGsapVersion } from "./vendoredGsap";
import { registerGoogleFontProxyRoutes } from "./googleFontProxy";

function app(): Hono {
  const api = new Hono();
  registerVendorRoutes(api);
  registerGoogleFontProxyRoutes(api);
  return api;
}

// Routes are registered on the api sub-app, which is mounted under /api; the
// helper URLs include that prefix, so strip it when dispatching directly.
function apiPath(url: string): string {
  return url.replace(/^\/api/, "");
}

describe("vendored GSAP route", () => {
  it("serves gsap.min.js at exactly the URL the injected script tag uses", async () => {
    const url = vendoredGsapUrl("gsap.min.js");
    const res = await app().request(apiPath(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("javascript");
    const body = await res.text();
    // Real GSAP, not an error page.
    expect(body.length).toBeGreaterThan(10_000);
    expect(body).toContain("gsap");
  });

  it("serves the two plugins previews inject", async () => {
    for (const file of ["CustomEase.min.js", "MotionPathPlugin.min.js"]) {
      const res = await app().request(apiPath(vendoredGsapUrl(file)));
      expect(res.status, `${file} should be served`).toBe(200);
      expect((await res.text()).length).toBeGreaterThan(1_000);
    }
  });

  it("still serves when an older document asks for a superseded version", async () => {
    // Cached preview HTML can name a version we have moved past; a 404 there
    // would break animation on an otherwise fine document.
    const res = await app().request("/vendor/gsap@3.12.5/dist/gsap.min.js");
    expect(res.status).toBe(200);
  });

  it("refuses a file outside the allowlist", async () => {
    const v = vendoredGsapVersion();
    for (const bad of ["gsap.min.js.map", "all.js", "ScrollTrigger.min.js"]) {
      const res = await app().request(`/vendor/gsap@${v}/dist/${bad}`);
      expect(res.status, `${bad} must not be served`).toBe(404);
    }
  });

  it("does not allow escaping the gsap dist directory", async () => {
    const v = vendoredGsapVersion();
    const res = await app().request(
      `/vendor/gsap@${v}/dist/${encodeURIComponent("../../../../etc/passwd")}`,
    );
    expect(res.status).not.toBe(200);
  });
});

describe("Google font proxy route", () => {
  it("rejects a missing family rather than proxying an unbounded request", async () => {
    const res = await app().request("/vendor/fonts/css");
    expect(res.status).toBe(400);
  });

  it("refuses to fetch a font binary from any host but gstatic", async () => {
    for (const bad of [
      "https://evil.example.com/x.woff2",
      // Prefix-matching implementations fall for this one.
      "https://fonts.gstatic.com.evil.tld/x.woff2",
      "http://fonts.gstatic.com/x.woff2", // scheme downgrade
    ]) {
      const res = await app().request(`/vendor/fonts/file?u=${encodeURIComponent(bad)}`);
      expect(res.status, `${bad} must be refused`).toBe(403);
    }
  });

  it("rejects a malformed url", async () => {
    const res = await app().request("/vendor/fonts/file?u=not-a-url");
    expect(res.status).toBe(400);
  });
});
