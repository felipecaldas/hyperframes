import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const { assertSupportedJsonSchema, validateJsonSchemaValue, renderToolsSdk } = await import(
  process.env.DSH_TOOLS_MODULE!
);
const project = mkdtempSync(join(tmpdir(), "hf-output-"));
copyFileSync(process.argv[2], join(project, "gsap.min.js"));
writeFileSync(
  join(project, "index.html"),
  `<html><head><script src="gsap.min.js"></script></head><body><div data-composition-id="root" data-duration="3" data-width="1920" data-height="1080"><h1 id="title">Hello</h1></div><script>const tl=gsap.timeline({paused:true});tl.to('#title',{x:100,duration:1},0);window.__timelines={root:tl};</script></body></html>`,
);
const server = spawn(
  process.execPath,
  [new URL("../src/server.ts", import.meta.url).pathname, project],
  { stdio: ["ignore", "pipe", "inherit"] },
);
const lines = createInterface({ input: server.stdout! });
let client;
try {
  const first = await new Promise<string>((resolve) => lines.once("line", resolve));
  const { url } = JSON.parse(first);
  client = spawn(process.execPath, [new URL("../src/mcp.ts", import.meta.url).pathname], {
    env: { ...process.env, HF_INSPECT_URL: url },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const responses = createInterface({ input: client.stdout! });
  let id = 0;
  const pending = new Map();
  responses.on("line", (line) => {
    const r = JSON.parse(line);
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  const call = (method: string, params?: object) =>
    new Promise<any>((resolve, reject) => {
      const n = ++id;
      pending.set(n, resolve);
      client!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
      setTimeout(() => reject(Error("timeout")), 30000).unref();
    });
  const {
    result: { tools },
  } = await call("tools/list");
  for (const tool of tools) {
    assertSupportedJsonSchema(tool.outputSchema);
    const args =
      tool.name === "inspect_components"
        ? { targets: [{ selector: "#title" }] }
        : { range: [0, 2] };
    const { result } = await call("tools/call", { name: tool.name, arguments: args });
    assert(!result.isError, JSON.stringify(result));
    const validation = validateJsonSchemaValue(tool.outputSchema, result.structuredContent);
    assert.deepEqual(validation, [], JSON.stringify(validation));
    if (tool.name === "inspect_components")
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    else assert.equal(result.content[0].text, result.structuredContent.text);
    const selected =
      tool.name === "inspect_components"
        ? result.structuredContent.snippets.map((s: any) => s.file)
        : result.structuredContent.events
            .filter((e: any) => e.kind === "animation")
            .map((e: any) => e.start);
    assert(selected.length > 0);
    const sdk = renderToolsSdk([
      {
        name: tool.name,
        parameters: tool.inputSchema,
        output: {
          type: "object",
          properties: { structuredContent: tool.outputSchema },
          required: ["structuredContent"],
          additionalProperties: false,
        },
      },
    ]);
    assert(!sdk.includes(`${tool.name}: unknown`));
    console.log(tool.name, JSON.stringify(selected));
  }
  const bad = await call("tools/call", { name: "inspect_components", arguments: { targets: [] } });
  assert(bad.result.isError);
  assert(!("structuredContent" in bad.result));
  console.log(
    "PASS live browser/MCP output contracts, unchanged text, SDK types, field filtering, error response",
  );
} finally {
  client?.kill();
  server.kill();
  lines.close();
  await new Promise((resolve) => server.once("exit", resolve));
  rmSync(project, { recursive: true, force: true });
}
