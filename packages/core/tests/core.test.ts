import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "../src/parser";
import { isPatchDocument, normalizeDocument, normalizePatchDocument } from "../src/normalize";
import { validateDocument } from "../src/validate";
import { lintDocument, validationIssues } from "../src/lint";
import { applyPatch, lint, normalize, normalizePatch, schema, validate } from "../src/index";
import { indexDocument } from "../src/references";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join("..", "..", "examples", name), "utf8"));

test("parses strict JSON and reports malformed input", () => {
  assert.deepEqual(parseDocument('{"canvas":{"width":10,"height":10},"nodes":[]}'), { canvas: { width: 10, height: 10 }, nodes: [] });
  assert.throws(() => parseDocument("{broken"), /JSON/);
});

test("public core API runs without a Figma global", () => {
  assert.equal("figma" in globalThis, false);
  const result = validate({ canvas: { width: 100, height: 100 }, nodes: [] });
  assert.equal(result.valid, true);
  assert.ok(result.document);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
});

test("public validation returns structured schema and semantic issues", () => {
  const schemaResult = validate({ canvas: { width: "wide", height: 100 }, nodes: [] });
  assert.equal(schemaResult.valid, false);
  assert.ok(schemaResult.issues.every((issue) => issue.path.startsWith("$")));
  const semanticResult = validate({ canvas: { width: 100, height: 100 }, nodes: [{ id: "same", type: "FRAME", w: 10, h: 10 }, { id: "same", type: "FRAME", w: 10, h: 10 }] });
  assert.equal(semanticResult.valid, false);
  assert.ok(semanticResult.issues.some((issue) => issue.message.includes("duplicate ID")));
});

test("reference indexing and component resolution are core concerns", () => {
  const valid = normalize({ canvas: { width: 100, height: 100 }, nodes: [{ id: "button", type: "COMPONENT", w: 20, h: 20 }, { id: "button-copy", type: "INSTANCE", componentId: "button", w: 20, h: 20 }] });
  assert.equal(indexDocument(valid).components.get("button")?.type, "COMPONENT");
  const invalid = validate({ canvas: { width: 100, height: 100 }, nodes: [{ id: "button-copy", type: "INSTANCE", componentId: "missing", w: 20, h: 20 }] });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.issues.some((issue) => issue.message.includes("not defined")));
});

test("normalizes canonical text, paints, gradients, and coordinates", () => {
  const document = normalizeDocument({ canvas: { id: "c", width: 400, height: 300, fill: "#112233" }, nodes: [{ id: "f", type: "FRAME", x: 20, y: 30, w: 200, h: 100, fill: { gradient: "LINEAR", angle: 45, stops: [{ at: 0, color: "#000000" }, { at: 1, color: "#FFFFFF" }] }, children: [{ id: "t", type: "TEXT", x: 5, y: 7, w: 100, h: 20, text: "Hello", font: { family: "Georgia", style: "Bold", size: 18 }, align: "CENTER" }] }] });
  const frame = document.nodes[0].children[0]; const text = frame.children[0];
  assert.equal(frame.properties.position.x, 20); assert.equal(text.properties.position.x, 25);
  assert.equal(frame.properties.styles.fills[0].type, "GRADIENT_LINEAR");
  assert.equal(text.properties.font?.size, 18); assert.equal(text.properties.alignment, "CENTER");
});

test("normalizes compact scrolling names to canonical overflow directions", () => {
  const cases = [
    ["NONE", "NONE"],
    ["HORIZONTAL_SCROLLING", "HORIZONTAL"],
    ["VERTICAL_SCROLLING", "VERTICAL"],
    ["HORIZONTAL_AND_VERTICAL_SCROLLING", "BOTH"]
  ] as const;
  for (const [authored, canonical] of cases) {
    const document = normalize({ canvas: { width: 100, height: 100 }, nodes: [{ type: "FRAME", w: 50, h: 50, overflowDirection: authored }] });
    assert.equal(document.nodes[0].children[0].properties.overflowDirection, canonical);
  }
});

test("rejects removed text aliases", () => {
  assert.throws(() => normalizeDocument({ canvas: { width: 100, height: 100 }, nodes: [{ type: "TEXT", w: 20, h: 20, text: "x", alignment: "CENTER" }] }), /use align/);
  assert.throws(() => normalizeDocument({ canvas: { width: 100, height: 100 }, nodes: [{ type: "TEXT", w: 20, h: 20, text: "x", fontSize: 20 }] }), /font\.size/);
});

