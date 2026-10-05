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
  assert.match(result.css, /--cd-surface-Light:\s*rgba\(248, 245, 238, 1\)/);
  assert.match(result.css, /--cd-surface-Dark:\s*rgba\(27, 30, 26, 1\)/);
  assert.match(result.css, /--cd-ink-Light:/);
  assert.match(result.css, /--cd-ink-Dark:/);
  assert.match(result.css, /\.cd-board\[data-cd-mode-Theme="Dark"\]/);
  assert.match(result.css, /#n-theme-card \{[^}]*background: var\(--cd-surface\)/);
  assert.match(result.css, /#n-theme-title \{[^}]*color: var\(--cd-ink\)/);
  assert.match(result.html, /class="cd-board" data-cd-mode-Theme="Dark"/);
});

test("SET_VARIABLE_MODE switches live theme modes", () => {
  const result = render({
    canvas: { id: "theme-live", width: 400, height: 200, fill: "#FFFFFF" },
    variables: [{
      name: "Theme",
      modes: ["Light", "Dark"],
      items: [
        { id: "surface", name: "colour/surface", type: "COLOR", values: {
          Light: { r: 248, g: 245, b: 238, a: 1 },
          Dark: { r: 27, g: 30, b: 26, a: 1 }
        } },
        { id: "ink", name: "colour/ink", type: "COLOR", values: {
          Light: { r: 35, g: 34, b: 30, a: 1 },
          Dark: { r: 243, g: 236, b: 222, a: 1 }
        } }
      ]
    }],
    nodes: [{
      id: "panel",
      type: "FRAME",
      x: 0,
      y: 0,
      w: 400,
      h: 200,
      fill: "#F8F5EE",
      bindings: { fill: "surface" },
      variableModes: { Theme: "Light" },
      children: [
        {
          id: "label",
          type: "TEXT",
          x: 16,
          y: 16,
          w: 200,
          h: 24,
          text: "Theme",
          fill: "#23221E",
          bindings: { fill: "ink" },
          font: { family: "Arial", style: "Regular", size: 16 }
        },
        {
          id: "to-dark",
          type: "FRAME",
          x: 16,
          y: 60,
          w: 100,
          h: 32,
          fill: "#23221E",
          prototype: [{
            trigger: { type: "ON_CLICK" },
            actions: [{ type: "SET_VARIABLE_MODE", collection: "Theme", mode: "Dark" }]
          }]
        },
        {
          id: "to-light",
          type: "FRAME",
          x: 130,
          y: 60,
          w: 100,
          h: 32,
          fill: "#F8F5EE",
          prototype: [{
            trigger: { type: "ON_CLICK" },
            actions: [{ type: "SET_VARIABLE_MODE", collection: "Theme", mode: "Light" }]
          }]
        }
      ]
    }]
  });
  assert.match(result.css, /--cd-surface-Light:/);
  assert.match(result.css, /--cd-surface-Dark:/);
  assert.match(result.css, /\.cd-board\[data-cd-mode-Theme="Light"\] \{[^}]*--cd-surface: var\(--cd-surface-Light\)/);
  assert.match(result.css, /\.cd-board\[data-cd-mode-Theme="Dark"\] \{[^}]*--cd-surface: var\(--cd-surface-Dark\)/);
  assert.match(result.html, /data-cd-set-collection="Theme" data-cd-set-mode="Dark"/);
  assert.match(result.html, /data-cd-set-collection="Theme" data-cd-set-mode="Light"/);
  assert.match(result.html, /data-cd-mode-Theme="Light"/);
  assert.match(result.html, /board\.setAttribute\("data-cd-mode-" \+ collection, mode\)/);
  assert.match(result.html, /\.replace\(\/\[\^a-zA-Z0-9_-\]\+\/g, "-"\)/);
});

