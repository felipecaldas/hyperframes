import { describe, expect, it } from "vitest";
import {
  readCompositionSizeFromDocument,
  runtimeUrlForFallbackInjection,
} from "./composition-probe.js";

describe("readCompositionSizeFromDocument", () => {
  it("reads dimensions from the composition root", () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML =
      '<div data-composition-id="main" data-width="1080" data-height="1920"></div>';

    expect(readCompositionSizeFromDocument(doc)).toEqual({ width: 1080, height: 1920 });
  });

  it("falls back to plain data-width/data-height compositions", () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = '<div class="clip" data-width="1080" data-height="1920"></div>';

    expect(readCompositionSizeFromDocument(doc)).toEqual({ width: 1080, height: 1920 });
  });

  it("ignores invalid dimensions", () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = '<div data-width="0" data-height="1920"></div>';

    expect(readCompositionSizeFromDocument(doc)).toBeNull();
  });
});

// Tabario fork (TAB-746). Replaces upstream's `runtimeCdnUrlForVersion` tests:
// the fallback no longer builds a versioned CDN URL, so there is no version to
// pin and no malformed-version case to reject.
describe("fallback runtime injection", () => {
  it("injects from our own origin when no build define is applied", () => {
    // No define is applied here, exactly as in the Studio bundle — the case
    // that previously resolved to @hyperframes/core@0.0.0-dev on jsdelivr, a
    // version that does not exist.
    expect(runtimeUrlForFallbackInjection()).toBe("/api/runtime.js");
  });

  it("never points at a third-party host", () => {
    expect(runtimeUrlForFallbackInjection()).not.toMatch(/^https?:\/\//);
  });
});
