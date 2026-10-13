import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Inspector } from "../src/service";

const vendor = process.argv[2];
if (!vendor) throw new Error("Pass gsap.min.js");
const project = mkdtempSync(join(tmpdir(), "hf-composition-timeline-"));
copyFileSync(vendor, join(project, "gsap.js"));
writeFileSync(
  join(project, "index.html"),
  `<html><head><script src="gsap.js"></script></head><body>
<div data-composition-id="main" data-duration="30" data-width="1920" data-height="1080">
  <div data-composition-id="card" data-start="2.39" data-duration="4">
    <div id="icon"></div><div id="word"></div><div id="paused"></div>
  </div>
  <div data-composition-id="fast" data-start="10" data-duration="5" data-media-start="1" data-playback-rate="2">
    <div id="fast"></div><div id="trimmed"></div><div id="partial"></div>
  </div>
  <div data-composition-id="ramp" data-start="20" data-duration="5" data-automation='{"version":1,"lanes":[{"target":"rate","points":[{"t":0,"v":1},{"t":2,"v":3}]}]}'>
    <div id="ramp"></div>
  </div>
</div>
<script>
const main = gsap.timeline({paused:true});
const card = gsap.timeline({paused:true});
card.to('#icon',{scale:1,duration:.32},0);
card.to('#word',{opacity:1,duration:.1},.35);
const paused = gsap.timeline({paused:true});
paused.to('#paused',{x:100,duration:1},0);
card.add(paused,0);
main.add(card,99);
const fast = gsap.timeline({paused:true});
fast.to('#fast',{x:100,duration:2},2);
fast.to('#trimmed',{x:100,duration:.25},0);
fast.to('#partial',{opacity:1,duration:1},.5);
main.add(fast,99);
const ramp = gsap.timeline({paused:true});
ramp.to('#ramp',{x:100,duration:3.641},0);
window.__timelines = {main:main, card:card, fast:fast, ramp:ramp};
</script></body></html>`,
);
const inspector = new Inspector(project);
try {
  const intervals = async (selector: string) =>
    (await inspector.timeline({ component: { selector } })).events
      .filter((e) => e.kind === "animation")
      .map((e) => [e.start, e.end]);
  const close = (actual: number[][], expected: number[][]) => {
    assert.equal(actual.length, expected.length);
    actual.forEach((pair, n) =>
      pair.forEach((value, k) =>
        assert(Math.abs(value - expected[n][k]) < 0.001, `${value} != ${expected[n][k]}`),
      ),
    );
  };
  close(await intervals("#icon"), [[2.39, 2.71]]);
  close(await intervals("#word"), [[2.74, 2.84]]);
  close(await intervals("#fast"), [[10.5, 11.5]]);
  close(await intervals("#trimmed"), []);
  close(await intervals("#partial"), [[10, 10.25]]);
  close(await intervals("#ramp"), [[20, 22]]);
  const paused = await inspector.timeline({ component: { selector: "#paused" } });
  assert.equal(paused.events.length, 0);
  assert(paused.warnings.some((w) => w.includes("Paused or zero-speed")));
  assert.equal(
    (await inspector.timeline({ boundary: 2.71, component: { selector: "#icon" } })).events[0]
      .relation,
    "ends",
  );
  assert.equal(
    (await inspector.timeline({ at: 2.71, component: { selector: "#icon" } })).events.length,
    0,
  );
  console.log(
    "PASS managed paused compositions, host offsets, playback offsets/rates/ramps, paused children, boundary/at",
  );
} finally {
  await inspector.dispose();
  rmSync(project, { recursive: true, force: true });
}
