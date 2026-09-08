// @vitest-environment node

import { describe, expect, it } from "vitest";
import { describeSelectedElement, isAgentSelectedElement } from "./selection.js";

describe("agent selection (TAB-1063)", () => {
  const selection = { id: "caption-0", label: "Caption 0", start: 0, duration: 3.25 };

  it("accepts what Studio sends and nothing looser", () => {
    expect(isAgentSelectedElement(selection)).toBe(true);
    expect(isAgentSelectedElement({ ...selection, sourceFile: "compositions/a.html" })).toBe(true);
    expect(isAgentSelectedElement(undefined)).toBe(false);
    expect(isAgentSelectedElement("caption-0")).toBe(false);
    expect(isAgentSelectedElement({ ...selection, id: "" })).toBe(false);
    expect(isAgentSelectedElement({ ...selection, label: "x".repeat(201) })).toBe(false);
    expect(isAgentSelectedElement({ ...selection, start: -1 })).toBe(false);
    expect(isAgentSelectedElement({ ...selection, duration: Number.NaN })).toBe(false);
    expect(isAgentSelectedElement({ ...selection, sourceFile: 3 })).toBe(false);
  });

  it("names the element the way the timeline does and the way the file does", () => {
    const text = describeSelectedElement(selection);
    expect(text).toContain('"Caption 0"');
    expect(text).toContain('id "caption-0" in index.html');
    expect(text).toContain("from 0.0s to 3.3s");
    expect(text).toContain("Read it before answering");
    expect(describeSelectedElement({ ...selection, sourceFile: "compositions/a.html" })).toContain(
      "in compositions/a.html",
    );
  });
});
