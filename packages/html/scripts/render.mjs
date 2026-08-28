#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o" },
    title: { type: "string" },
    help: { type: "boolean", short: "h" }
  }
});

if (values.help || positionals.length !== 1) {
  console.error("Usage: compact-design-html <document.json> [-o out.html] [--title Title]");
  process.exit(values.help ? 0 : 1);
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");

function resolveExistingPath(input) {
  if (isAbsolute(input)) return input;
  const candidates = [
    resolve(process.cwd(), input),
    process.env.INIT_CWD ? resolve(process.env.INIT_CWD, input) : "",
    resolve(repoRoot, input)
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) || candidates[0];
}

function resolveOutputPath(input) {
  if (isAbsolute(input)) return input;
  return resolve(process.env.INIT_CWD || process.cwd(), input);
}

const { render, RenderError } = await import("../dist/index.js");
const input = resolveExistingPath(positionals[0]);
const source = await readFile(input, "utf8");
let document;
try {
  document = JSON.parse(source);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

try {
  const result = render(document, { title: values.title });
  if (values.out) {
    const out = resolveOutputPath(values.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, result.html);
  } else {
    process.stdout.write(result.html);
  }
} catch (error) {
  if (error instanceof RenderError) {
    console.error(error.message);
    for (const issue of error.issues) console.error(`  ${issue.path}: ${issue.message}`);
    process.exit(1);
  }
  throw error;
}
