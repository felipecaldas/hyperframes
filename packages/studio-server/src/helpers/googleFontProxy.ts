// ---------------------------------------------------------------------------
// Tabario fork (TAB-697) — proxy Google Fonts through our own origin.
//
// Upstream injects `<link rel="stylesheet" href="https://fonts.googleapis.com/
// css2?...">` straight into the document (studio/utils/studioFontHelpers.ts,
// components/editor/propertyPanelFont.tsx). Upstream ships Studio as a local
// developer tool, so that is unremarkable. This fork embeds Studio in the
// Tabario product, which makes it the customer's browser connecting to Google
// and disclosing its IP address — the exact pattern German courts have ruled
// breaches GDPR when done without consent, and one that also makes font
// rendering depend on a third party we have no contract with.
//
// The fix is a same-origin proxy, not removal: the customer's browser talks
// only to Tabario, while Tabario's SERVER talks to Google. Font choice is
// preserved in full.
//
// Two hops are needed because the css2 response body itself contains
// `https://fonts.gstatic.com/...` URLs for the actual font binaries — serving
// that CSS unmodified would leave the browser fetching from Google anyway,
// which is the bug this exists to prevent. So the CSS is rewritten on the way
// through and the binaries are proxied too.
// ---------------------------------------------------------------------------
import type { Hono } from "hono";

const GOOGLE_CSS_ORIGIN = "https://fonts.googleapis.com";
/** The only host font binaries may be fetched from. */
const GSTATIC_ORIGIN = "https://fonts.gstatic.com";
const FETCH_TIMEOUT_MS = 5_000;
/** Font binaries are tens of KB; this only guards against a pathological response. */
const MAX_FONT_BYTES = 8 * 1024 * 1024;

/**
 * A real browser UA is required: css2 varies its response by user agent, and
 * returns legacy TTF (much larger, no unicode-range subsetting) to clients it
 * does not recognise as woff2-capable.
 */
const CSS_FETCH_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Rewrite every gstatic binary URL in a css2 response to our own file route.
 * Anything that is not an exact `https://fonts.gstatic.com/` URL is left alone
 * — a rewrite that silently passed through an unexpected host would defeat the
 * point.
 */
export function rewriteFontCssUrls(css: string, fileRoute: string): string {
  return css.replace(
    /url\(\s*(['"]?)(https:\/\/fonts\.gstatic\.com\/[^)'"]+)\1\s*\)/g,
    (_m, _q, u) => {
      return `url("${fileRoute}?u=${encodeURIComponent(u)}")`;
    },
  );
}

export function registerGoogleFontProxyRoutes(api: Hono): void {
  // Mirrors the css2 query the client used to send to Google directly.
  api.get("/vendor/fonts/css", async (c) => {
    const family = c.req.query("family");
    if (!family) return c.json({ error: "family parameter required" }, 400);

    // Rebuild the upstream URL from validated parts rather than forwarding the
    // caller's string, so a crafted `family` cannot redirect this fetch.
    const encoded = encodeURIComponent(family.trim()).replace(/%20/g, "+");
    const target = `${GOOGLE_CSS_ORIGIN}/css2?family=${encoded}:wght@300;400;500;600;700;800;900&display=swap`;

    try {
      const response = await fetchWithTimeout(target, { "User-Agent": CSS_FETCH_UA });
      if (!response.ok) return c.json({ error: "font stylesheet unavailable" }, 502);
      const css = rewriteFontCssUrls(await response.text(), "/api/vendor/fonts/file");
      return new Response(css, {
        headers: {
          "Content-Type": "text/css; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        },
      });
    } catch {
      // Fail soft: the caller injects this as a <link>, and a failed font load
      // must degrade to the fallback face, never break the preview.
      return c.json({ error: "font stylesheet unavailable" }, 502);
    }
  });

  api.get("/vendor/fonts/file", async (c) => {
    const raw = c.req.query("u");
    if (!raw) return c.json({ error: "u parameter required" }, 400);

    // Host allowlist by parsed origin — not a string prefix test, which
    // `https://fonts.gstatic.com.evil.tld/...` would pass.
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return c.json({ error: "invalid url" }, 400);
    }
    if (parsed.origin !== GSTATIC_ORIGIN) return c.json({ error: "host not allowed" }, 403);

    try {
      const response = await fetchWithTimeout(parsed.toString(), { "User-Agent": CSS_FETCH_UA });
      if (!response.ok) return c.json({ error: "font file unavailable" }, 502);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_FONT_BYTES) return c.json({ error: "font file too large" }, 413);
      return new Response(buffer, {
        headers: {
          "Content-Type": response.headers.get("content-type") ?? "font/woff2",
          // Google serves these from immutable, content-hashed paths.
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return c.json({ error: "font file unavailable" }, 502);
    }
  });
}
