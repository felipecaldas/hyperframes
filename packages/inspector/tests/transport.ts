import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
const server = spawn(
  process.execPath,
  ["run", new URL("../src/server.ts", import.meta.url).pathname, process.argv[2]],
  { stdio: ["ignore", "pipe", "pipe"] },
);
const lines = createInterface({ input: server.stdout });
const [first] = await Promise.race([
  new Promise<string[]>((resolve) => lines.once("line", (line) => resolve([line]))),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("service startup timeout")), 10000).unref(),
  ),
]);
const { url } = JSON.parse(first);
let client: ReturnType<typeof spawn> | undefined;
try {
  const info = await (await fetch(url + "/info")).json();
  assert.equal(info.stats.browserStarts, 0);
  client = spawn(process.execPath, ["run", new URL("../src/mcp.ts", import.meta.url).pathname], {
    env: { ...process.env, HF_INSPECT_URL: url },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const responses = createInterface({ input: client.stdout! });
  const pending = new Map<number, (value: unknown) => void>();
  responses.on("line", (line) => {
    const value = JSON.parse(line);
    pending.get(value.id)?.(value);
    pending.delete(value.id);
  });
  const call = (id: number, method: string, params?: unknown) =>
    new Promise<{ result: { content?: { text: string }[]; tools?: { name: string }[] } }>(
      (resolve, reject) => {
        pending.set(id, resolve as (value: unknown) => void);
        client!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        setTimeout(() => reject(new Error("MCP call timeout")), 30000).unref();
      },
    );
  await call(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  const list = await call(2, "tools/list");
  assert.equal(list.result.tools?.[0].name, "inspect_components");
  const inspected = await call(3, "tools/call", {
    name: "inspect_components",
    arguments: { targets: [{ selector: "#flow-title" }] },
  });
  const output = JSON.parse(inspected.result.content![0].text);
  assert.equal(output.results[0].status, "found");
  assert.equal(output.results[0].unmappedAnimations, 0);
  const next = await (await fetch(url + "/info")).json();
  assert.equal(next.stats.browserStarts, 1);
  assert.equal(next.stats.seeks, 0);
  console.log(
    JSON.stringify({
      http: true,
      mcp: true,
      lazyBrowser: true,
      bytes: Buffer.byteLength(inspected.result.content![0].text),
      stats: next.stats,
    }),
  );
} finally {
  client?.kill("SIGTERM");
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  lines.close();
}
