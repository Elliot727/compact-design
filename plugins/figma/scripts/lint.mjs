import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const files = [];
async function walk(directory) { for (const name of await readdir(directory)) { const path = join(directory, name); (await stat(path)).isDirectory() ? await walk(path) : path.endsWith(".ts") && files.push(path); } }
await walk("src");
const violations = [];
const explicitAny = /:\s*any\b|\bas\s+any\b|<\s*any\s*>|\bany\s*\[\s*\]|Record<[^>]*,\s*any\s*>/;
for (const path of files) { const source = await readFile(path, "utf8"); if (/\.\.\/shared|\.\/normalize|\.\/validate|\.\/lint/.test(source) || explicitAny.test(source)) violations.push(path); }
if (violations.length) { console.error(`Figma adapter bypasses @compact-design/core:\n${violations.join("\n")}`); process.exit(1); }
