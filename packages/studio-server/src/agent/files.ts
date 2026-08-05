import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AgentChangedFile } from "./types.js";

const IGNORED_DIRS = new Set([
  ".git",
  ".thumbnails",
  "node_modules",
  "dist",
  "renders",
  "snapshots",
  "coverage",
  ".cache",
]);

const SOURCE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".cjs",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

export interface AgentFileSnapshot {
  files: Record<string, { hash: string; supported: boolean }>;
  sourceContents: Record<string, string>;
}

export interface AgentRunLedger {
  version: 1;
  jobId: string;
  projectId: string;
  projectDir: string;
  provider: "codex" | "claude";
  createdAt: string;
  completedAt?: string;
  status: "running" | "complete" | "cancelled" | "failed" | "undone";
  undoCovered: boolean;
  before: AgentFileSnapshot;
  changedFiles: AgentChangedFile[];
}

function normalizedRelative(projectDir: string, path: string): string | null {
  const rel = relative(resolve(projectDir), resolve(path));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep).join("/");
}

function isSupportedSource(path: string): boolean {
  if (path === ".hyperframes/frame-comments.json") return true;
  const dot = path.lastIndexOf(".");
  return dot >= 0 && SOURCE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function walkProject(projectDir: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const abs = join(dir, entry.name);
      const rel = normalizedRelative(projectDir, abs);
      if (!rel) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) visit(abs);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  };
  visit(projectDir);
  return files.sort();
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function snapshotAgentFiles(projectDir: string): AgentFileSnapshot {
  const files: AgentFileSnapshot["files"] = {};
  const sourceContents: AgentFileSnapshot["sourceContents"] = {};
  for (const path of walkProject(projectDir)) {
    const buffer = readFileSync(join(projectDir, path));
    const supported = isSupportedSource(path);
    files[path] = { hash: hashBuffer(buffer), supported };
    if (supported) sourceContents[path] = buffer.toString("base64");
  }
  return { files, sourceContents };
}

export function diffAgentFiles(
  projectDir: string,
  before: AgentFileSnapshot,
): { after: AgentFileSnapshot; changedFiles: AgentChangedFile[]; undoCovered: boolean } {
  const after = snapshotAgentFiles(projectDir);
  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  const changedFiles: AgentChangedFile[] = [];
  for (const path of [...paths].sort()) {
    const oldFile = before.files[path];
    const newFile = after.files[path];
    if (oldFile?.hash === newFile?.hash) continue;
    changedFiles.push({
      path,
      change: oldFile ? (newFile ? "modified" : "deleted") : "created",
      beforeHash: oldFile?.hash ?? null,
      afterHash: newFile?.hash ?? null,
      supported: oldFile?.supported ?? newFile?.supported ?? false,
    });
  }
  return {
    after,
    changedFiles,
    undoCovered: changedFiles.every((file) => file.supported),
  };
}

function currentHash(path: string): string | null {
  return existsSync(path) && statSync(path).isFile() ? hashBuffer(readFileSync(path)) : null;
}

export function undoAgentFiles(projectDir: string, ledger: AgentRunLedger): string[] {
  const conflicts = ledger.changedFiles
    .filter((file) => currentHash(join(projectDir, file.path)) !== file.afterHash)
    .map((file) => file.path);
  if (conflicts.length > 0) return conflicts;

  for (const file of ledger.changedFiles) {
    const abs = join(projectDir, file.path);
    const before = ledger.before.sourceContents[file.path];
    if (before === undefined) {
      if (existsSync(abs)) unlinkSync(abs);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(before, "base64"));
  }
  removeEmptyDirectories(
    projectDir,
    ledger.changedFiles.map((file) => dirname(file.path)),
  );
  return [];
}

function removeEmptyDirectories(projectDir: string, dirs: string[]): void {
  for (const rel of [...new Set(dirs)].sort((a, b) => b.length - a.length)) {
    if (rel === ".") continue;
    const abs = join(projectDir, rel);
    try {
      if (existsSync(abs) && readdirSync(abs).length === 0) rmSync(abs, { recursive: false });
    } catch {
      // A non-empty or concurrently changed directory must remain.
    }
  }
}

export function writeLedger(path: string, ledger: AgentRunLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`, "utf-8");
}

export function readLedger(path: string): AgentRunLedger | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1) {
      return null;
    }
    return value as AgentRunLedger;
  } catch {
    return null;
  }
}
