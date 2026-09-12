// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_IDLE_TIMEOUT_MS, agentStateRoot } from "./runtime.js";

const source = readFileSync(new URL("./runtime.ts", import.meta.url).pathname, "utf8");

afterEach(() => {
  delete process.env.HYPERFRAMES_STATE_DIR;
});

describe("the agent run's budget and its state root", () => {
  /**
   * The CLI's `run_check` deadline is asserted to sit below this number, so the
   * number has to be the one the run actually uses. A constant exported for a
   * cross-package assertion and then not wired to the timer would make that
   * assertion green against nothing.
   */
  it("times a run out on the constant the CLI measures itself against", () => {
    expect(AGENT_IDLE_TIMEOUT_MS).toBe(3 * 60_000);
    expect(source).toContain(
      'timeoutFromEnv("HYPERFRAMES_AGENT_IDLE_TIMEOUT_MS", AGENT_IDLE_TIMEOUT_MS)',
    );
  });

  it("stages every run under the state root, which is what makes a staged path recognisable", () => {
    // The CLI refuses to screenshot a directory outside this root, so the root
    // has to be where staging actually goes.
    expect(source).toContain('join(agentStateRoot(), projectKey(job.project.dir), "staging")');
  });

  it("moves the state root with HYPERFRAMES_STATE_DIR, so a test can point both sides at a temp dir", () => {
    expect(agentStateRoot()).toBe(join(homedir(), ".hyperframes", "studio-agent"));

    process.env.HYPERFRAMES_STATE_DIR = "/tmp/hf-state-probe";

    expect(agentStateRoot()).toBe(join("/tmp/hf-state-probe", "studio-agent"));
  });
});
