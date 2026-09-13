import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReceiptStore, receiptSessionId, studioReceiptsRoot } from "./studioReceipts.js";

const dirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.HYPERFRAMES_STATE_DIR;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PNG = Buffer.from("not a real png, but real bytes", "utf-8");

describe("ReceiptStore", () => {
  it("binds receipts to the published project, across server restarts", () => {
    const root = tmpDir("hf-receipts-owned-");
    const first = new ReceiptStore(root, "/published/run-a/project");
    const foreign = new ReceiptStore(root, "/published/run-b/project");
    const receipt = first.put("session-1", "rev-1", "frame.png", PNG);
    expect(foreign.get("session-1", "rev-1", receipt.file)).toBeNull();
    expect(
      new ReceiptStore(root, "/published/run-a/project").get("session-1", "rev-1", receipt.file),
    ).toEqual(PNG);
    expect(() => foreign.put("session-1", "rev-1", "frame.png", PNG)).toThrow("owner");
  });

  it("does not serve ownership metadata or an unowned legacy receipt", () => {
    const root = tmpDir("hf-receipts-legacy-");
    const legacy = new ReceiptStore(root);
    const receipt = legacy.put("session-1", "rev-1", "frame.png", PNG);
    const owned = new ReceiptStore(root, "/published/run-a/project");
    expect(owned.get("session-1", "rev-1", receipt.file)).toBeNull();
    expect(owned.get("session-1", "rev-1", ".owner.json")).toBeNull();
  });

  // D44: the agent's staging dir is removed the moment a run ends, so a
  // receipt written inside it would be gone before the founder clicked the
  // link. This is the test that says so.
  it("a receipt outlives the staging dir it was captured from", () => {
    const stateDir = tmpDir("hf-receipts-state-");
    const stagingDir = join(stateDir, "studio-agent", "abc", "staging", "job-1");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "index.html"), "<html></html>");
    const store = new ReceiptStore(join(stateDir, "studio-receipts"));

    const receipt = store.put("session-1", "rev-1", "frame-at-2.00s.png", PNG);
    rmSync(stagingDir, { recursive: true, force: true });

    expect(existsSync(stagingDir)).toBe(false);
    expect(store.rootDir.startsWith(stagingDir)).toBe(false);
    expect(store.get("session-1", "rev-1", receipt.file)).toEqual(PNG);
  });

  it("the URL carries the session and the revision the receipt depicts", () => {
    const store = new ReceiptStore(tmpDir("hf-receipts-"));

    const receipt = store.put("session-1", "9f8e7d6c5b4a", "frame-at-2.00s.png", PNG);

    expect(receipt.url).toBe(`/studio/receipts/session-1/9f8e7d6c5b4a/${receipt.file}`);
    expect(receipt.url).toContain("9f8e7d6c5b4a");
  });

  // The fork server never learns who is asking — the compositor strips the
  // Tabario session cookie before forwarding (proxy.ts:116) — so the path's own
  // unguessability is the control that lives on this side.
  it("names each receipt with 128 bits of randomness, so two puts of one name differ", () => {
    const store = new ReceiptStore(tmpDir("hf-receipts-"));

    const first = store.put("session-1", "rev-1", "frame.png", PNG);
    const second = store.put("session-1", "rev-1", "frame.png", PNG);

    expect(first.id).toMatch(/^[0-9a-f]{32}$/);
    expect(second.id).toMatch(/^[0-9a-f]{32}$/);
    expect(second.id).not.toBe(first.id);
    expect(store.get("session-1", "rev-1", first.file)).toEqual(PNG);
  });

  it("sweeps a receipt older than the retention window and keeps a fresh one", () => {
    const store = new ReceiptStore(tmpDir("hf-receipts-"));
    const stale = store.put("session-1", "rev-1", "old.png", PNG);
    const fresh = store.put("session-1", "rev-1", "new.png", PNG);
    const eightDaysAgo = Date.now() / 1000 - 8 * 24 * 60 * 60;
    utimesSync(stale.path, eightDaysAgo, eightDaysAgo);

    const removed = store.sweep(7);

    expect(removed).toBe(1);
    expect(store.get("session-1", "rev-1", stale.file)).toBeNull();
    expect(store.get("session-1", "rev-1", fresh.file)).toEqual(PNG);
  });

  it("refuses to serve a path that climbs out of the store", () => {
    const store = new ReceiptStore(tmpDir("hf-receipts-"));
    store.put("session-1", "rev-1", "frame.png", PNG);

    expect(store.get("..", "rev-1", "frame.png")).toBeNull();
    expect(store.get("session-1", "rev-1", "../rev-1/frame.png")).toBeNull();
  });

  it("keeps the receipts root outside the agent's staging root", () => {
    const stateDir = tmpDir("hf-receipts-state-");
    process.env.HYPERFRAMES_STATE_DIR = stateDir;

    expect(studioReceiptsRoot().startsWith(join(stateDir, "studio-agent"))).toBe(false);
    expect(studioReceiptsRoot()).toBe(join(stateDir, "studio-receipts"));
  });

  it("gives one staged run one session id, and two runs different ones", () => {
    const first = receiptSessionId("/tmp/staging/job-1-aaa");
    const again = receiptSessionId("/tmp/staging/job-1-aaa");
    const other = receiptSessionId("/tmp/staging/job-2-bbb");

    expect(first).toBe(again);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^[0-9a-f]{24}$/);
  });
});
