import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyStagedAgentFiles,
  compareAgentSnapshots,
  createAgentStagingProject,
  diffAgentFiles,
  snapshotAgentFiles,
  undoAgentFiles,
  type AgentRunLedger,
} from "./files.js";

describe("agent source transactions", () => {
  it("tracks and restores created, modified, and deleted sources byte-for-byte", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "hf-agent-files-"));
    mkdirSync(join(projectDir, "compositions"));
    writeFileSync(join(projectDir, "index.html"), Buffer.from([0x61, 0x0a]));
    writeFileSync(join(projectDir, "compositions/deleted.js"), "delete me\n");
    const before = snapshotAgentFiles(projectDir);

    writeFileSync(join(projectDir, "index.html"), "modified\n");
    unlinkSync(join(projectDir, "compositions/deleted.js"));
    writeFileSync(join(projectDir, "compositions/created.css"), "body {}\n");
    const diff = diffAgentFiles(projectDir, before);
    expect(diff.changedFiles.map((file) => [file.path, file.change])).toEqual([
      ["compositions/created.css", "created"],
      ["compositions/deleted.js", "deleted"],
      ["index.html", "modified"],
    ]);
    expect(diff.undoCovered).toBe(true);

    const ledger: AgentRunLedger = {
      version: 1,
      jobId: "fixture",
      projectId: "fixture",
      projectDir,
      provider: "tabario",
      createdAt: new Date().toISOString(),
      status: "complete",
      undoCovered: true,
      before,
      changedFiles: diff.changedFiles,
    };
    expect(undoAgentFiles(projectDir, ledger)).toEqual([]);
    expect(readFileSync(join(projectDir, "index.html"))).toEqual(Buffer.from([0x61, 0x0a]));
    expect(readFileSync(join(projectDir, "compositions/deleted.js"), "utf-8")).toBe("delete me\n");
    expect(existsSync(join(projectDir, "compositions/created.css"))).toBe(false);
  });

  it("detects unsupported edits and verifies all post-run hashes before restoring", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "hf-agent-files-"));
    writeFileSync(join(projectDir, "index.html"), "before");
    writeFileSync(join(projectDir, "media.bin"), Buffer.from([1]));
    const before = snapshotAgentFiles(projectDir);
    writeFileSync(join(projectDir, "index.html"), "agent");
    writeFileSync(join(projectDir, "media.bin"), Buffer.from([2]));
    const diff = diffAgentFiles(projectDir, before);
    expect(diff.undoCovered).toBe(false);
    expect(diff.changedFiles.find((file) => file.path === "media.bin")?.supported).toBe(false);

    const sourceOnly = diff.changedFiles.filter((file) => file.path === "index.html");
    const ledger: AgentRunLedger = {
      version: 1,
      jobId: "fixture",
      projectId: "fixture",
      projectDir,
      provider: "tabario",
      createdAt: new Date().toISOString(),
      status: "complete",
      undoCovered: true,
      before,
      changedFiles: sourceOnly,
    };
    writeFileSync(join(projectDir, "index.html"), "user changed after agent");
    expect(undoAgentFiles(projectDir, ledger)).toEqual(["index.html"]);
    expect(readFileSync(join(projectDir, "index.html"), "utf-8")).toBe("user changed after agent");
  });

  it("ignores Studio thumbnail cache writes during a source transaction", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "hf-agent-files-"));
    writeFileSync(join(projectDir, "index.html"), "before");
    const before = snapshotAgentFiles(projectDir);

    mkdirSync(join(projectDir, ".thumbnails"));
    writeFileSync(join(projectDir, ".thumbnails/frame.jpg"), Buffer.from([1, 2, 3]));

    const diff = diffAgentFiles(projectDir, before);
    expect(diff.changedFiles).toEqual([]);
    expect(diff.undoCovered).toBe(true);
  });

  it("isolates staged binary writes from the live project", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "hf-agent-files-"));
    const staging = mkdtempSync(join(tmpdir(), "hf-agent-stage-"));
    writeFileSync(join(projectDir, "media.bin"), Buffer.from([1, 2, 3]));

    createAgentStagingProject(projectDir, staging);
    writeFileSync(join(staging, "media.bin"), Buffer.from([9, 9, 9]));

    expect(readFileSync(join(projectDir, "media.bin"))).toEqual(Buffer.from([1, 2, 3]));
  });

  it("tells what a run changed apart from what was put there before it started", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "hf-agent-files-"));
    const staging = mkdtempSync(join(tmpdir(), "hf-agent-stage-"));
    writeFileSync(join(projectDir, "index.html"), "before\n");
    const before = snapshotAgentFiles(projectDir);
    createAgentStagingProject(projectDir, staging);

    // Studio installs what the user picked, and only then does the run begin.
    mkdirSync(join(staging, "compositions"));
    writeFileSync(join(staging, "compositions/accent.html"), "<html></html>\n");
    const baseline = snapshotAgentFiles(staging);
    writeFileSync(join(staging, "index.html"), "after\n");
    const after = snapshotAgentFiles(staging);

    expect(compareAgentSnapshots(baseline, after).map((file) => file.path)).toEqual(["index.html"]);
    expect(compareAgentSnapshots(before, after).map((file) => file.path)).toEqual([
      "compositions/accent.html",
      "index.html",
    ]);
    expect(compareAgentSnapshots(after, after)).toEqual([]);
  });

  it("does not apply a staged file that changed after it was read", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "hf-agent-files-"));
    const staging = mkdtempSync(join(tmpdir(), "hf-agent-stage-"));
    writeFileSync(join(projectDir, "index.html"), "before\n");
    const before = snapshotAgentFiles(projectDir);
    createAgentStagingProject(projectDir, staging);
    writeFileSync(join(staging, "index.html"), "checked\n");
    const diff = diffAgentFiles(staging, before);

    writeFileSync(join(staging, "index.html"), "swapped\n");

    expect(() => applyStagedAgentFiles(projectDir, staging, before, diff.changedFiles)).toThrow(
      "staged file changed after it was checked: index.html",
    );
    expect(readFileSync(join(projectDir, "index.html"), "utf-8")).toBe("before\n");
  });

  it("refuses to apply staged source through a live symlink ancestor", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "hf-agent-files-"));
    const outside = mkdtempSync(join(tmpdir(), "hf-agent-outside-"));
    const staging = mkdtempSync(join(tmpdir(), "hf-agent-stage-"));
    writeFileSync(join(projectDir, "index.html"), "before");
    const before = snapshotAgentFiles(projectDir);
    mkdirSync(join(staging, "linked"), { recursive: true });
    writeFileSync(join(staging, "linked/escape.html"), "staged");
    symlinkSync(outside, join(projectDir, "linked"));

    const conflicts = applyStagedAgentFiles(projectDir, staging, before, [
      {
        path: "linked/escape.html",
        change: "created",
        beforeHash: null,
        afterHash: "unused",
        supported: true,
      },
    ]);

    expect(conflicts).toEqual(["linked/escape.html"]);
    expect(existsSync(join(outside, "escape.html"))).toBe(false);
  });

  it("refuses to undo through a live symlink path", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "hf-agent-files-"));
    const outside = mkdtempSync(join(tmpdir(), "hf-agent-outside-"));
    mkdirSync(join(projectDir, "linked"));
    writeFileSync(join(projectDir, "linked/index.html"), "before");
    const before = snapshotAgentFiles(projectDir);
    writeFileSync(join(projectDir, "linked/index.html"), "after");
    const changedFiles = diffAgentFiles(projectDir, before).changedFiles;
    unlinkSync(join(projectDir, "linked/index.html"));
    symlinkSync(join(outside, "outside.html"), join(projectDir, "linked/index.html"));
    writeFileSync(join(outside, "outside.html"), "after");
    const ledger: AgentRunLedger = {
      version: 1,
      jobId: "fixture",
      projectId: "fixture",
      projectDir,
      provider: "tabario",
      createdAt: new Date().toISOString(),
      status: "complete",
      undoCovered: true,
      before,
      changedFiles,
    };

    expect(undoAgentFiles(projectDir, ledger)).toEqual(["linked/index.html"]);
    expect(readFileSync(join(outside, "outside.html"), "utf-8")).toBe("after");
  });
});

