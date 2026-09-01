import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

await mkdir(".test-dist", { recursive: true });
await build({
  entryPoints: ["tests/mcp.test.ts"],
  outfile: ".test-dist/mcp.test.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: "inline"
});
const result = spawnSync(process.execPath, ["--test", ".test-dist/mcp.test.mjs"], { stdio: "inherit" });
process.exit(result.status ?? 1);
