import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

await mkdir(".test-dist", { recursive: true });
const buildResult = spawnSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });
if (buildResult.status !== 0) process.exit(buildResult.status ?? 1);
await build({ entryPoints: ["tests/boundary.test.ts"], outfile: ".test-dist/boundary.test.mjs", bundle: true, platform: "node", format: "esm", target: "node20" });
const result = spawnSync(process.execPath, ["--test", ".test-dist/boundary.test.mjs"], { stdio: "inherit" });
process.exit(result.status ?? 1);