test("parses resources at the untrusted document boundary", () => {
  const document = normalizeDocument({
    canvas: { width: 100, height: 100 },
    styles: [{ id: "ink", name: "Ink", type: "PAINT", paints: ["#112233"] }],
    variables: [{ name: "Theme", modes: ["Light", "Dark"], items: [{ id: "surface", name: "Surface", type: "COLOR", values: { Light: { r: 255, g: 255, b: 255, a: 1 }, Dark: { r: 0, g: 0, b: 0, a: 1 } } }] }]
  });
  assert.equal(document.styles[0].paints?.[0].type, "SOLID");
  assert.deepEqual(document.variables[0].modes, ["Light", "Dark"]);
  assert.throws(() => normalizeDocument({ canvas: { width: 100, height: 100 }, styles: [{ name: "Broken", type: "PAINT", paints: "red" }] }), /styles\[0\]\.paints/);
  assert.throws(() => normalizeDocument({ canvas: { width: 100, height: 100 }, variables: [{ name: "Broken", items: "nope" }] }), /variables\[0\]\.items/);
});

test("validates geometry, auto layout, variables, and prototype destinations", () => {
  assert.throws(() => normalizeDocument({ canvas: { width: 300, height: 300 }, variables: [{ name: "Theme", items: [{ name: "flag", type: "BOOLEAN", value: "wrong" }] }] }), /must match variable type BOOLEAN/);
  const document = normalizeDocument({ canvas: { width: 300, height: 300 }, nodes: [{ id: "bad", type: "FRAME", w: -1, h: 20, layout: { direction: "SIDEWAYS" }, prototype: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NAVIGATE", destination: "missing" }] }] }] });
  const errors = validateDocument(document);
  assert.ok(errors.some((value) => value.includes("positive finite")));
  assert.ok(errors.some((value) => value.includes("HORIZONTAL")));
  assert.ok(lintDocument(document).some((issue) => issue.code === "BROKEN_PROTOTYPE_DESTINATION"));
});

test("accepts Figma open vector paths with a NONE winding rule", () => {
  const result = validate({
    canvas: { width: 100, height: 100 },
    nodes: [{ type: "VECTOR", w: 80, h: 20, vectorPaths: [{ windingRule: "NONE", data: "M 0 0 L 80 20" }] }]
  });
  assert.equal(result.valid, true);
});

test("normalizes patch set, remove, and append operations", () => {
  const patch = normalizePatchDocument(fixture("update-patch-sample.json"));
  assert.deepEqual(patch.patch.operations.map((operation) => operation.op), ["SET", "SET", "APPEND"]);
  assert.equal(patch.patch.operations[0].normalized?.text, "The same design.\nA different mood.");
  assert.equal(patch.patch.operations[2].node?.id, "theme-note");
});

test("abstract patching updates canonical documents without mutation", () => {
  const document = normalize({ canvas: { width: 300, height: 200 }, nodes: [{ id: "parent", type: "FRAME", w: 200, h: 100, children: [{ id: "title", type: "TEXT", w: 100, h: 20, text: "Before" }] }] });
  const patch = normalizePatch({ patch: { operations: [{ op: "set", id: "title", set: { text: "After", fill: "#FF0000" } }, { op: "append", parent: "parent", node: { id: "badge", type: "RECTANGLE", w: 20, h: 20, fill: "#00FF00" } }] } });
  const result = applyPatch(document, patch);
  assert.equal(document.nodes[0].children[0].children[0].properties.text, "Before");
  assert.equal(result.document.nodes[0].children[0].children[0].properties.text, "After");
  assert.equal(result.document.nodes[0].children[0].children[1].id, "badge");
  assert.deepEqual(result.affectedIds, ["title", "badge"]);
});

test("public lint runs on canonical documents independently", () => {
  const document = normalize({ canvas: { width: 100, height: 100 }, nodes: [{ id: "tiny-button", name: "Button", type: "FRAME", w: 20, h: 20 }] });
  assert.ok(lint(document).some((issue) => issue.code === "SMALL_TOUCH_TARGET"));
});

test("lint detects requested design-quality problems", () => {
  const children = Array.from({ length: 3 }, (_, index) => ({ id: `b${index}`, name: "Button", type: "FRAME", x: index * 40, y: 0, w: 30, h: 30, fill: "#777777", prototype: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "BACK" }] }], children: [{ id: `t${index}`, type: "TEXT", x: 0, y: 0, w: 20, h: 8, text: "Overflowing text", font: { size: 12 }, fill: "#787878", textAutoResize: "NONE" }] }));
  const issues = lintDocument(normalizeDocument({ canvas: { width: 300, height: 200, fill: "#777777" }, nodes: [{ id: "row", type: "FRAME", w: 200, h: 50, children }] }));
  for (const code of ["LOW_CONTRAST", "SMALL_TOUCH_TARGET", "MISSING_AUTO_LAYOUT", "REPEATED_DETACHED_ELEMENTS", "MISSING_COMPONENT_USAGE", "TEXT_OVERFLOW", "DUPLICATE_UNBOUND_COLOUR"]) assert.ok(issues.some((issue) => issue.code === code), `missing ${code}`);
});

test("structured repair issues retain paths and suggestions", () => {
  const issues = validationIssues(["nodes[0].size: w and h must be positive"]);
  assert.equal(issues[0].path, "nodes[0].size"); assert.equal(issues[0].severity, "ERROR"); assert.ok(issues[0].suggestion);
});