test("bound COLOR fills reach SVG shapes", () => {
  const result = render({
    canvas: { id: "shapes", width: 240, height: 120, fill: "#FFFFFF" },
    variables: [{
      name: "Brand Theme",
      modes: ["Light", "Dark"],
      items: [
        { id: "accent", name: "colour/accent", type: "COLOR", values: {
          Light: { r: 220, g: 36, b: 31, a: 1 },
          Dark: { r: 255, g: 120, b: 80, a: 1 }
        } }
      ]
    }],
    nodes: [
      {
        id: "star",
        type: "STAR",
        x: 10,
        y: 10,
        w: 80,
        h: 80,
        pointCount: 5,
        innerRadius: 0.5,
        fill: "#DC241F",
        bindings: { fill: "accent" },
        variableModes: { "Brand Theme": "Light" }
      },
      {
        id: "to-dark",
        type: "FRAME",
        x: 120,
        y: 20,
        w: 80,
        h: 32,
        fill: "#23221E",
        prototype: [{
          trigger: { type: "ON_CLICK" },
          actions: [{ type: "SET_VARIABLE_MODE", collection: "Brand Theme", mode: "Dark" }]
        }]
      }
    ]
  });
  assert.match(result.html, /id="n-star"[^>]*>[\s\S]*?<polygon[^>]*fill="var\(--cd-accent\)"/);
  assert.match(result.css, /\.cd-board\[data-cd-mode-Brand-Theme="Light"\]/);
  assert.match(result.html, /data-cd-set-collection="Brand-Theme" data-cd-set-mode="Dark"/);
  assert.match(result.html, /data-cd-mode-Brand-Theme="Light"/);
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

test("text runs emit link, textDecoration, and letterSpacing", () => {
  const result = render({
    canvas: { id: "runs", width: 400, height: 80, fill: "#FFFFFF" },
    nodes: [{
      id: "rich",
      type: "TEXT",
      x: 0,
      y: 0,
      w: 400,
      h: 40,
      text: "linked underlined spaced",
      fill: "#23221E",
      font: { family: "Arial", style: "Regular", size: 16 },
      runs: [
        { text: "linked", link: "https://example.com/docs" },
        { text: " " },
        { text: "underlined", textDecoration: "UNDERLINE" },
        { text: " " },
        { text: "spaced", letterSpacing: { unit: "PIXELS", value: 2 } }
      ]
    }]
  });
  assert.match(result.html, /href="https:\/\/example\.com\/docs"/);
  assert.match(result.html, /text-decoration: underline/);
  assert.match(result.html, /letter-spacing: 2px/);
});

test("text shadows emit text-shadow, not box-shadow", () => {
  const result = render({
    canvas: { id: "shadow", width: 300, height: 80, fill: "#FFFFFF" },
    nodes: [{
      id: "glow",
      type: "TEXT",
      x: 0,
      y: 0,
      w: 300,
      h: 40,
      text: "Shadowed",
      fill: "#23221E",
      font: { family: "Arial", style: "Regular", size: 16 },
      shadow: { x: 1, y: 2, blur: 3, spread: 4, color: "#000000" }
    }]
  });
  assert.match(result.css, /#n-glow \{[^}]*text-shadow: 1px 2px 3px rgba\(0, 0, 0, 1\)/);
  assert.doesNotMatch(result.css, /#n-glow \{[^}]*box-shadow/);
});

test("arcs render as SVG paths, not round boxes", () => {
  const result = render({
    canvas: { id: "arcs", width: 360, height: 140, fill: "#FFFFFF" },
    nodes: [
      { id: "ring", type: "ARC", x: 0, y: 0, w: 100, h: 100, startingAngle: 0, endingAngle: Math.PI / 2, innerRadiusRatio: 0.5, fill: "#DC241F" },
      { id: "donut", type: "ARC", x: 120, y: 0, w: 100, h: 100, startingAngle: 0, endingAngle: Math.PI * 2, innerRadiusRatio: 0.5, fill: "#DC241F" },
      { id: "wedge", type: "ARC", x: 240, y: 0, w: 100, h: 100, startingAngle: 0, endingAngle: Math.PI * 1.5, innerRadiusRatio: 0, fill: "#DC241F" }
    ]
  });
  assert.match(result.html, /id="n-ring"[^>]*><svg class="cd-shape"[^>]*><path d="M 100 50 A 50 50 0 0 1 50 100 L 50 75 A 25 25 0 0 0 75 50 Z"/);
  assert.match(result.html, /id="n-donut"[^>]*><svg[^>]*><path d="M 100 50 A 50 50 0 1 1 0 50 A 50 50 0 1 1 100 50 Z M 75 50 A 25 25 0 1 1 25 50 A 25 25 0 1 1 75 50 Z" fill-rule="evenodd"/);
  assert.match(result.html, /id="n-wedge"[^>]*><svg[^>]*><path d="M 100 50 A 50 50 0 1 1 50 0 L 50 50 Z"/);
  assert.doesNotMatch(result.css, /#n-ring \{[^}]*(border-radius|background)/);
});

test("lines render as SVG strokes, not bordered boxes", () => {
  const result = render({
    canvas: { id: "lines", width: 400, height: 80, fill: "#FFFFFF" },
    nodes: [
      { id: "rule", type: "LINE", x: 0, y: 20, w: 360, h: 1, stroke: "#263047", strokeWeight: 1, dashPattern: [4, 6] },
      { id: "solid", type: "LINE", x: 0, y: 50, w: 200, h: 1, stroke: "#7D5CFF", strokeWeight: 2, strokeCap: "ROUND" }
    ]
  });
  assert.match(result.html, /id="n-rule"[^>]*><svg class="cd-shape"[^>]*overflow="visible"[^>]*><line[^>]*stroke-dasharray="4 6"/);
  assert.match(result.html, /id="n-rule"[^>]*>[\s\S]*?<line[^>]*x1="0"[^>]*y1="0\.5"[^>]*x2="360"[^>]*y2="0\.5"/);
  assert.match(result.html, /id="n-solid"[^>]*>[\s\S]*?<line[^>]*stroke-linecap="round"/);
  assert.doesNotMatch(result.css, /#n-rule \{[^}]*(border:|background:)/);
  assert.doesNotMatch(result.css, /#n-solid \{[^}]*(border:|background:)/);
});

test("isMask hides mask paint and clips following siblings", () => {
  const result = render({
    canvas: { id: "masks", width: 400, height: 200, fill: "#FFFFFF" },
    nodes: [{
      id: "frame",
      type: "FRAME",
      x: 0,
      y: 0,
      w: 400,
      h: 200,
      children: [
        {
          id: "rect-mask",
          type: "RECTANGLE",
          x: 40,
          y: 20,
          w: 120,
          h: 80,
          cornerRadius: 16,
          fill: "#000000",
          isMask: true
        },
        {
          id: "rect-content",
          type: "RECTANGLE",
          x: 0,
          y: 0,
          w: 200,
          h: 120,
          fill: "#6C5CFF"
        },
        {
          id: "ellipse-mask",
          type: "ELLIPSE",
          x: 260,
          y: 40,
          w: 80,
          h: 80,
          fill: "#000000",
          isMask: true
        },
        {
          id: "ellipse-content",
          type: "RECTANGLE",
          x: 220,
          y: 20,
          w: 160,
          h: 120,
          fill: "#DC241F"
        }
      ]
    }]
  });

  assert.match(result.css, /#n-rect-mask \{[^}]*opacity: 0/);
  assert.doesNotMatch(result.css, /#n-rect-mask \{[^}]*background:/);
  assert.match(result.css, /#n-rect-content \{[^}]*clip-path: xywh\(40px 20px 120px 80px round 16px\)/);

  assert.match(result.css, /#n-ellipse-mask \{[^}]*opacity: 0/);
  assert.doesNotMatch(result.css, /#n-ellipse-mask \{[^}]*background:/);
  assert.match(
    result.css,
    /#n-ellipse-content \{[^}]*clip-path: ellipse\(40px 40px at 80px 60px\)/
  );
  assert.match(result.css, /#n-ellipse-content \{[^}]*background:/);
});

test("isMask without corner radius uses CSS mask geometry", () => {
  const result = render({
    canvas: { id: "mask-box", width: 240, height: 160, fill: "#FFFFFF" },
    nodes: [{
      id: "group",
      type: "FRAME",
      x: 0,
      y: 0,
      w: 240,
      h: 160,
      children: [
        { id: "hole", type: "RECTANGLE", x: 20, y: 30, w: 100, h: 60, fill: "#000000", isMask: true },
        { id: "photo", type: "RECTANGLE", x: 0, y: 0, w: 240, h: 160, fill: "#263047" }
      ]
    }]
  });
  assert.match(result.css, /#n-hole \{[^}]*opacity: 0/);
  assert.doesNotMatch(result.css, /#n-hole \{[^}]*background:/);
  assert.match(result.css, /#n-photo \{[^}]*mask-image: linear-gradient\(#000 0 0\)/);
  assert.match(result.css, /#n-photo \{[^}]*mask-size: 100px 60px/);
  assert.match(result.css, /#n-photo \{[^}]*mask-position: 20px 30px/);
  assert.match(result.css, /#n-photo \{[^}]*-webkit-mask-image: linear-gradient\(#000 0 0\)/);
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
