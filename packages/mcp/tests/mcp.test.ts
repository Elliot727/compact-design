import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FigmaBridge } from "../src/bridge";
import { handleRpc } from "../src/protocol";
import { encodeStdioMessage } from "../src/stdio";
import { createToolRunner, TOOLS } from "../src/tools";

const runTool = createToolRunner(new FigmaBridge({ connectTimeoutMs: 20, jobTimeoutMs: 50 }));

function rpc(method: string, params?: unknown, id: string | number = 1) {
  return handleRpc({ jsonrpc: "2.0", id, method, params }, { runTool });
}

test("MCP adapter consumes core and html and does not talk to the Figma plugin API", () => {
  const files: string[] = [];
  const walk = (directory: string): void => readdirSync(directory).forEach((name) => {
    const path = join(directory, name);
    statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") && files.push(path);
  });
  walk("src");
  const source = files.map((path) => readFileSync(path, "utf8")).join("\n");
  assert.match(source, /from "@compact-design\/core"/);
  assert.match(source, /from "@compact-design\/html"/);
  assert.doesNotMatch(source, /\bfigma\s*\./);
  assert.doesNotMatch(source, /function (normalizeDocument|validateDocument|lintDocument)\b/);
});

test("initialize advertises tools, resources, and prompts", async () => {
  const response = await rpc("initialize", { protocolVersion: "2025-03-26" });
  assert.equal(response?.result && (response.result as { serverInfo: { name: string } }).serverInfo.name, "compact-design");
  const tools = await rpc("tools/list");
  const names = ((tools?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
  assert.deepEqual(names, TOOLS.map((tool) => tool.name));
  assert.ok(names.includes("figma_import"));
});

function toolText(response: { result?: unknown } | null): string {
  return (response?.result as { content: Array<{ text: string }> }).content[0].text;
}

test("validate accepts a compact document and rejects garbage", async () => {
  const ok = await rpc("tools/call", {
    name: "validate",
    arguments: { document: { canvas: { width: 320, height: 240 }, nodes: [{ type: "RECTANGLE", w: 40, h: 40, fill: "#6C5CFF" }] } }
  });
  assert.equal(JSON.parse(toolText(ok)).valid, true);
  const bad = await rpc("tools/call", { name: "validate", arguments: { document: { canvas: { width: "wide" }, nodes: [] } } });
  assert.equal((bad?.result as { isError?: boolean }).isError, true);
});

test("lint and render_html run without Figma", async () => {
  const document = { canvas: { width: 400, height: 240, fill: "#FFFFFF" }, nodes: [{ type: "TEXT", text: "Hello", font: { family: "Arial", style: "Regular", size: 20 }, fill: "#111111", w: 200, h: 32 }] };
  const linted = await rpc("tools/call", { name: "lint", arguments: { document } });
  assert.equal(JSON.parse(toolText(linted)).valid, true);
  const html = await rpc("tools/call", { name: "render_html", arguments: { document, title: "Hello" } });
  assert.match(toolText(html), /<!doctype html>/);
});

test("figma_import without a plugin reports a clear disconnect", async () => {
  const result = await rpc("tools/call", {
    name: "figma_import",
    arguments: { document: { canvas: { width: 100, height: 100 }, nodes: [{ type: "RECTANGLE", w: 10, h: 10, fill: "#000000" }] } }
  });
  const payload = result?.result as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(payload.isError, true);
  assert.match(payload.content[0].text, /Figma plugin|not listening|Open the Compact Design plugin/i);
});

test("notifications do not produce JSON-RPC responses", async () => {
  const response = await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { runTool });
  assert.equal(response, null);
});

test("unknown methods use the JSON-RPC method-not-found code", async () => {
  const response = await rpc("does/not/exist");
  assert.equal(response?.error?.code, -32601);
});

test("bridge completes an import through the plugin poll and result handshake", async () => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const bridge = new FigmaBridge({ port, connectTimeoutMs: 100, jobTimeoutMs: 500 });
  await bridge.listen();
  try {
    const poll = fetch(`http://localhost:${port}/poll?wait=400`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const document = { nodes: [], styles: [], variables: [] } as Parameters<typeof bridge.importDocument>[0];
    const imported = bridge.importDocument(document, "CREATE");
    const jobResponse = await poll;
    assert.equal(jobResponse.status, 200);
    const job = await jobResponse.json() as { id: string; type: string; mode: string };
    assert.equal(job.type, "import");
    assert.equal(job.mode, "CREATE");
    const resultResponse = await fetch(`http://localhost:${port}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: job.id, message: { type: "import-complete", count: 1, created: 1, warnings: [] } })
    });
    assert.equal(resultResponse.status, 200);
    assert.deepEqual(await imported, { ok: true, type: "import-complete", count: 1, created: 1, replaced: undefined, warnings: [] });
  } finally {
    await bridge.close();
  }
});

test("stdio writes newline-delimited JSON, not LSP Content-Length frames", () => {
  const line = encodeStdioMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.equal(line.startsWith("{"), true);
  assert.equal(line.endsWith("\n"), true);
  assert.doesNotMatch(line, /Content-Length/i);
  assert.deepEqual(JSON.parse(line), { jsonrpc: "2.0", id: 1, result: { ok: true } });
});
