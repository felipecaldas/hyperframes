// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DomEditSelection } from "./domEditing";
import {
  FlatCaptionSection,
  applyCaptionStyleToAll,
  captionStyleSummary,
  collectCaptionStyleAttrs,
  isCaptionSelection,
} from "./propertyPanelFlatCaptionSection";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

function makeCaption(index: number, attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement("div");
  el.id = `caption-${index}`;
  el.className = "clip hf-captions";
  el.setAttribute("data-hf-atomic", "");
  el.setAttribute("data-hf-label", `Caption ${index + 1}`);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  const word = document.createElement("span");
  word.id = `caption-${index}-w0`;
  word.className = "hf-caption-word";
  word.textContent = "word";
  el.appendChild(word);
  document.body.appendChild(el);
  return el;
}

function selectionFor(el: HTMLElement): DomEditSelection {
  return { element: el, id: el.id, label: el.id } as unknown as DomEditSelection;
}

describe("isCaptionSelection", () => {
  it("requires both data-hf-atomic and the hf-captions class", () => {
    const caption = makeCaption(0);
    expect(isCaptionSelection(selectionFor(caption))).toBe(true);

    const atomicOnly = document.createElement("div");
    atomicOnly.setAttribute("data-hf-atomic", "");
    expect(isCaptionSelection(selectionFor(atomicOnly))).toBe(false);

    const classOnly = document.createElement("div");
    classOnly.className = "hf-captions";
    expect(isCaptionSelection(selectionFor(classOnly))).toBe(false);
  });
});

describe("collectCaptionStyleAttrs / captionStyleSummary", () => {
  it("collects exactly the style attributes the inspector owns", () => {
    const caption = makeCaption(0, {
      "data-active-color": "#3ce6ac",
      "data-rest-color": "#ffffff",
      "data-active-scale": "1.12",
      "data-start": "0.400",
    });
    expect(collectCaptionStyleAttrs(caption)).toEqual({
      "active-color": "#3ce6ac",
      "rest-color": "#ffffff",
      "active-scale": "1.12",
    });
    expect(captionStyleSummary(selectionFor(caption))).toBe("#3ce6ac · ×1.12");
  });

  it("collects nothing from a caption with no style attributes", () => {
    const caption = makeCaption(0);
    expect(collectCaptionStyleAttrs(caption)).toEqual({});
    expect(captionStyleSummary(selectionFor(caption))).toBe("default");
  });
});

describe("applyCaptionStyleToAll", () => {
  it("commits the source style once per other caption", async () => {
    const source = makeCaption(0, { "data-active-color": "#3ce6ac", "data-active-scale": "1.3" });
    makeCaption(1, { "data-active-color": "#ffd400" });
    makeCaption(2);
    const commits: Array<{ id: string | undefined; attrs: Record<string, string> }> = [];
    const onSetAttributes = vi.fn(
      async (selection: DomEditSelection, attrs: Record<string, string>) => {
        commits.push({ id: selection.id ?? selection.element.id, attrs });
      },
    );

    const applied = await applyCaptionStyleToAll({
      doc: document,
      sourceEl: source,
      activeCompositionPath: "index.html",
      onSetAttributes,
    });

    expect(applied).toBe(3);
    expect(commits.map((c) => c.id)).toEqual(["caption-1", "caption-2"]);
    for (const commit of commits) {
      expect(commit.attrs).toEqual({ "active-color": "#3ce6ac", "active-scale": "1.3" });
    }
  });

  it("does nothing when the source caption has no style attributes", async () => {
    const source = makeCaption(0);
    makeCaption(1, { "data-active-color": "#ffd400" });
    const onSetAttributes = vi.fn(async () => {});

    const applied = await applyCaptionStyleToAll({
      doc: document,
      sourceEl: source,
      activeCompositionPath: null,
      onSetAttributes,
    });

    expect(applied).toBe(0);
    expect(onSetAttributes).not.toHaveBeenCalled();
  });
});

describe("FlatCaptionSection", () => {
  it("renders the three highlight controls for a caption selection", async () => {
    const caption = makeCaption(0, {
      "data-active-color": "#3ce6ac",
      "data-rest-color": "#ffffff",
      "data-active-scale": "1.12",
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <FlatCaptionSection
          element={selectionFor(caption)}
          onSetAttribute={vi.fn()}
          onSetAttributes={vi.fn(async () => {})}
        />,
      );
    });

    expect(host.textContent).toContain("Active color");
    expect(host.textContent).toContain("Rest color");
    expect(host.textContent).toContain("Pop scale");
    // No StudioShell context in this render, so the cross-caption action —
    // which needs the preview document — must not be offered.
    expect(host.querySelector("[data-flat-caption-apply-all]")).toBeNull();
    await act(async () => root.unmount());
  });
});
