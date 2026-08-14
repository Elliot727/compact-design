import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const files = [];
async function walk(directory) { for (const name of await readdir(directory)) { const path = join(directory, name); (await stat(path)).isDirectory() ? await walk(path) : path.endsWith(".ts") && files.push(path); } }
await walk("src");
const forbidden = /@figma\/plugin-typings|\b(SceneNode|FrameNode|TextNode|PluginAPI)\b|\bfigma\s*\./;
const explicitAny = /:\s*any\b|\bas\s+any\b|<\s*any\s*>|\bany\s*\[\s*\]|Record<[^>]*,\s*any\s*>/;
const violations = [];
for (const path of files) { const source = await readFile(path, "utf8"); if (forbidden.test(source) || explicitAny.test(source)) violations.push(path); }
if (violations.length) { console.error(`Core contains a forbidden Figma dependency or explicit any:\n${violations.join("\n")}`); process.exit(1); }
