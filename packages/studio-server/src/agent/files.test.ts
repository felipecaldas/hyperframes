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
