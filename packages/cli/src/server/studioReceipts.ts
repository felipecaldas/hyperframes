import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Where the pictures Tabario AI makes for the founder live.
 *
 * Deliberately a sibling of `studio-agent/`, never a child: the agent's staging
 * dir is removed the instant a run ends (runtime.ts's `rmSync`), and a receipt
 * written inside it would be deleted before anyone opened the link (D44). Read
 * at call time so `HYPERFRAMES_STATE_DIR` moves both roots together.
 */
export function studioReceiptsRoot(): string {
  const override = process.env.HYPERFRAMES_STATE_DIR?.trim();
  return override
    ? resolve(override, "studio-receipts")
    : join(homedir(), ".hyperframes", "studio-receipts");
}

/** The single route prefix every receipt URL is served under. */
export const RECEIPTS_URL_PREFIX = "/studio/receipts";

/** How long a receipt is kept before `sweep` removes it. */
const RECEIPT_RETENTION_DAYS = 7;

/**
 * The session segment for one staged run.
 *
 * Derived from the staging dir rather than carried in from Studio, because the
 * adapter methods are handed a directory and nothing else. Every receipt from
 * one run therefore shares one directory, and two runs never collide.
 */
export function receiptSessionId(stagingDir: string): string {
  return createHash("sha256").update(resolve(stagingDir)).digest("hex").slice(0, 24);
}

export interface StoredReceipt {
  /** 32 hex characters — 128 bits of randomness. */
  id: string;
  /** The stored filename, id plus the original extension. */
  file: string;
  /** Absolute path on this disk. */
  path: string;
  /** Path the receipt is served at. */
  url: string;
}

/** One path segment, with no way out of the directory it names. */
function isSafeSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment.length <= 128 &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !segment.includes("\0") &&
    segment !== "." &&
    segment !== ".."
  );
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * What a capture needs from the store, and no more.
 *
 * Declared here rather than beside the captures so `ReceiptStore` can say it
 * implements it. A test stands in for the whole of this, which is why it is
 * narrower than the class: nothing that writes a receipt gets `sweep`.
 */
export interface ReceiptWriter {
  rootDir: string;
  put(
    session: string,
    revision: string,
    name: string,
    bytes: Buffer,
  ): { url: string; path: string };
  captureDir(session: string, revision: string): string;
  contains(candidate: string): boolean;
}

/**
 * The receipts store: `<root>/<session>/<revision>/<id><ext>`.
 *
 * It holds bytes and hands back links. It does not authorise anything and must
 * not pretend to: the compositor strips the Tabario session cookie before it
 * forwards a request (`video-compositor/src/studio/proxy.ts:116`), so this
 * server has no identity to check. What it can do is make a path nobody can
 * guess, which is why `id` is 128 random bits rather than a counter or the
 * frame's timestamp.
 */
export class ReceiptStore implements ReceiptWriter {
  readonly rootDir: string;
  private readonly projectKey: string | undefined;

  constructor(rootDir: string = studioReceiptsRoot(), projectDir?: string) {
    this.rootDir = resolve(rootDir);
    this.projectKey = projectDir === undefined ? undefined : receiptSessionId(projectDir);
  }

  /** Write bytes and return the link to them. */
  put(session: string, revision: string, name: string, bytes: Buffer): StoredReceipt {
    if (!isSafeSegment(session) || !isSafeSegment(revision)) {
      throw new Error("a receipt needs a session and a revision that are single path segments");
    }
    const id = randomBytes(16).toString("hex");
    const file = `${id}${extname(name) || ".png"}`;
    const dir = join(this.rootDir, session, revision);
    mkdirSync(dir, { recursive: true });
    if (this.projectKey !== undefined) {
      const ownerPath = join(dir, ".owner.json");
      if (existsSync(ownerPath)) {
        if (!this.owns(dir)) throw new Error("receipt owner mismatch");
      } else {
        writeFileSync(ownerPath, JSON.stringify({ projectKey: this.projectKey }), { flag: "wx" });
      }
    }
    const path = join(dir, file);
    writeFileSync(path, bytes);
    return { id, file, path, url: `${RECEIPTS_URL_PREFIX}/${session}/${revision}/${file}` };
  }

  /** The bytes behind a receipt URL, or null when there is nothing there. */
  get(session: string, revision: string, file: string): Buffer | null {
    if (![session, revision, file].every(isSafeSegment)) return null;
    if (!/^[a-f0-9]{32}\.(png|jpg|jpeg)$/.test(file)) return null;
    if (this.projectKey !== undefined && !this.owns(join(this.rootDir, session, revision)))
      return null;
    const path = join(this.rootDir, session, revision, file);
    if (!isWithin(this.rootDir, path) || !existsSync(path) || !statSync(path).isFile()) return null;
    return readFileSync(path);
  }

  private owns(dir: string): boolean {
    try {
      const owner: unknown = JSON.parse(readFileSync(join(dir, ".owner.json"), "utf-8"));
      return (
        typeof owner === "object" &&
        owner !== null &&
        "projectKey" in owner &&
        owner.projectKey === this.projectKey
      );
    } catch {
      return false;
    }
  }

  /**
   * A fresh directory under the store for one capture to write into.
   *
   * Needed because `captureSnapshots` clears every PNG and JPEG in the
   * directory it is given before it writes, so two captures sharing one
   * directory would delete each other's frames. It is under the receipts root
   * so the output-containment rule holds for it too.
   */
  captureDir(session: string, revision: string): string {
    if (!isSafeSegment(session) || !isSafeSegment(revision)) {
      throw new Error("a capture needs a session and a revision that are single path segments");
    }
    const dir = join(this.rootDir, session, revision, `.capture-${randomBytes(8).toString("hex")}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Whether a path is somewhere this store is allowed to write. */
  contains(candidate: string): boolean {
    return isWithin(this.rootDir, candidate);
  }

  /**
   * Remove receipts older than the retention window, and any directory left
   * empty behind them. Returns how many files went.
   */
  sweep(olderThanDays: number = RECEIPT_RETENTION_DAYS): number {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    return this.sweepDir(this.rootDir, cutoff);
  }

  private sweepDir(dir: string, cutoff: number): number {
    if (!existsSync(dir)) return 0;
    let removed = 0;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        removed += this.sweepDir(path, cutoff);
        if (readdirSync(path).length === 0 && path !== this.rootDir) {
          rmSync(path, { recursive: true, force: true });
        }
        continue;
      }
      if (stat.mtimeMs < cutoff) {
        rmSync(path, { force: true });
        removed += 1;
      }
    }
    return removed;
  }
}

/** Split a receipt request path into its three segments, or null if it is not one. */
export function parseReceiptPath(
  path: string,
): { session: string; revision: string; file: string } | null {
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length !== 3) return null;
  const [session, revision, file] = segments as [string, string, string];
  if (!isSafeSegment(session) || !isSafeSegment(revision) || !isSafeSegment(file)) return null;
  return { session, revision, file };
}
