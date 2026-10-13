import { test } from "vitest";
import assert from "node:assert/strict";
import { collectElementDom, formatElementMap } from "../src/elementMap.js";
import { Window } from "happy-dom";

function collect(html: string) {
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.eval(`(${collectElementDom.toString()})()`) as ReturnType<typeof collectElementDom>;
}

function map(html: string) {
  return formatElementMap(collect(html));
}

test("preserves every included element and groups exact repeated siblings", () => {
  const result = map(
    '<div id="scene"><i class="particle"></i><i class="particle"></i><p>Hello</p></div>',
  );
  assert.equal(result.elementCount, 5);
  assert.equal(result.coveredCount, 5);
  assert.match(result.text, /i\.particle ×2/);
  assert.equal(result.entries.flatMap((entry) => entry.selectors).length, 5);
});

test("keeps hidden elements, wrappers, text, media, and scope", () => {
  const result = map(
    '<section data-composition-id="intro"><div hidden><img src="logo.svg"><p> Hello\n world </p></div></section>',
  );
  assert.match(result.text, /composition="intro"/);
  assert.match(result.text, /src="logo.svg"/);
  assert.match(result.text, /"Hello world"/);
  assert.equal(result.coveredCount, 5);
});

test("style changes produce no map churn and script/style bodies are omitted", () => {
  const before =
    '<div id="orb" style="color:red"></div><script>secret()</script><style>.orb{}</style>';
  assert.equal(map(before).text, map(before.replace("color:red", "color:blue")).text);
  assert.doesNotMatch(map(before).text, /secret|color|style/);
});

test("duplicate IDs and escaped selectors resolve uniquely", () => {
  const snapshot = collect(
    '<div id="same"></div><div id="same"></div><i id="a:b"></i><b class="x:y"></b>',
  );
  assert.equal(new Set(snapshot.nodes.map((node) => node.selector)).size, 5);
  assert.match(snapshot.nodes[3].selector, /\\:/);
});

test("does not group a subset under an overbroad selector", () => {
  const result = map('<i class="dot">A</i><i class="dot">A</i><i class="dot">B</i>');
  assert.doesNotMatch(result.text, /×2/);
});

test("a class superset prevents grouping under an overbroad class selector", () => {
  const result = map('<i class="dot">A</i><i class="dot">A</i><i class="dot accent">A</i>');
  assert.doesNotMatch(result.text, /×2/);
  assert.equal(result.coveredCount, 4);
});

test("grouped subtrees retain descendants and scoped positions", () => {
  const result = map('<div class="card"><i>A</i><i>B</i></div>'.repeat(3));
  assert.equal(result.coveredCount, 10);
  assert.match(result.text, /i:nth-child\(1\) ×3 "A"/);
  assert.match(result.text, /i:nth-child\(2\) ×3 "B"/);
});

test("deterministic and does not mutate captured data", () => {
  const snapshot = collect('<div class="b a">"hello"</div>');
  const original = JSON.stringify(snapshot);
  assert.deepEqual(formatElementMap(snapshot), formatElementMap(snapshot));
  assert.equal(JSON.stringify(snapshot), original);
});

test("explicitly reports unrepresented embedded surfaces", () => {
  assert.match(map("<canvas></canvas><iframe></iframe>").text, /canvas=1, iframe=1/);
});

test("deep nesting does not exponentially serialize child signatures", () => {
  const result = map("<div>".repeat(100) + "Deep" + "</div>".repeat(100));
  assert.equal(result.elementCount, 101);
  assert.equal(result.coveredCount, 101);
});

test("embedded media uses a deterministic identifier instead of its payload", () => {
  const first = map('<img src="data:image/png;base64,' + "A".repeat(20000) + '">');
  const second = map('<img src="data:image/png;base64,' + "B".repeat(20000) + '">');
  assert(first.text.length < 200);
  assert.match(first.text, /data:image\/png#sha256:[a-f0-9]{16}/);
  assert.notEqual(first.text, second.text);
});

test("blob URLs identify runtime media without claiming a persistent asset identity", () => {
  assert.equal(
    map('<img src="blob:https://example.com/one">').text,
    map('<img src="blob:https://example.com/two">').text,
  );
  assert.match(map('<img src="blob:https://example.com/one">').text, /blob:runtime/);
});