test("all maintained examples parse and full documents validate", () => {
  for (const name of readdirSync("../../examples").filter((value) => value.endsWith(".json"))) {
    const source = fixture(name);
    if (isPatchDocument(source)) {
      normalizePatchDocument(source);
      const publicResult = validate(source);
      assert.equal(publicResult.valid, true, `${name}: ${publicResult.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    } else {
      assert.deepEqual(validateDocument(normalizeDocument(source)), [], name);
      const publicResult = validate(source);
      assert.equal(publicResult.valid, true, `${name}: ${publicResult.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    }
  }
});

test("formal schema exposes the current contract", () => {
  const specSchema = JSON.parse(readFileSync("../../spec/compact-design.schema.json", "utf8"));
  assert.deepEqual(schema, specSchema);
  assert.equal(specSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  for (const key of ["node", "paint", "prototype", "variable", "patchRoot"]) assert.ok(specSchema.$defs[key], key);
  assert.equal(specSchema.$defs.node.properties.alignment, undefined);
  assert.equal(specSchema.$defs.node.properties.fontSize, undefined);
});

test("source code contains no explicit any annotations", () => {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) files.push(path);
    }
  };
  walk("src");
  const explicitAny = /:\s*any\b|\bas\s+any\b|<\s*any\s*>|\bany\s*\[\s*\]|Record<[^>]*,\s*any\s*>/g;
  const violations = files.flatMap((path) => [...readFileSync(path, "utf8").matchAll(explicitAny)].map((match) => `${path}:${match.index}`));
  assert.deepEqual(violations, []);
});

test("canvas variableModes and bindings pass through to the root frame", () => {
  const document = normalizeDocument({
    canvas: {
      id: "screen",
      width: 390,
      height: 844,
      fill: "#F8F5EE",
      variableModes: { Theme: "Dark" },
      bindings: { fill: "surface" }
    },
    nodes: [],
    variables: [{
      name: "Theme",
      modes: ["Light", "Dark"],
      items: [{ id: "surface", name: "colour/surface", type: "COLOR", values: { Light: { r: 248, g: 245, b: 238, a: 1 }, Dark: { r: 26, g: 27, b: 24, a: 1 } } }]
    }]
  });
  assert.deepEqual(document.nodes[0].properties.variableModes, { Theme: "Dark" });
  assert.deepEqual(document.nodes[0].properties.bindings, { fill: "surface" });
});

test("rejects unknown bindings and variableModes against document.variables", () => {
  const missingBinding = validate({
    canvas: { width: 100, height: 100 },
    nodes: [{ id: "card", type: "FRAME", w: 50, h: 50, bindings: { fill: "missing-token" } }],
    variables: [{ name: "Theme", items: [{ id: "surface", name: "colour/surface", type: "COLOR", value: { r: 1, g: 1, b: 1, a: 1 } }] }]
  });
  assert.equal(missingBinding.valid, false);
  assert.ok(missingBinding.issues.some((issue) => issue.path.includes("bindings.fill") && /missing-token/.test(issue.message)));

  const missingMode = validate({
    canvas: { width: 100, height: 100 },
    nodes: [{ id: "screen", type: "FRAME", w: 100, h: 100, variableModes: { Theme: "Midnight" } }],
    variables: [{
      name: "Theme",
      modes: ["Light", "Dark"],
      items: [{ id: "surface", name: "colour/surface", type: "COLOR", values: { Light: { r: 248, g: 245, b: 238, a: 1 }, Dark: { r: 26, g: 27, b: 24, a: 1 } } }]
    }]
  });
  assert.equal(missingMode.valid, false);
  assert.ok(missingMode.issues.some((issue) => issue.path.includes("variableModes.Theme") && /Midnight/.test(issue.message)));

  const missingCollection = validate({
    canvas: { width: 100, height: 100 },
    nodes: [{ id: "card", type: "FRAME", w: 50, h: 50, variableModes: { Brand: "Default" } }],
    variables: [{ name: "Theme", items: [{ id: "surface", name: "colour/surface", type: "COLOR", value: { r: 1, g: 1, b: 1, a: 1 } }] }]
  });
  assert.equal(missingCollection.valid, false);
  assert.ok(missingCollection.issues.some((issue) => /Brand/.test(issue.message)));
});

test("accepts Theme Dark and bindings.fill surface when variables are declared", () => {
  const result = validate({
    canvas: { id: "screen", width: 390, height: 844, fill: "#F8F5EE" },
    nodes: [
      { id: "shell", type: "FRAME", w: 390, h: 844, variableModes: { Theme: "Dark" }, bindings: { fill: "surface" }, children: [
        { id: "card", type: "FRAME", w: 100, h: 40, bindings: { fill: "colour/surface" } }
      ] }
    ],
    variables: [{
      name: "Theme",
      modes: ["Light", "Dark"],
      items: [{ id: "surface", name: "colour/surface", type: "COLOR", values: { Light: { r: 248, g: 245, b: 238, a: 1 }, Dark: { r: 26, g: 27, b: 24, a: 1 } } }]
    }]
  });
  assert.equal(result.valid, true, result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
});
