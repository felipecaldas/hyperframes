// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compareAgentSnapshots, type AgentFileSnapshot } from "../files.js";
import { placementRefusal, type CatalogMount } from "./catalogMount.js";

function snapshot(files: Record<string, string>): AgentFileSnapshot {
  const out: AgentFileSnapshot = { files: {}, sourceContents: {} };
  for (const [path, content] of Object.entries(files)) {
    const buffer = Buffer.from(content, "utf-8");
    out.files[path] = { hash: createHash("sha256").update(buffer).digest("hex"), supported: true };
    out.sourceContents[path] = buffer.toString("base64");
  }
  return out;
}

const MOUNT =
  '<div data-composition-id="lt-clean-bar" data-composition-src="compositions/lt-clean-bar.html" ' +
  'data-duration="4.8" data-width="1080" data-height="1920"></div>';
const BLOCK: CatalogMount = {
  item: "lt-clean-bar",
  type: "hyperframes:block",
  file: "compositions/lt-clean-bar.html",
  files: ["compositions/lt-clean-bar.html"],
  snippet: MOUNT,
};
const ITEM = '<div data-composition-id="lt-clean-bar"><p id="lt-name">[Your Name]</p></div>\n';
const INDEX =
  '<html>\n  <body>\n    <div id="root" data-width="1080" data-height="1920">\n' +
  '      <div id="caption-0" class="clip" data-start="0" data-duration="1.1"></div>\n' +
  "    </div>\n  </body>\n</html>\n";
const BEFORE = { "index.html": INDEX, "compositions/lt-clean-bar.html": ITEM };
const PLACED = MOUNT.replace("></div>", ' data-start="0.000" data-track-index="16"></div>');

function ruling(mount: CatalogMount, after: Record<string, string>) {
  const baseline = snapshot(BEFORE);
  const staged = snapshot(after);
  return placementRefusal(mount, compareAgentSnapshots(baseline, staged), baseline, staged);
}

describe("what a catalog run may change (TAB-1223)", () => {
  it("lets the mount element through, with its start and track, on any line", () => {
    const index = INDEX.replace('<div id="caption-0"', `${PLACED}\n      <div id="caption-0"`);
    expect(ruling(BLOCK, { ...BEFORE, "index.html": index })).toBeNull();
  });

  it("lets the item's own file be fitted, whatever the fit is", () => {
    const item = ITEM.replace("[Your Name]", "Felipe Caldas").replace("<p", '<p style="color:red"');
    expect(ruling(BLOCK, { ...BEFORE, "compositions/lt-clean-bar.html": item })).toBeNull();
  });

  it("lets a dependency the install wrote be fitted too", () => {
    const mount = { ...BLOCK, files: [...BLOCK.files, "compositions/components/part.html"] };
    const before = { ...BEFORE, "compositions/components/part.html": "<p>part</p>\n" };
    const baseline = snapshot(before);
    const staged = snapshot({ ...before, "compositions/components/part.html": "<p>fitted</p>\n" });
    expect(
      placementRefusal(mount, compareAgentSnapshots(baseline, staged), baseline, staged),
    ).toBeNull();
  });

  it("refuses an attribute added to an element that was already there, next to the mount", () => {
    const index = INDEX.replace("<body>", '<body data-qa-stamp="ok">').replace(
      '<div id="caption-0"',
      `${PLACED}\n      <div id="caption-0"`,
    );
    const refusal = ruling(BLOCK, { ...BEFORE, "index.html": index });
    expect(refusal).toMatchObject({ gate: "unasked-change", stage: "apply", file: "index.html" });
    expect(refusal?.message).toContain(
      "index.html holds more than the element that mounts lt-clean-bar",
    );
    expect(refusal?.message).not.toContain("data-qa-stamp");
  });

  it("refuses the block's markup pasted in place of a mount", () => {
    const index = INDEX.replace('<div id="caption-0"', `${ITEM}      <div id="caption-0"`);
    expect(ruling(BLOCK, { ...BEFORE, "index.html": index })?.gate).toBe("unasked-change");
  });

  it("refuses a mount that carries content of its own, or one of another item", () => {
    const filled = PLACED.replace("></div>", "><p>hello</p></div>");
    expect(
      ruling(BLOCK, { ...BEFORE, "index.html": INDEX.replace("</body>", `${filled}</body>`) })
        ?.gate,
    ).toBe("unasked-change");
    const other = PLACED.replace("compositions/lt-clean-bar.html", "compositions/other.html");
    expect(
      ruling(BLOCK, { ...BEFORE, "index.html": INDEX.replace("</body>", `${other}</body>`) })?.gate,
    ).toBe("unasked-change");
  });

  it("refuses a file the run made for the item, and one it removed", () => {
    const made = ruling(BLOCK, { ...BEFORE, "compositions/lt-clean-bar-clip.html": ITEM });
    expect(made).toMatchObject({
      gate: "unasked-change",
      file: "compositions/lt-clean-bar-clip.html",
    });
    expect(made?.message).toContain("is not the item and is not where it is placed");
    const { "index.html": _gone, ...rest } = BEFORE;
    expect(ruling(BLOCK, rest)?.file).toBe("index.html");
  });

  it("refuses a change to a file that is not a composition", () => {
    const before = { ...BEFORE, "styles.css": "body{}" };
    const baseline = snapshot(before);
    const staged = snapshot({ ...before, "styles.css": "body{color:red}" });
    expect(
      placementRefusal(BLOCK, compareAgentSnapshots(baseline, staged), baseline, staged)?.file,
    ).toBe("styles.css");
  });

  it("does not mind whitespace, which is layout in an editor and nothing on a timeline", () => {
    const index = INDEX.replace("</body>", `  ${PLACED}\n\n\n</body>`).replace(/\n {2}/g, "\n");
    expect(ruling(BLOCK, { ...BEFORE, "index.html": index })).toBeNull();
  });

  it("leaves a component's paste to the check, but still refuses a file made for it", () => {
    const component: CatalogMount = {
      item: "grain-overlay",
      type: "hyperframes:component",
      file: "compositions/components/grain-overlay.html",
      files: ["compositions/components/grain-overlay.html"],
      snippet:
        "<!-- paste from compositions/components/grain-overlay.html into your composition -->",
    };
    const before = {
      ...BEFORE,
      "compositions/components/grain-overlay.html": '<div class="grain"></div>\n',
    };
    const baseline = snapshot(before);
    const pasted = snapshot({
      ...before,
      "index.html": INDEX.replace("</body>", '<div class="grain"></div></body>'),
    });
    expect(
      placementRefusal(component, compareAgentSnapshots(baseline, pasted), baseline, pasted),
    ).toBeNull();
    const made = snapshot({ ...before, "compositions/grain.html": "<div></div>" });
    expect(
      placementRefusal(component, compareAgentSnapshots(baseline, made), baseline, made)?.file,
    ).toBe("compositions/grain.html");
  });
});
