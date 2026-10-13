import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAdaptorServer } from "@hono/node-server";
import {
  createStudioApi,
  openProjectHistory,
  type StudioApiAdapter,
} from "@hyperframes/studio-server";
import { afterEach, expect, it } from "vitest";
import { runCommand } from "citty";
import { Hono } from "hono";
import { recordArtifact, type VideoState } from "@hyperframes/studio-server/history";
import { captureArtifactRevision } from "./artifactCapture.js";
import { historyDeps, withOwner, writeTurn } from "./historyOwner.js";
import { consumeCommandResult } from "./commandResult.js";
import check from "../commands/check.js";
const roots: string[] = [];
const originalRoot = historyDeps.historyRoot;
const originalFindServer = historyDeps.findServer;
afterEach(() => {
  historyDeps.historyRoot = originalRoot;
  historyDeps.findServer = originalFindServer;
  consumeCommandResult();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hf-artifact-revision-"));
  roots.push(dir);
  historyDeps.historyRoot = mkdtempSync(join(tmpdir(), "hf-artifact-history-"));
  roots.push(historyDeps.historyRoot);
  writeFileSync(join(dir, "index.html"), "<html>before</html>");
  const who = { kind: "agent", name: "test-agent" } as const;
  await withOwner(dir, async (owner) => {
    const turn = await owner.begin(who, "Edit video");
    writeTurn(dir, {
      ...turn,
      who,
      label: "Edit video",
      via: owner.via,
      lastWriteAt: Date.now(),
      parts: [],
    });
  });
  return {
    dir,
    state: (): VideoState =>
      JSON.parse(readFileSync(join(dir, ".hyperframes/video-state.json"), "utf8")),
  };
}
it("records edit-then-check before the next agent step, preserving the actor", async () => {
  const f = await fixture();
  for (const text of ["first", "second"]) {
    writeFileSync(join(f.dir, "index.html"), `<html>${text}</html>`);
    await runCommand(check, { rawArgs: [f.dir, "--json"] });
    consumeCommandResult();
    const state = f.state();
    const revision = state.currentRevision!;
    expect(state.checks.latest?.revision).toBe(revision);
    expect(state.checks.revisions[revision]).toHaveLength(1);
    expect(state.checks.unversioned).toHaveLength(0);
    expect(state.revisions[revision]?.actor).toEqual({ kind: "agent", name: "test-agent" });
    expect(readFileSync(state.files["index.html"]!.content, "utf8")).toBe(`<html>${text}</html>`);
  }
  const revision = f.state().currentRevision;
  await captureArtifactRevision(f.dir);
  expect(f.state().currentRevision).toBe(revision);
  expect(Object.keys(f.state().checks.revisions)).toHaveLength(2);
});
it("does not assign results when inputs change during capture", async () => {
  const f = await fixture();
  writeFileSync(join(f.dir, "index.html"), "<html>first</html>");
  const capture = await captureArtifactRevision(f.dir);
  expect(capture.revision).toBeTruthy();
  writeFileSync(join(f.dir, "index.html"), "<html>second</html>");
  const image = join(f.dir, ".hyperframes/frame.png");
  writeFileSync(image, "image");
  await recordArtifact(f.dir, capture, { kind: "snapshot", id: "frame", scope: "full", image });
  await captureArtifactRevision(f.dir);
  expect(f.state().snapshots.unversioned[0]?.attribution).toBe("inputs-changed");
  expect(f.state().snapshots.latest?.revision).toBeNull();
});

it("posts a preview checkpoint instead of sending GET", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-artifact-preview-"));
  roots.push(dir);
  historyDeps.historyRoot = mkdtempSync(join(tmpdir(), "hf-artifact-preview-history-"));
  roots.push(historyDeps.historyRoot);
  writeFileSync(join(dir, "index.html"), "<html>preview</html>");
  const history = await openProjectHistory({
    projectDir: dir,
    historyRoot: historyDeps.historyRoot,
  });
  let checkpoints = 0;
  const checkpoint = history.checkpoint.bind(history);
  history.checkpoint = () => {
    checkpoints += 1;
    return checkpoint();
  };
  const adapter = {
    listProjects: () => [],
    resolveProject: (id: string) => (id === "demo" ? { id, dir } : null),
    history: () => history,
  } as unknown as StudioApiAdapter;
  const server = createAdaptorServer({
    fetch: new Hono().route("/api", createStudioApi(adapter)).fetch,
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  historyDeps.findServer = async () =>
    ({
      port,
      host: "127.0.0.1",
      projectName: "demo",
      projectDir: dir,
      version: "test",
      pid: null,
    }) as never;
  try {
    await withOwner(dir, async (owner) => {
      expect(owner.via).toBe("preview");
      await owner.checkpoint();
    });
    expect(checkpoints).toBe(1);
  } finally {
    server.close();
    await history.close();
  }
});
