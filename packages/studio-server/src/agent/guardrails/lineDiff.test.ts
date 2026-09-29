import { describe, expect, it } from "vitest";
import { diffHunks, splitLines, type DiffHunk } from "./lineDiff.js";

function lines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n");
}

/** The new version, rebuilt from the old one and the hunks alone. */
function replay(before: string, hunks: readonly DiffHunk[]): string[] {
  const old = splitLines(before);
  const out: string[] = [];
  let oldAt = 0;
  for (const hunk of hunks) {
    // Everything between two hunks is unchanged, so it is copied until the
    // new version is as long as the line the hunk says it starts on.
    while (out.length < hunk.startLine - 1) {
      out.push(old[oldAt] ?? "");
      oldAt += 1;
    }
    for (const line of hunk.lines) {
      if (line.kind !== "removed") out.push(line.text);
      if (line.kind !== "added") oldAt += 1;
    }
  }
  return [...out, ...old.slice(oldAt)];
}

function changed(hunks: readonly DiffHunk[]): string[] {
  return hunks.flatMap((hunk) =>
    hunk.lines
      .filter((line) => line.kind !== "context")
      .map((line) => `${line.kind === "added" ? "+" : "-"}${line.text}`),
  );
}

describe("diffHunks", () => {
  it("finds nothing between a file and itself", () => {
    expect(diffHunks(lines(40), lines(40))).toEqual([]);
  });

  it("shows one changed line with the lines around it", () => {
    const before = lines(20);
    const after = before.replace("line 10", "line ten");
    const hunks = diffHunks(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines).toEqual([
      { kind: "context", text: "line 8" },
      { kind: "context", text: "line 9" },
      { kind: "removed", text: "line 10" },
      { kind: "added", text: "line ten" },
      { kind: "context", text: "line 11" },
      { kind: "context", text: "line 12" },
    ]);
    expect(hunks[0]?.startLine).toBe(8);
    expect(hunks[0]?.endLine).toBe(12);
  });

  it("keeps two changes that are far apart in two hunks", () => {
    const after = lines(60).replace("line 5\n", "line five\n").replace("line 50\n", "line fifty\n");
    const hunks = diffHunks(lines(60), after);
    expect(hunks).toHaveLength(2);
    expect(changed(hunks)).toEqual(["-line 5", "+line five", "-line 50", "+line fifty"]);
  });

  it("joins two changes whose surroundings touch", () => {
    const after = lines(30).replace("line 10\n", "line ten\n").replace("line 13\n", "line 13!\n");
    expect(diffHunks(lines(30), after)).toHaveLength(1);
  });

  it("shows a line added at the very end", () => {
    const hunks = diffHunks(lines(5), `${lines(5)}\n<!-- stamp -->`);
    expect(changed(hunks)).toEqual(["+<!-- stamp -->"]);
    expect(hunks[0]?.endLine).toBe(6);
  });

  it("shows a line added at the very start", () => {
    const hunks = diffHunks(lines(5), `first\n${lines(5)}`);
    expect(changed(hunks)).toEqual(["+first"]);
    expect(hunks[0]?.startLine).toBe(1);
  });

  it("shows a new file as one hunk of added lines", () => {
    const hunks = diffHunks("", lines(4));
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines.every((line) => line.kind === "added")).toBe(true);
    expect(hunks[0]?.lines).toHaveLength(4);
  });

  it("shows an emptied file as one hunk of removed lines", () => {
    const hunks = diffHunks(lines(4), "");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines.every((line) => line.kind === "removed")).toBe(true);
  });

  it("does not report a change of line endings", () => {
    expect(diffHunks(lines(12).replace(/\n/g, "\r\n"), lines(12))).toEqual([]);
  });

  it("still reports the one real change in a file whose line endings changed", () => {
    const before = lines(12).replace(/\n/g, "\r\n");
    const hunks = diffHunks(before, lines(12).replace("line 6", "line six"));
    expect(changed(hunks)).toEqual(["-line 6", "+line six"]);
  });

  it("rebuilds the new version from the old one and the hunks", () => {
    const before = lines(200);
    const after = splitLines(before)
      .flatMap((line, index) => {
        if (index % 37 === 0) return [];
        if (index % 23 === 0) return [line, `inserted after ${index}`];
        if (index % 41 === 0) return [`${line} changed`];
        return [line];
      })
      .join("\n");
    expect(replay(before, diffHunks(before, after))).toEqual(splitLines(after));
  });

  it("rebuilds the new version when a block moved", () => {
    const old = splitLines(lines(80));
    const after = [
      ...old.slice(0, 10),
      ...old.slice(40, 60),
      ...old.slice(10, 40),
      ...old.slice(60),
    ];
    const hunks = diffHunks(old.join("\n"), after.join("\n"));
    expect(replay(old.join("\n"), hunks)).toEqual(after);
  });

  it("hides nothing when the two versions have nothing in common", () => {
    // Further apart than the search goes, so this is the fallback: every old
    // line removed, every new line added, and no line of either left out.
    const before = lines(2_500, "old");
    const after = lines(2_500, "new");
    const hunks = diffHunks(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines.filter((line) => line.kind === "removed")).toHaveLength(2_500);
    expect(hunks[0]?.lines.filter((line) => line.kind === "added")).toHaveLength(2_500);
    expect(replay(before, hunks)).toEqual(splitLines(after));
  });

  it("finds a small change inside a large file", () => {
    const before = lines(6_000);
    const after = before.replace("line 3000\n", "line 3000\n<!-- stamp -->\n");
    const hunks = diffHunks(before, after);
    expect(changed(hunks)).toEqual(["+<!-- stamp -->"]);
    expect(hunks[0]?.startLine).toBe(2_999);
  });
});
