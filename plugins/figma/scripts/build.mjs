import { build, context } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");
await mkdir("dist", { recursive: true });

const shared = {
  bundle: true,
  target: "es2020",
  logLevel: "info"
};

async function buildUi() {
  const result = await build({ ...shared, entryPoints: ["src/ui/index.ts"], write: false, format: "iife" });
  const template = await readFile("src/ui/index.html", "utf8");
  const script = result.outputFiles[0].text.replaceAll("</script>", "<\\/script>");
  await writeFile("dist/ui.html", template.replace("<!-- UI_SCRIPT -->", () => `<script>${script}</script>`));
}

if (watch) {
  const plugin = await context({ ...shared, entryPoints: ["src/plugin/main.ts"], outfile: "dist/code.js", format: "iife" });
  await plugin.watch();
  await buildUi();
  console.log("Watching plugin controller. Re-run build after UI source changes.");
} else {
  await build({ ...shared, entryPoints: ["src/plugin/main.ts"], outfile: "dist/code.js", format: "iife" });
  await buildUi();
}
