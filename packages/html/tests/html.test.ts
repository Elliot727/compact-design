import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { render, RenderError } from "../src/index";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join("..", "..", "examples", name), "utf8"));

test("HTML adapter consumes core and does not duplicate language modules", () => {
  const files: string[] = [];
  const walk = (directory: string): void => readdirSync(directory).forEach((name) => {
    const path = join(directory, name);
    statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") && files.push(path);
  });
  walk("src");
  const source = files.map((path) => readFileSync(path, "utf8")).join("\n");
  assert.match(source, /from "@compact-design\/core"/);
  assert.doesNotMatch(source, /function (normalizeDocument|validateDocument|lintDocument)\b/);
  assert.doesNotMatch(source, /\bfigma\s*\./);
});

test("core workspace has no HTML renderer dependency", () => {
  const manifest = JSON.parse(readFileSync("../../packages/core/package.json", "utf8"));
  assert.equal(manifest.dependencies?.["@compact-design/html"], undefined);
});

test("renders a compact card to HTML and CSS", () => {
  const result = render({
    canvas: { id: "desktop", width: 400, height: 240, fill: "#F8F5EE" },
    nodes: [{
      id: "card",
      type: "FRAME",
      x: 24,
      y: 24,
      w: 320,
      h: 160,
      fill: "#FFFFFF",
      cornerRadius: 16,
      children: [{ id: "title", type: "TEXT", x: 20, y: 20, w: 280, h: 40, text: "A quieter kind of stay.", fill: "#23221E", font: { family: "Arial", style: "Bold", size: 24 } }]
    }]
  });
  assert.match(result.html, /A quieter kind of stay\./);
  assert.match(result.css, /#n-card/);
  assert.match(result.css, /background: linear-gradient\(rgba\(255, 255, 255, 1\)/);
  assert.match(result.css, /border-radius: 16px/);
  assert.match(result.css, /#n-title \{[^}]*position: absolute/);
});

test("auto layout becomes flex and ignores child x/y", () => {
  const result = render({
    canvas: { id: "stack", width: 200, height: 120, fill: "#FFFFFF" },
    nodes: [{
      id: "row",
      type: "FRAME",
      w: 200,
      h: 120,
      layout: { direction: "HORIZONTAL", itemSpacing: 8, padding: { left: 4, top: 4, right: 4, bottom: 4 } },
      children: [{ id: "cell", type: "RECTANGLE", w: 40, h: 40, fill: "#6C5CFF", layoutSizingHorizontal: "HUG" }]
    }]
  });
  assert.match(result.css, /#n-row \{[^}]*display: flex/);
  assert.match(result.css, /#n-row \{[^}]*flex-direction: row/);
  assert.match(result.css, /#n-cell \{[^}]*position: relative/);
});

test("prototype navigation becomes in-page links", () => {
  const result = render(fixture("prototype-basic-sample.json"));
  assert.match(result.html, /href="#n-detail-screen"/);
  assert.match(result.html, /id="n-home-screen"/);
  assert.match(result.html, /data-cd-timeout="4"/);
});

test("variable bindings emit resolved colours", () => {
  const result = render(fixture("update-patch-theme-sample.json"));
  assert.match(result.css, /#n-theme-card/);
  assert.match(result.html, /One design\./);
});

test("maintained documents render; patches are rejected", () => {
  const files = readdirSync("../../examples").filter((name) => name.endsWith(".json"));
  for (const name of files) {
    const value = fixture(name);
    if (name === "update-patch-sample.json") {
      assert.throws(() => render(value), RenderError);
      continue;
    }
    const result = render(value, { title: name });
    assert.match(result.html, /<!doctype html>/);
    assert.match(result.html, /class="cd-board"/);
  }
});

test("invalid documents surface structured issues", () => {
  try {
    render({ canvas: { width: "wide", height: 100 }, nodes: [] });
    assert.fail("expected RenderError");
  } catch (error) {
    assert.ok(error instanceof RenderError);
    assert.ok(error.issues.length > 0);
  }
});
