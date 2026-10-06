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

test("paragraphSpacing splits TEXT lines into spaced blocks", () => {
  const result = render({
    canvas: { id: "paras", width: 400, height: 120, fill: "#FFFFFF" },
    nodes: [{
      id: "copy",
      type: "TEXT",
      x: 0,
      y: 0,
      w: 400,
      h: 80,
      text: "First paragraph\nSecond paragraph",
      fill: "#23221E",
      font: { family: "Arial", style: "Regular", size: 16 },
      paragraphSpacing: 12,
      paragraphIndent: 8,
      textCase: "UPPER"
    }]
  });
  assert.match(result.css, /#n-copy \{[^}]*display: flex/);
  assert.match(result.css, /#n-copy \{[^}]*flex-direction: column/);
  assert.match(result.css, /#n-copy \{[^}]*gap: 12px/);
  assert.match(result.css, /#n-copy \{[^}]*text-indent: 8px/);
  assert.match(result.css, /#n-copy \{[^}]*text-transform: uppercase/);
  assert.match(result.html, /<p style="margin: 0">First paragraph<\/p><p style="margin: 0">Second paragraph<\/p>/);
});

test("paragraphSpacing absent or zero keeps single pre-wrap TEXT node", () => {
  for (const extra of [{}, { paragraphSpacing: 0 }]) {
    const result = render({
      canvas: { id: "plain", width: 400, height: 80, fill: "#FFFFFF" },
      nodes: [{
        id: "line",
        type: "TEXT",
        x: 0,
        y: 0,
        w: 400,
        h: 40,
        text: "One\nTwo",
        fill: "#23221E",
        font: { family: "Arial", style: "Regular", size: 16 },
        ...extra
      }]
    });
    assert.doesNotMatch(result.css, /#n-line \{[^}]*gap:/);
    assert.doesNotMatch(result.html, /<p /);
    assert.match(result.html, /One\nTwo/);
  }
});

test("paragraphSpacing splits runs at newlines and keeps in-line run styles", () => {
  const result = render({
    canvas: { id: "run-paras", width: 400, height: 100, fill: "#FFFFFF" },
    nodes: [{
      id: "rich",
      type: "TEXT",
      x: 0,
      y: 0,
      w: 400,
      h: 60,
      text: "Hello\nWorld",
      fill: "#23221E",
      font: { family: "Arial", style: "Regular", size: 16 },
      paragraphSpacing: 10,
      runs: [
        { text: "Hel", textDecoration: "UNDERLINE" },
        { text: "lo\nWo", letterSpacing: { unit: "PIXELS", value: 1 } },
        { text: "rld", link: "https://example.com/w" }
      ]
    }]
  });
  assert.match(result.css, /#n-rich \{[^}]*gap: 10px/);
  assert.match(result.html, /<p style="margin: 0">.*Hel.*lo.*<\/p><p style="margin: 0">.*Wo.*rld.*<\/p>/);
  assert.match(result.html, /text-decoration: underline/);
  assert.match(result.html, /letter-spacing: 1px/);
  assert.match(result.html, /href="https:\/\/example\.com\/w"/);
});

test("SMALL_CAPS and SMALL_CAPS_FORCED map to font-variant-caps", () => {
  for (const [textCase, expected] of [
    ["SMALL_CAPS", "small-caps"],
    ["SMALL_CAPS_FORCED", "all-small-caps"]
  ] as const) {
    const result = render({
      canvas: { id: "caps", width: 400, height: 80, fill: "#FFFFFF" },
      nodes: [{
        id: "label",
        type: "TEXT",
        x: 0,
        y: 0,
        w: 400,
        h: 40,
        text: "Small Caps",
        fill: "#23221E",
        font: { family: "Arial", style: "Regular", size: 16 },
        textCase
      }]
    });
    assert.match(result.css, new RegExp(`#n-label \\{[^}]*font-variant-caps: ${expected}`));
    assert.doesNotMatch(result.css, /#n-label \{[^}]*text-transform:/);
  }
});

test("hangingPunctuation true emits hanging-punctuation: first", () => {
  // hanging-punctuation has limited browser support (notably Safari).
  const result = render({
    canvas: { id: "hang", width: 400, height: 80, fill: "#FFFFFF" },
    nodes: [{
      id: "quote",
      type: "TEXT",
      x: 0,
      y: 0,
      w: 400,
      h: 40,
      text: '"Hanging"',
      fill: "#23221E",
      font: { family: "Arial", style: "Regular", size: 16 },
      hangingPunctuation: true
    }]
  });
  assert.match(result.css, /#n-quote \{[^}]*hanging-punctuation: first/);
});

test("hangingPunctuation false or absent omits hanging-punctuation", () => {
  for (const extra of [{}, { hangingPunctuation: false }]) {
    const result = render({
      canvas: { id: "nohang", width: 400, height: 80, fill: "#FFFFFF" },
      nodes: [{
        id: "plain",
        type: "TEXT",
        x: 0,
        y: 0,
        w: 400,
        h: 40,
        text: "Plain",
        fill: "#23221E",
        font: { family: "Arial", style: "Regular", size: 16 },
        ...extra
      }]
    });
    assert.doesNotMatch(result.css, /#n-plain \{[^}]*hanging-punctuation:/);
  }
});

test("UPPER textCase still maps to text-transform without font-variant-caps", () => {
  const result = render({
    canvas: { id: "upper", width: 400, height: 80, fill: "#FFFFFF" },
    nodes: [{
      id: "shout",
      type: "TEXT",
      x: 0,
      y: 0,
      w: 400,
      h: 40,
      text: "Upper",
      fill: "#23221E",
      font: { family: "Arial", style: "Regular", size: 16 },
      textCase: "UPPER"
    }]
  });
  assert.match(result.css, /#n-shout \{[^}]*text-transform: uppercase/);
  assert.doesNotMatch(result.css, /#n-shout \{[^}]*font-variant-caps:/);
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

test("ARC emits SVG stroke dash, linecap, and linejoin", () => {
  const result = render({
    canvas: { id: "arc-stroke", width: 200, height: 140, fill: "#FFFFFF" },
    nodes: [
      {
        id: "ring",
        type: "ARC",
        x: 20,
        y: 20,
        w: 100,
        h: 100,
        startingAngle: 0,
        endingAngle: Math.PI * 1.5,
        innerRadiusRatio: 0.5,
        fill: "#F8F5EE",
        stroke: "#7D5CFF",
        strokeWeight: 3,
        strokeCap: "ROUND",
        strokeJoin: "ROUND",
        dashPattern: [6, 4]
      }
    ]
  });
  assert.match(result.html, /id="n-ring"[^>]*>[\s\S]*?<path[^>]*stroke="rgba\(125, 92, 255, 1\)"[^>]*stroke-width="3"/);
  assert.match(result.html, /id="n-ring"[^>]*>[\s\S]*?<path[^>]*stroke-dasharray="6 4"[^>]*stroke-linecap="round"[^>]*stroke-linejoin="round"/);
  assert.match(result.html, /id="n-ring"[^>]*>[\s\S]*?<path[^>]*fill-rule="evenodd"/);
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

test("STAR and POLYGON emit SVG stroke color, width, dash, and join", () => {
  const result = render({
    canvas: { id: "shape-strokes", width: 320, height: 160, fill: "#FFFFFF" },
    nodes: [
      {
        id: "star",
        type: "STAR",
        x: 10,
        y: 10,
        w: 80,
        h: 80,
        pointCount: 5,
        innerRadius: 0.45,
        fill: "#F8F5EE",
        stroke: "#7D5CFF",
        strokeWeight: 3,
        strokeJoin: "ROUND",
        dashPattern: [6, 4]
      },
      {
        id: "hex",
        type: "POLYGON",
        x: 120,
        y: 20,
        w: 90,
        h: 90,
        pointCount: 6,
        fill: "#FFFFFF",
        stroke: "#DC241F",
        strokeWeight: 2,
        strokeJoin: "BEVEL"
      },
      {
        id: "glyph",
        type: "VECTOR",
        x: 230,
        y: 40,
        w: 60,
        h: 40,
        vectorPaths: [{ windingRule: "NONZERO", data: "M 0 40 L 30 0 L 60 40 Z" }],
        fill: "#FFFFFF",
        stroke: "#263047",
        strokeWeight: 4,
        strokeCap: "SQUARE",
        strokeJoin: "MITER"
      }
    ]
  });
  assert.match(result.html, /id="n-star"[^>]*>[\s\S]*?<polygon[^>]*stroke="rgba\(125, 92, 255, 1\)"[^>]*stroke-width="3"/);
  assert.match(result.html, /id="n-star"[^>]*>[\s\S]*?<polygon[^>]*stroke-dasharray="6 4"[^>]*stroke-linejoin="round"/);
  assert.match(result.html, /id="n-hex"[^>]*>[\s\S]*?<polygon[^>]*stroke="rgba\(220, 36, 31, 1\)"[^>]*stroke-width="2"[^>]*stroke-linejoin="bevel"/);
  assert.match(result.html, /id="n-glyph"[^>]*>[\s\S]*?<path[^>]*stroke="rgba\(38, 48, 71, 1\)"[^>]*stroke-width="4"[^>]*stroke-linecap="square"[^>]*stroke-linejoin="miter"/);
  assert.doesNotMatch(result.css, /#n-star \{[^}]*(border:|border-width)/);
  assert.doesNotMatch(result.css, /#n-hex \{[^}]*(border:|border-width)/);
});

test("VECTOR open paths with windingRule NONE emit fill none and keep stroke", () => {
  const result = render({
    canvas: { id: "vectors", width: 240, height: 120, fill: "#FFFFFF" },
    nodes: [
      {
        id: "open",
        type: "VECTOR",
        x: 10,
        y: 20,
        w: 80,
        h: 40,
        vectorPaths: [{ windingRule: "NONE", data: "M 0 0 L 80 40" }],
        fill: "#FFFFFF",
        stroke: "#263047",
        strokeWeight: 3,
        strokeCap: "ROUND",
        strokeJoin: "ROUND"
      },
      {
        id: "filled",
        type: "VECTOR",
        x: 120,
        y: 20,
        w: 60,
        h: 40,
        vectorPaths: [{ windingRule: "NONZERO", data: "M 0 40 L 30 0 L 60 40 Z" }],
        fill: "#6C5CFF",
        stroke: "#DC241F",
        strokeWeight: 2
      },
      {
        id: "mixed",
        type: "VECTOR",
        x: 10,
        y: 70,
        w: 100,
        h: 40,
        vectorPaths: [
          { windingRule: "NONE", data: "M 0 20 L 100 20" },
          { windingRule: "EVENODD", data: "M 10 0 L 40 0 L 40 30 L 10 30 Z" }
        ],
        fill: "#F8F5EE",
        stroke: "#7D5CFF",
        strokeWeight: 2
      }
    ]
  });
  assert.match(result.html, /id="n-open"[^>]*>[\s\S]*?<path[^>]*fill="none"/);
  assert.match(result.html, /id="n-open"[^>]*>[\s\S]*?<path[^>]*stroke="rgba\(38, 48, 71, 1\)"[^>]*stroke-width="3"[^>]*stroke-linecap="round"[^>]*stroke-linejoin="round"/);
  assert.match(result.html, /id="n-filled"[^>]*>[\s\S]*?<path[^>]*fill-rule="nonzero"[^>]*fill="rgba\(108, 92, 255, 1\)"/);
  assert.match(result.html, /id="n-mixed"[^>]*>[\s\S]*?<path d="M 0 20 L 100 20"[^>]*fill="none"/);
  assert.match(result.html, /id="n-mixed"[^>]*>[\s\S]*?<path d="M 10 0 L 40 0 L 40 30 L 10 30 Z"[^>]*fill-rule="evenodd"[^>]*fill="rgba\(248, 245, 238, 1\)"/);
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


test("strokeAlign INSIDE and unset emit CSS border", () => {
  const result = render({
    canvas: { id: "stroke-inside", width: 240, height: 120, fill: "#FFFFFF" },
    nodes: [
      { id: "inside", type: "RECTANGLE", x: 10, y: 10, w: 80, h: 80, fill: "#FFFFFF", stroke: "#6C5CFF", strokeWeight: 4, strokeAlign: "INSIDE" },
      { id: "unset", type: "RECTANGLE", x: 120, y: 10, w: 80, h: 80, fill: "#FFFFFF", stroke: "#23221E", strokeWeight: 2 }
    ]
  });
  assert.match(result.css, /#n-inside \{[^}]*border: 4px solid rgba\(108, 92, 255, 1\)/);
  assert.doesNotMatch(result.css, /#n-inside \{[^}]*box-shadow:/);
  assert.match(result.css, /#n-unset \{[^}]*border: 2px solid rgba\(35, 34, 30, 1\)/);
});

test("strokeAlign OUTSIDE uses outer box-shadow without content shrink", () => {
  const result = render({
    canvas: { id: "stroke-outside", width: 240, height: 120, fill: "#FFFFFF" },
    nodes: [
      { id: "outside", type: "FRAME", x: 10, y: 10, w: 100, h: 80, fill: "#FFFFFF", stroke: "#DC241F", strokeWeight: 6, strokeAlign: "OUTSIDE", cornerRadius: 12 },
      // Dashed OUTSIDE stays solid shadow — CSS cannot cheaply map dashPattern onto box-shadow.
      { id: "dashed-out", type: "RECTANGLE", x: 130, y: 10, w: 80, h: 80, stroke: "#263047", strokeWeight: 3, strokeAlign: "OUTSIDE", dashPattern: [4, 4] }
    ]
  });
  assert.match(result.css, /#n-outside \{[^}]*width: 100px/);
  assert.match(result.css, /#n-outside \{[^}]*height: 80px/);
  assert.match(result.css, /#n-outside \{[^}]*box-shadow: 0 0 0 6px rgba\(220, 36, 31, 1\)/);
  assert.doesNotMatch(result.css, /#n-outside \{[^}]*border:/);
  assert.match(result.css, /#n-dashed-out \{[^}]*box-shadow: 0 0 0 3px rgba\(38, 48, 71, 1\)/);
  assert.doesNotMatch(result.css, /#n-dashed-out \{[^}]*border:/);
});

test("strokeAlign CENTER approximates with half border and half outer shadow", () => {
  const result = render({
    canvas: { id: "stroke-center", width: 200, height: 120, fill: "#FFFFFF" },
    nodes: [
      { id: "center", type: "RECTANGLE", x: 20, y: 20, w: 120, h: 60, fill: "#F8F5EE", stroke: "#7D5CFF", strokeWeight: 4, strokeAlign: "CENTER" }
    ]
  });
  assert.match(result.css, /#n-center \{[^}]*border: 2px solid rgba\(125, 92, 255, 1\)/);
  assert.match(result.css, /#n-center \{[^}]*box-shadow: 0 0 0 2px rgba\(125, 92, 255, 1\)/);
});

test("OUTSIDE stroke box-shadow coalesces with effect shadows", () => {
  const result = render({
    canvas: { id: "stroke-fx", width: 200, height: 120, fill: "#FFFFFF" },
    nodes: [{
      id: "ring",
      type: "RECTANGLE",
      x: 20,
      y: 20,
      w: 100,
      h: 60,
      fill: "#FFFFFF",
      stroke: "#6C5CFF",
      strokeWeight: 2,
      strokeAlign: "OUTSIDE",
      shadow: { x: 0, y: 4, blur: 8, spread: 0, color: "#00000066" }
    }]
  });
  assert.match(
    result.css,
    /#n-ring \{[^}]*box-shadow: 0 0 0 2px rgba\(108, 92, 255, 1\), 0px 4px 8px 0px rgba\(0, 0, 0, 0\.4\)/
  );
  assert.doesNotMatch(result.css, /#n-ring \{[^}]*border:/);
});

test("numberOfFixedChildren sticks last N kids in a VERTICAL scroll frame", () => {
  for (const overflowDirection of ["VERTICAL", "VERTICAL_SCROLLING"] as const) {
    const result = render({
      canvas: { id: "scroll-v", width: 200, height: 160, fill: "#FFFFFF" },
      nodes: [{
        id: "scroller",
        type: "FRAME",
        x: 0,
        y: 0,
        w: 200,
        h: 160,
        overflowDirection,
        numberOfFixedChildren: 1,
        children: [
          { id: "a", type: "RECTANGLE", x: 0, y: 0, w: 200, h: 80, fill: "#F8F5EE" },
          { id: "b", type: "RECTANGLE", x: 0, y: 80, w: 200, h: 80, fill: "#E8E4DA" },
          { id: "chrome", type: "RECTANGLE", x: 0, y: 140, w: 200, h: 40, fill: "#6C5CFF" }
        ]
      }]
    });
    assert.match(result.css, /#n-scroller \{[^}]*overflow-y: auto/);
    assert.match(result.css, /#n-chrome \{[^}]*position: sticky/);
    assert.match(result.css, /#n-chrome \{[^}]*bottom: 0/);
    assert.doesNotMatch(result.css, /#n-a \{[^}]*position: sticky/);
    assert.doesNotMatch(result.css, /#n-b \{[^}]*position: sticky/);
  }
});

test("numberOfFixedChildren sticks last kids for HORIZONTAL and BOTH", () => {
  const horizontal = render({
    canvas: { id: "scroll-h", width: 200, height: 100, fill: "#FFFFFF" },
    nodes: [{
      id: "row",
      type: "FRAME",
      w: 200,
      h: 100,
      overflowDirection: "HORIZONTAL",
      numberOfFixedChildren: 1,
      children: [
        { id: "left", type: "RECTANGLE", x: 0, y: 0, w: 120, h: 100, fill: "#F8F5EE" },
        { id: "pin-right", type: "RECTANGLE", x: 160, y: 0, w: 40, h: 100, fill: "#6C5CFF" }
      ]
    }]
  });
  assert.match(horizontal.css, /#n-pin-right \{[^}]*position: sticky/);
  assert.match(horizontal.css, /#n-pin-right \{[^}]*right: 0/);
  assert.doesNotMatch(horizontal.css, /#n-left \{[^}]*position: sticky/);

  const both = render({
    canvas: { id: "scroll-both", width: 200, height: 100, fill: "#FFFFFF" },
    nodes: [{
      id: "both",
      type: "FRAME",
      w: 200,
      h: 100,
      overflowDirection: "BOTH",
      numberOfFixedChildren: 1,
      children: [
        { id: "body", type: "RECTANGLE", x: 0, y: 0, w: 300, h: 200, fill: "#F8F5EE" },
        { id: "corner", type: "RECTANGLE", x: 160, y: 60, w: 40, h: 40, fill: "#6C5CFF" }
      ]
    }]
  });
  assert.match(both.css, /#n-corner \{[^}]*position: sticky/);
  assert.match(both.css, /#n-corner \{[^}]*bottom: 0/);
  assert.match(both.css, /#n-corner \{[^}]*right: 0/);
});

test("numberOfFixedChildren is ignored without scrolling overflow and clamped to child count", () => {
  const ignored = render({
    canvas: { id: "static", width: 200, height: 120, fill: "#FFFFFF" },
    nodes: [{
      id: "frame",
      type: "FRAME",
      w: 200,
      h: 120,
      numberOfFixedChildren: 2,
      children: [
        { id: "one", type: "RECTANGLE", x: 0, y: 0, w: 200, h: 40, fill: "#F8F5EE" },
        { id: "two", type: "RECTANGLE", x: 0, y: 40, w: 200, h: 40, fill: "#E8E4DA" }
      ]
    }]
  });
  assert.doesNotMatch(ignored.css, /#n-one \{[^}]*position: sticky/);
  assert.doesNotMatch(ignored.css, /#n-two \{[^}]*position: sticky/);

  const clamped = render({
    canvas: { id: "clamp", width: 200, height: 120, fill: "#FFFFFF" },
    nodes: [{
      id: "scroll",
      type: "FRAME",
      w: 200,
      h: 120,
      overflowDirection: "VERTICAL",
      numberOfFixedChildren: 9,
      children: [
        { id: "first", type: "RECTANGLE", x: 0, y: 0, w: 200, h: 40, fill: "#F8F5EE" },
        { id: "second", type: "RECTANGLE", x: 0, y: 40, w: 200, h: 40, fill: "#6C5CFF" }
      ]
    }]
  });
  assert.match(clamped.css, /#n-first \{[^}]*position: sticky/);
  assert.match(clamped.css, /#n-first \{[^}]*bottom: 0/);
  assert.match(clamped.css, /#n-second \{[^}]*position: sticky/);
  assert.match(clamped.css, /#n-second \{[^}]*bottom: 0/);
});

test("layoutGrids GRID paints a non-interactive lattice overlay", () => {
  const result = render({
    canvas: { id: "grid-canvas", width: 200, height: 200, fill: "#FFFFFF" },
    nodes: [{
      id: "board",
      type: "FRAME",
      x: 0,
      y: 0,
      w: 200,
      h: 200,
      fill: "#FFFFFF",
      layoutGrids: [{
        pattern: "GRID",
        sectionSize: 8,
        color: { r: 0, g: 25, b: 168, a: 0.1 }
      }]
    }]
  });
  assert.match(result.css, /#n-board::after \{[^}]*pointer-events: none/);
  assert.match(result.css, /#n-board::after \{[^}]*content: ""/);
  assert.match(result.css, /#n-board::after \{[^}]*repeating-linear-gradient\(0deg/);
  assert.match(result.css, /#n-board::after \{[^}]*repeating-linear-gradient\(90deg/);
  assert.match(result.css, /#n-board::after \{[^}]*transparent 8px/);
  assert.match(result.css, /#n-board::after \{[^}]*rgba\(0, 25, 168, 0\.1\)/);
});

test("layoutGrids COLUMNS and ROWS honour stretch and fixed alignments", () => {
  const columns = render({
    canvas: { id: "cols-canvas", width: 400, height: 200, fill: "#FFFFFF" },
    nodes: [{
      id: "cols",
      type: "FRAME",
      w: 400,
      h: 200,
      fill: "#FFFFFF",
      layoutGrids: [{
        pattern: "COLUMNS",
        alignment: "STRETCH",
        count: 12,
        gutterSize: 20,
        offset: 32,
        color: { r: 0, g: 25, b: 168, a: 0.1 }
      }]
    }]
  });
  assert.match(columns.css, /#n-cols::after \{[^}]*pointer-events: none/);
  assert.match(columns.css, /#n-cols::after \{[^}]*repeating-linear-gradient\(to right/);
  assert.match(columns.css, /#n-cols::after \{[^}]*background-size: calc\(100% - 64px\) 100%/);
  assert.match(columns.css, /#n-cols::after \{[^}]*background-position: 32px 0/);
  assert.match(columns.css, /#n-cols::after \{[^}]*\(100% - 220px\) \/ 12/);

  const rows = render({
    canvas: { id: "rows-canvas", width: 200, height: 400, fill: "#FFFFFF" },
    nodes: [{
      id: "rows",
      type: "FRAME",
      w: 200,
      h: 400,
      fill: "#FFFFFF",
      layoutGrids: [{
        pattern: "ROWS",
        alignment: "MIN",
        count: 4,
        gutterSize: 8,
        offset: 16,
        sectionSize: 64,
        color: { r: 255, g: 0, b: 0, a: 0.2 }
      }]
    }]
  });
  assert.match(rows.css, /#n-rows::after \{[^}]*repeating-linear-gradient\(to bottom/);
  assert.match(rows.css, /#n-rows::after \{[^}]*64px/);
  assert.match(rows.css, /#n-rows::after \{[^}]*background-size: 100% 280px/);
  assert.match(rows.css, /#n-rows::after \{[^}]*background-position: 0 16px/);
  assert.match(rows.css, /#n-rows::after \{[^}]*rgba\(255, 0, 0, 0\.2\)/);

  const centered = render({
    canvas: { id: "center-canvas", width: 300, height: 200, fill: "#FFFFFF" },
    nodes: [{
      id: "centered",
      type: "FRAME",
      w: 300,
      h: 200,
      fill: "#FFFFFF",
      layoutGrids: [{
        pattern: "COLUMNS",
        alignment: "CENTER",
        count: 3,
        gutterSize: 10,
        sectionSize: 40,
        color: { r: 0, g: 128, b: 0, a: 0.15 }
      }]
    }]
  });
  assert.match(centered.css, /#n-centered::after \{[^}]*background-size: 140px 100%/);
  assert.match(centered.css, /#n-centered::after \{[^}]*background-position: center/);
});

test("layoutGrids skips invisible grids and omits empty overlays", () => {
  const hidden = render({
    canvas: { id: "hidden-canvas", width: 200, height: 200, fill: "#FFFFFF" },
    nodes: [{
      id: "hidden",
      type: "FRAME",
      w: 200,
      h: 200,
      fill: "#FFFFFF",
      layoutGrids: [{
        pattern: "GRID",
        sectionSize: 8,
        visible: false,
        color: { r: 0, g: 25, b: 168, a: 0.1 }
      }]
    }]
  });
  assert.doesNotMatch(hidden.css, /#n-hidden::after/);

  const mixed = render({
    canvas: { id: "mixed-canvas", width: 200, height: 200, fill: "#FFFFFF" },
    nodes: [{
      id: "mixed",
      type: "FRAME",
      w: 200,
      h: 200,
      fill: "#FFFFFF",
      layoutGrids: [
        { pattern: "GRID", sectionSize: 10, visible: false, color: { r: 0, g: 0, b: 0, a: 0.1 } },
        { pattern: "COLUMNS", alignment: "MAX", count: 2, gutterSize: 8, offset: 4, sectionSize: 40, color: { r: 0, g: 0, b: 255, a: 0.1 } }
      ]
    }]
  });
  assert.match(mixed.css, /#n-mixed::after \{[^}]*repeating-linear-gradient\(to right/);
  assert.doesNotMatch(mixed.css, /#n-mixed::after \{[^}]*repeating-linear-gradient\(0deg/);
  assert.match(mixed.css, /#n-mixed::after \{[^}]*background-size: 88px 100%/);
  assert.match(mixed.css, /#n-mixed::after \{[^}]*calc\(100% - 4px - 88px\)/);
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
