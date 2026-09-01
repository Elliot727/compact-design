import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFile } from "node:fs/promises";

await copyFile("../../LICENSE", "LICENSE");
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18"
});
const declarations = spawnSync("npx", ["tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });
process.exit(declarations.status ?? 1);
