import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { vendoredGsapScriptTag, vendoredGsapUrl, vendoredGsapVersion } from "./vendoredGsap";

const require = createRequire(import.meta.url);

describe("vendoredGsap", () => {
  it("reports the version of the gsap actually installed, not a hardcoded one", () => {
    // The drift this prevents: three call sites previously claimed 3.15.0,
    // 3.12.5 and a floating `gsap@3` while one copy was on disk.
    const installed = (require("gsap/package.json") as { version: string }).version;
    expect(vendoredGsapVersion()).toBe(installed);
    expect(vendoredGsapVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("builds a same-origin URL — never a public CDN", () => {
    const url = vendoredGsapUrl("gsap.min.js");
    expect(url.startsWith("/api/vendor/gsap@")).toBe(true);
    expect(url).not.toMatch(/^https?:\/\//);
  });

  it("keeps the `gsap@<version>` segment preview.ts matches against", () => {
    // routes/preview.ts pins the MotionPath plugin to the composition's own
    // gsap by matching /gsap@([\d.]+)/ on the existing script tag; a minor
    // skew triggers a GSAP compatibility warning. Dropping this segment from
    // the URL shape would silently break that pinning.
    const url = vendoredGsapUrl("MotionPathPlugin.min.js");
    expect(url.match(/gsap@([\d.]+)/)?.[1]).toBe(vendoredGsapVersion());
  });

  it("keeps the `/gsap.min.js` tail that htmlHasGsap detects", () => {
    // preview.ts's gsapScript regex looks for src="...\/gsap(.min)?.js".
    expect(vendoredGsapUrl("gsap.min.js")).toMatch(/\/gsap\.min\.js$/);
  });

  it("emits a well-formed script tag", () => {
    expect(vendoredGsapScriptTag("CustomEase.min.js")).toBe(
      `<script src="${vendoredGsapUrl("CustomEase.min.js")}"></script>`,
    );
  });
});
