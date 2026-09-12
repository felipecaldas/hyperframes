import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lintHyperframeHtml } from "../hyperframeLinter.js";
import type { HyperframeLintFinding } from "../types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "tabario");

/**
 * Lint one fixture under a chosen path. The path matters: the accent count runs
 * only when the basename is `index.html`, so every case states the name it is
 * linted as instead of letting a default decide.
 */
async function lintFixture(
  fixture: string,
  linted = "/project/index.html",
): Promise<HyperframeLintFinding[]> {
  const html = readFileSync(join(FIXTURES, fixture), "utf-8");
  const result = await lintHyperframeHtml(html, { filePath: linted });
  return result.findings.filter((f) => f.code.startsWith("tabario_"));
}

describe("tabario register rules", () => {
  it("says nothing about a project with no tabario-project tag", async () => {
    // A `back.out` tween and a `zoom_blur` mount, both of which the register
    // would refuse. No tag means no register, so the rule has no claim to make.
    expect(await lintFixture("no-tag.html")).toEqual([]);
  });

  it("says nothing about a project inside its register", async () => {
    expect(await lintFixture("clean.html")).toEqual([]);
  });

  it("names the ease and the line when a tween eases outside the register", async () => {
    const findings = await lintFixture("bad-ease.html");
    expect(findings.map((f) => f.code)).toEqual(["tabario_motion_ease_outside_register"]);
    const finding = findings[0]!;
    expect(finding.severity).toBe("warning");
    expect(finding.message).toContain("back.out(1.7)");
    expect(finding.message).toMatch(/line \d+/);
    // The allowed set belongs in the message: a warning that withholds it makes
    // the author guess which seven eases the template actually permits.
    expect(finding.message).toContain("power2.out");
  });

  it("flags a transition type the register never named", async () => {
    const findings = await lintFixture("bad-transition.html");
    expect(findings.map((f) => f.code)).toEqual(["tabario_motion_transition_outside_register"]);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain("zoom_blur");
    // `soft_cut` is always allowed and the second mount carries it.
    expect(findings[0]!.message).not.toContain("soft_cut");
  });

  it("counts accents on index.html only, and reports the count and the limit", async () => {
    const findings = await lintFixture("too-many-accents.html");
    expect(findings.map((f) => f.code)).toEqual(["tabario_motion_accent_limit"]);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain("3");
    expect(findings[0]!.message).toContain("2");

    // The same bytes under a scene file's name. Scene files carry their own
    // mounts and counting them would report the whole film's budget per scene.
    expect(
      await lintFixture("too-many-accents.html", "/project/compositions/scene-1.html"),
    ).toEqual([]);
  });

  it("warns rather than throws when the tag does not parse", async () => {
    const findings = await lintFixture("malformed.html");
    expect(findings.map((f) => f.code)).toEqual(["tabario_project_meta_malformed"]);
    expect(findings[0]!.severity).toBe("warning");
    // A malformed tag must not suppress the rest of the file's findings, so the
    // other rules still ran and produced their own codes.
    const html = readFileSync(join(FIXTURES, "malformed.html"), "utf-8");
    const all = await lintHyperframeHtml(html, { filePath: "/project/index.html" });
    expect(all.findings.length).toBeGreaterThan(findings.length);
  });

  it("reads the tag from rawSource, so a scene file's template unwrap cannot hide it", async () => {
    const findings = await lintFixture("scene-with-tag.html", "/project/compositions/scene-1.html");
    expect(findings.map((f) => f.code)).toEqual(["tabario_motion_ease_outside_register"]);
    expect(findings[0]!.message).toContain("back.out(1.7)");
  });

  it("walks keyframes[].ease and easeEach, not ease alone", async () => {
    const findings = await lintFixture("bad-ease-keyframes.html");
    expect(findings.every((f) => f.code === "tabario_motion_ease_outside_register")).toBe(true);
    const eases = findings.map((f) => f.message);
    expect(eases.some((m) => m.includes("back.out(2)"))).toBe(true);
    expect(eases.some((m) => m.includes("elastic.out(1, 0.3)"))).toBe(true);
    // Each finding says which field carried the ease, because the fix differs:
    // a keyframe ease is edited in place, an easeEach governs every element.
    expect(findings.some((f) => f.message.includes("keyframes"))).toBe(true);
    expect(findings.some((f) => f.message.includes("easeEach"))).toBe(true);
  });
});