/**
 * TAB-1223. Every catalog item pressed in Studio ended in a refusal, and one
 * of the three reasons was here: a block that ships an image installed a file
 * no snapshot covers, and the run was refused as an unsupported change before
 * any gate read what the model had done.
 */
describe("a catalog asset Studio staged is not the model's change", () => {
  function catalogRun(): {
    projectDir: string;
    stagingDir: string;
    before: ReturnType<typeof snapshotAgentFiles>;
    baseline: ReturnType<typeof snapshotAgentFiles>;
  } {
    const projectDir = mkdtempSync(join(tmpdir(), "hf-agent-files-"));
    writeFileSync(join(projectDir, "index.html"), "<div></div>\n");
    const before = snapshotAgentFiles(projectDir);
    const stagingDir = mkdtempSync(join(tmpdir(), "hf-agent-staging-"));
    createAgentStagingProject(projectDir, stagingDir);
    // What `installRegistryBlock` writes for a block with an asset.
    mkdirSync(join(stagingDir, "compositions"));
    mkdirSync(join(stagingDir, "assets"));
    writeFileSync(join(stagingDir, "compositions/instagram-follow.html"), "<div>block</div>\n");
    writeFileSync(join(stagingDir, "assets/avatar.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    const baseline = snapshotAgentFiles(stagingDir);
    return { projectDir, stagingDir, before, baseline };
  }

  it("is undo-covered, applied with the change, and removed by undo", () => {
    const { projectDir, stagingDir, before, baseline } = catalogRun();
    writeFileSync(join(stagingDir, "index.html"), '<div data-src="instagram-follow"></div>\n');

    const diff = diffAgentFiles(stagingDir, before, baseline);
    expect(diff.undoCovered).toBe(true);
    const asset = diff.changedFiles.find((file) => file.path === "assets/avatar.jpg");
    expect(asset).toMatchObject({ change: "created", supported: false });

    expect(applyStagedAgentFiles(projectDir, stagingDir, before, diff.changedFiles)).toEqual([]);
    expect(readFileSync(join(projectDir, "assets/avatar.jpg"))).toEqual(
      Buffer.from([0xff, 0xd8, 0xff]),
    );
    expect(existsSync(join(projectDir, "compositions/instagram-follow.html"))).toBe(true);

    const ledger: AgentRunLedger = {
      version: 1,
      jobId: "fixture",
      projectId: "fixture",
      projectDir,
      provider: "tabario",
      createdAt: new Date().toISOString(),
      status: "complete",
      undoCovered: true,
      before,
      changedFiles: diff.changedFiles,
    };
    expect(undoAgentFiles(projectDir, ledger)).toEqual([]);
    expect(existsSync(join(projectDir, "assets/avatar.jpg"))).toBe(false);
    expect(existsSync(join(projectDir, "assets"))).toBe(false);
    expect(readFileSync(join(projectDir, "index.html"), "utf-8")).toBe("<div></div>\n");
  });

  it("is the model's change again the moment the model overwrites it", () => {
    const { stagingDir, before, baseline } = catalogRun();
    writeFileSync(join(stagingDir, "assets/avatar.jpg"), Buffer.from([0x00]));

    const diff = diffAgentFiles(stagingDir, before, baseline);
    expect(diff.undoCovered).toBe(false);
  });

  it("does not cover a binary the model created on its own", () => {
    const { stagingDir, before, baseline } = catalogRun();
    writeFileSync(join(stagingDir, "assets/other.png"), Buffer.from([0x89]));

    const diff = diffAgentFiles(stagingDir, before, baseline);
    expect(diff.undoCovered).toBe(false);
  });
});
