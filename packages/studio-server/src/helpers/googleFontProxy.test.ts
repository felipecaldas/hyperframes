import { describe, expect, it } from "vitest";
import { rewriteFontCssUrls } from "./googleFontProxy";

const ROUTE = "/api/vendor/fonts/file";

describe("rewriteFontCssUrls", () => {
  it("rewrites a gstatic binary URL to the same-origin file route", () => {
    const css = `@font-face{font-family:'Inter';src:url(https://fonts.gstatic.com/s/inter/v13/abc.woff2) format('woff2');}`;
    const out = rewriteFontCssUrls(css, ROUTE);
    // The whole point: after rewriting, the browser has no reason to contact
    // Google at all.
    expect(out).not.toContain("fonts.gstatic.com/s/inter");
    expect(out).toContain(
      `url("${ROUTE}?u=${encodeURIComponent("https://fonts.gstatic.com/s/inter/v13/abc.woff2")}")`,
    );
  });

  it("rewrites every face in a multi-weight stylesheet, not just the first", () => {
    // css2 returns one @font-face per weight/subset; a non-global replace would
    // leave most of them still pointing at Google.
    const css = [300, 400, 700]
      .map(
        (w) =>
          `@font-face{font-weight:${w};src:url(https://fonts.gstatic.com/s/x/${w}.woff2) format('woff2');}`,
      )
      .join("\n");
    const out = rewriteFontCssUrls(css, ROUTE);
    expect(out).not.toContain("https://fonts.gstatic.com");
    expect(out.match(/\/api\/vendor\/fonts\/file\?u=/g)).toHaveLength(3);
  });

  it("handles quoted and unquoted url() forms", () => {
    const css = `a{src:url("https://fonts.gstatic.com/a.woff2")}b{src:url('https://fonts.gstatic.com/b.woff2')}c{src:url(https://fonts.gstatic.com/c.woff2)}`;
    const out = rewriteFontCssUrls(css, ROUTE);
    expect(out).not.toContain("https://fonts.gstatic.com");
    expect(out.match(/\/api\/vendor\/fonts\/file\?u=/g)).toHaveLength(3);
  });

  it("leaves non-gstatic urls untouched", () => {
    // Only the exact Google binary host is rewritten. Silently proxying an
    // arbitrary host would turn this route into an open relay.
    const css = `a{src:url(https://evil.example.com/x.woff2)}b{src:url(/local/y.woff2)}`;
    expect(rewriteFontCssUrls(css, ROUTE)).toBe(css);
  });

  it("does not rewrite a lookalike host", () => {
    const css = `a{src:url(https://fonts.gstatic.com.evil.tld/x.woff2)}`;
    const out = rewriteFontCssUrls(css, ROUTE);
    // The encoded target must not be the lookalike; the regex requires a `/`
    // immediately after the real host.
    expect(out).toContain("evil.tld");
    expect(out).not.toContain("/api/vendor/fonts/file?u=https%3A%2F%2Ffonts.gstatic.com.evil");
  });
});
