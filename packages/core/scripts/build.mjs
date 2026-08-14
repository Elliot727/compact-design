import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFile } from "node:fs/promises";

await copyFile("../../LICENSE", "LICENSE");
await Promise.all([
  build({ entryPoints: ["src/index.ts"], outfile: "dist/index.js", bundle: true, platform: "neutral", format: "esm", target: "es2022" }),
  build({ entryPoints: ["src/index.ts"], outfile: "dist/index.cjs", bundle: true, platform: "node", format: "cjs", target: "node18" })
]);
const declarations = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], { stdio: "inherit" });
process.exit(declarations.status ?? 1);
