#!/usr/bin/env node
/**
 * Bumps @compact-design/core, html, and mcp in lockstep, rewrites workspace
 * dependency pins, refreshes the lockfile, and prepends a CHANGELOG section
 * from commits since the last v* tag (or recent history when untagged).
 *
 * Usage: node scripts/prepare-batch-release.mjs [minor|patch|major]
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const bumpType = (process.argv[2] || "minor").toLowerCase();
if (!["major", "minor", "patch"].includes(bumpType)) {
  console.error(`Unknown bump '${bumpType}'. Use major, minor, or patch.`);
  process.exit(1);
}

const root = process.cwd();
const packageDirs = ["packages/core", "packages/html", "packages/mcp"];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function bumpSemver(version, type) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) throw new Error(`Unsupported version '${version}'`);
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (type === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (type === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

function sh(command) {
  return execSync(command, { cwd: root, encoding: "utf8" }).trim();
}

const corePath = join(root, "packages/core/package.json");
const next = bumpSemver(readJson(corePath).version, bumpType);

for (const dir of packageDirs) {
  const path = join(root, dir, "package.json");
  const pkg = readJson(path);
  pkg.version = next;
  if (pkg.dependencies?.["@compact-design/core"]) pkg.dependencies["@compact-design/core"] = next;
  if (pkg.dependencies?.["@compact-design/html"]) pkg.dependencies["@compact-design/html"] = next;
  writeJson(path, pkg);
  console.log(`bumped ${pkg.name} → ${next}`);
}

let lastTag = "";
try {
  lastTag = sh("git describe --tags --abbrev=0 --match 'v*' 2>/dev/null");
} catch {
  lastTag = "";
}

const logFormat = "- %s (%h)";
let commits = "";
try {
  commits = lastTag
    ? sh(`git log ${lastTag}..HEAD --pretty=format:'${logFormat}' --no-merges`)
    : sh(`git log --max-count=40 --pretty=format:'${logFormat}' --no-merges`);
} catch {
  commits = "";
}
if (!commits) commits = "- (no commits listed)";

const date = new Date().toISOString().slice(0, 10);
const section = `## ${next} — ${date}

Published packages: \`@compact-design/core\`, \`@compact-design/html\`, \`@compact-design/mcp\` (Figma plugin is not on npm).

${commits}
`;

const changelogPath = join(root, "CHANGELOG.md");
const existing = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "# Changelog\n";
const withoutTitle = existing.replace(/^# Changelog\s*/m, "").replace(/^\n+/, "");
const withoutSameVersion = withoutTitle.replace(new RegExp(`## ${next.replace(/\./g, "\\.")}[\\s\\S]*?(?=\\n## |$)`), "").replace(/^\n+/, "");
writeFileSync(changelogPath, `# Changelog\n\n${section}\n${withoutSameVersion}`.trimEnd() + "\n");

sh("npm install --package-lock-only --ignore-scripts");
console.log(`prepared batch release ${next}`);
