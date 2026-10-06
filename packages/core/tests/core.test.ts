import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "../src/parser";
import { isPatchDocument, normalizeDocument, normalizePatchDocument } from "../src/normalize";
import { validateDocument } from "../src/validate";
import { lintDocument, validationIssues } from "../src/lint";
import { applyPatch, lint, normalize, normalizePatch, PATCH_SET_APPLIES_TO, PATCH_SET_DEFERRED_KEYS, PATCH_SET_EXCLUDED_NODE_KEYS, PATCH_SET_KEYS, PATCH_SET_SEMANTICS, PatchError, schema, validate, validatePatch } from "../src/index";
import type { InternalDocument, InternalNode } from "../src/types";
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
    ["HORIZONTAL", "HORIZONTAL"],
    ["VERTICAL", "VERTICAL"],
    ["BOTH", "BOTH"],
    ["HORIZONTAL_SCROLLING", "HORIZONTAL"],
    ["VERTICAL_SCROLLING", "VERTICAL"],
    ["HORIZONTAL_AND_VERTICAL_SCROLLING", "BOTH"]
  ] as const;
  for (const [authored, canonical] of cases) {
    const document = normalize({ canvas: { width: 100, height: 100 }, nodes: [{ type: "FRAME", w: 50, h: 50, overflowDirection: authored }] });
    assert.equal(document.nodes[0].children[0].properties.overflowDirection, canonical);
  }
});

test("validate accepts authored and short overflowDirection names", () => {
  for (const authored of ["VERTICAL_SCROLLING", "VERTICAL"] as const) {
    const result = validate({ canvas: { width: 100, height: 100 }, nodes: [{ type: "FRAME", w: 50, h: 50, overflowDirection: authored }] });
    assert.equal(result.valid, true, result.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "));
    assert.equal(result.document?.nodes[0].children[0].properties.overflowDirection, "VERTICAL");
  }
  const rejected = validate({ canvas: { width: 100, height: 100 }, nodes: [{ type: "FRAME", w: 50, h: 50, overflowDirection: "DIAGONAL" }] });
  assert.equal(rejected.valid, false);
  assert.ok(rejected.issues.some((issue) => issue.path.includes("overflowDirection")));
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

test("rejects unknown styleRefs against document.styles", () => {
  const missingStyle = validate({
    canvas: { width: 100, height: 100 },
    nodes: [{ id: "card", type: "FRAME", w: 50, h: 50, styleRefs: { fill: "missing-ink" } }],
    styles: [{ id: "ink", name: "Ink", type: "PAINT", paints: ["#112233"] }]
  });
  assert.equal(missingStyle.valid, false);
  assert.ok(missingStyle.issues.some((issue) => issue.path.includes("styleRefs.fill") && /missing-ink/.test(issue.message)));

  const emptyRef = validate({
    canvas: { width: 100, height: 100 },
    nodes: [{ id: "card", type: "FRAME", w: 50, h: 50, styleRefs: { stroke: "" } }],
    styles: [{ id: "ink", name: "Ink", type: "PAINT", paints: ["#112233"] }]
  });
  assert.equal(emptyRef.valid, false);
  assert.ok(emptyRef.issues.some((issue) => issue.path.includes("styleRefs.stroke") && /non-empty/.test(issue.message)));

  const wrongType = validate({
    canvas: { width: 100, height: 100 },
    nodes: [{ id: "label", type: "TEXT", w: 40, h: 16, text: "Hi", styleRefs: { fill: "Body", text: "ink" } }],
    styles: [
      { id: "ink", name: "Ink", type: "PAINT", paints: ["#112233"] },
      { id: "body", name: "Body", type: "TEXT", font: { family: "Inter", style: "Regular", size: 14 } }
    ]
  });
  assert.equal(wrongType.valid, false);
  assert.ok(wrongType.issues.some((issue) => issue.path.includes("styleRefs.fill") && /PAINT/.test(issue.message)));
  assert.ok(wrongType.issues.some((issue) => issue.path.includes("styleRefs.text") && /TEXT/.test(issue.message)));
});

test("accepts styleRefs by id and name when styles are declared", () => {
  const result = validate({
    canvas: { width: 100, height: 100 },
    nodes: [
      { id: "card", type: "FRAME", w: 50, h: 50, styleRefs: { fill: "ink", stroke: "Ink" }, children: [
        { id: "label", type: "TEXT", w: 40, h: 16, text: "Hi", styleRefs: { text: "Body" } }
      ] }
    ],
    styles: [
      { id: "ink", name: "Ink", type: "PAINT", paints: ["#112233"] },
      { id: "body", name: "Body", type: "TEXT", font: { family: "Inter", style: "Regular", size: 14 } }
    ]
  });
  assert.equal(result.valid, true, result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
});

test("BOOLEAN_OPERATION requires a valid operation enum", () => {
  const children = [
    { id: "a", type: "RECTANGLE", w: 20, h: 20 },
    { id: "b", type: "RECTANGLE", w: 20, h: 20 }
  ];
  const missing = validate({
    canvas: { width: 100, height: 100 },
    nodes: [{ id: "bool", type: "BOOLEAN_OPERATION", w: 40, h: 40, children }]
  });
  assert.equal(missing.valid, false);
  assert.ok(missing.issues.some((issue) => issue.path.includes("operation")));

  const badDocument = normalizeDocument({
    canvas: { width: 100, height: 100 },
    nodes: [{ id: "bool", type: "BOOLEAN_OPERATION", w: 40, h: 40, operation: "MERGE", children }]
  });
  const badErrors = validateDocument(badDocument);
  assert.ok(badErrors.some((value) => value.includes("operation") && /UNION|SUBTRACT|INTERSECT|EXCLUDE/.test(value)));

  const valid = validate({
    canvas: { width: 100, height: 100 },
    nodes: [{ id: "bool", type: "BOOLEAN_OPERATION", w: 40, h: 40, operation: "UNION", children }]
  });
  assert.equal(valid.valid, true, valid.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
});

test("schema accepts NOISE, TEXTURE, and GLASS effects with type-specific fields", () => {
  const result = validate({
    canvas: { width: 100, height: 100 },
    nodes: [{
      id: "fx",
      type: "FRAME",
      w: 80,
      h: 80,
      effects: [
        { type: "DROP_SHADOW", color: "#00000055", offset: { x: 0, y: 4 }, blur: 8, spread: 0, showShadowBehindNode: true },
        { type: "LAYER_BLUR", blur: 12, blurType: "PROGRESSIVE", startRadius: 0, startOffset: { x: 0.5, y: 0 }, endOffset: { x: 0.5, y: 1 } },
        { type: "NOISE", noiseType: "DUOTONE", color: "#112233", secondaryColor: "#AABBCC", noiseSize: 2, density: 0.4, blendMode: "OVERLAY" },
        { type: "TEXTURE", noiseSize: 3, radius: 1.5, clipToShape: true },
        { type: "GLASS", lightIntensity: 0.7, lightAngle: -30, refraction: 0.4, depth: 2, dispersion: 0.2, radius: 8 }
      ]
    }]
  });
  assert.equal(result.valid, true, result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  const effects = result.document!.nodes[0].children[0].properties.styles.effects;
  assert.equal(effects.find((effect) => effect.type === "NOISE")?.noiseType, "DUOTONE");
  assert.equal(effects.find((effect) => effect.type === "TEXTURE")?.clipToShape, true);
  assert.equal(effects.find((effect) => effect.type === "GLASS")?.depth, 2);
  assert.equal(effects.find((effect) => effect.type === "DROP_SHADOW")?.showShadowBehindNode, true);
  assert.equal(effects.find((effect) => effect.type === "LAYER_BLUR")?.blurType, "PROGRESSIVE");
});

test("schema accepts SHADER effects with id, visible, and loose properties", () => {
  const result = validate({
    canvas: { width: 100, height: 100 },
    nodes: [{
      id: "fx",
      type: "FRAME",
      w: 40,
      h: 40,
      effects: [{
        type: "SHADER",
        id: "shader-1",
        visible: true,
        properties: {
          "def:amount": 0.5,
          "def:enabled": true,
          "def:mode": "soft",
          "def:tint": { r: 1, g: 0.5, b: 0, a: 1 },
          "def:center": { x: 0.5, y: 0.5 },
          "def:ramp": { stops: [{ position: 0, color: { r: 0, g: 0, b: 0 } }, { position: 1, color: { r: 1, g: 1, b: 1 } }] },
          "def:bound": { type: "VARIABLE_ALIAS", id: "VariableID:1:2" }
        }
      }]
    }]
  });
  assert.equal(result.valid, true, result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  const [shader] = result.document!.nodes[0].children[0].properties.styles.effects;
  assert.equal(shader.type, "SHADER");
  assert.equal(shader.id, "shader-1");
  assert.equal(shader.visible, true);
  assert.deepEqual(shader.properties?.["def:center"], { x: 0.5, y: 0.5 });
  assert.equal(shader.properties?.["def:amount"], 0.5);
  assert.equal("color" in shader || "offset" in shader || "radius" in shader, false);
});

test("schema requires an id on SHADER effects", () => {
  const result = validate({
    canvas: { width: 100, height: 100 },
    nodes: [{ id: "fx", type: "FRAME", w: 40, h: 40, effects: [{ type: "SHADER", visible: true }] }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => /effects\/0\/id$/.test(issue.path) && issue.code === "SCHEMA_REQUIRED"), JSON.stringify(result.issues));
});

function childIds(document: ReturnType<typeof normalize>, parentId: string): string[] {
  const visit = (nodes: typeof document.nodes): string[] | null => {
    for (const node of nodes) {
      if (node.id === parentId) return node.children.map((child) => child.id);
      const nested = visit(node.children);
      if (nested) return nested;
    }
    return null;
  };
  return visit(document.nodes) || [];
}

function findNode(document: ReturnType<typeof normalize>, id: string) {
  const visit = (nodes: typeof document.nodes): (typeof document.nodes)[number] | null => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const nested = visit(node.children);
      if (nested) return nested;
    }
    return null;
  };
  return visit(document.nodes);
}

test("normalizes and validates insert and move operations", () => {
  const patch = normalizePatch({
    patch: {
      operations: [
        { op: "insert", parent: "list", index: 1, node: { id: "mid", type: "FRAME", w: 10, h: 10 } },
        { op: "move", id: "mid", parent: "list", index: 0 }
      ]
    }
  });
  assert.deepEqual(patch.patch.operations.map((operation) => operation.op), ["INSERT", "MOVE"]);
  assert.equal(patch.patch.operations[0].index, 1);
  assert.equal(patch.patch.operations[0].node?.id, "mid");
  assert.equal(patch.patch.operations[1].id, "mid");
  assert.equal(validate({
    patch: {
      operations: [
        { op: "insert", parent: "list", index: 0, node: { type: "FRAME", w: 10, h: 10 } },
        { op: "move", id: "a", parent: "list", index: 2 }
      ]
    }
  }).valid, true);
});

test("rejects negative or non-integer patch index in schema and normalize", () => {
  for (const index of [-1, 1.5, "0", null]) {
    const result = validate({
      patch: { operations: [{ op: "insert", parent: "list", index, node: { type: "FRAME", w: 10, h: 10 } }] }
    });
    assert.equal(result.valid, false, `index=${String(index)}`);
  }
  assert.throws(
    () => normalizePatch({ patch: { operations: [{ op: "move", id: "a", parent: "list", index: -1 }] } }),
    /non-negative integer/
  );
  assert.throws(
    () => normalizePatch({ patch: { operations: [{ op: "insert", parent: "list", index: 1.2, node: { type: "FRAME", w: 10, h: 10 } }] } }),
    /non-negative integer/
  );
});

test("insert places children at middle, zero, and clamped end", () => {
  const document = normalize({
    canvas: { width: 300, height: 200 },
    nodes: [{ id: "list", type: "FRAME", w: 200, h: 100, children: [
      { id: "a", type: "RECTANGLE", w: 10, h: 10 },
      { id: "b", type: "RECTANGLE", w: 10, h: 10 },
      { id: "c", type: "RECTANGLE", w: 10, h: 10 }
    ] }]
  });
  const middle = applyPatch(document, normalizePatch({
    patch: { operations: [{ op: "insert", parent: "list", index: 1, node: { id: "mid", type: "RECTANGLE", w: 10, h: 10 } }] }
  }));
  assert.deepEqual(childIds(middle.document, "list"), ["a", "mid", "b", "c"]);

  const atZero = applyPatch(document, normalizePatch({
    patch: { operations: [{ op: "insert", parent: "list", index: 0, node: { id: "first", type: "RECTANGLE", w: 10, h: 10 } }] }
  }));
  assert.deepEqual(childIds(atZero.document, "list"), ["first", "a", "b", "c"]);

  const clamped = applyPatch(document, normalizePatch({
    patch: { operations: [{ op: "insert", parent: "list", index: 99, node: { id: "tail", type: "RECTANGLE", w: 10, h: 10 } }] }
  }));
  assert.deepEqual(childIds(clamped.document, "list"), ["a", "b", "c", "tail"]);
});

test("append matches insert at children.length", () => {
  const source = {
    canvas: { width: 300, height: 200 },
    nodes: [{ id: "list", type: "FRAME", w: 200, h: 100, children: [
      { id: "a", type: "RECTANGLE", w: 10, h: 10 },
      { id: "b", type: "RECTANGLE", w: 10, h: 10 }
    ] }]
  };
  const document = normalize(source);
  const viaAppend = applyPatch(document, normalizePatch({
    patch: { operations: [{ op: "append", parent: "list", node: { id: "z", type: "RECTANGLE", w: 10, h: 10 } }] }
  }));
  const viaInsert = applyPatch(document, normalizePatch({
    patch: { operations: [{ op: "insert", parent: "list", index: 2, node: { id: "z", type: "RECTANGLE", w: 10, h: 10 } }] }
  }));
  assert.deepEqual(childIds(viaAppend.document, "list"), childIds(viaInsert.document, "list"));
  assert.deepEqual(childIds(viaAppend.document, "list"), ["a", "b", "z"]);

  // Same parent validation as insert: missing parent, non-container, INSTANCE.
  for (const op of ["append", "insert"] as const) {
    const missingParent = { op, parent: "nope", ...(op === "insert" ? { index: 0 } : {}), node: { id: "x", type: "RECTANGLE", w: 1, h: 1 } };
    assert.throws(() => applyPatch(document, normalizePatch({ patch: { operations: [missingParent] } })), /was not found/);
    const intoLeaf = { op, parent: "a", ...(op === "insert" ? { index: 0 } : {}), node: { id: "x", type: "RECTANGLE", w: 1, h: 1 } };
    assert.throws(() => applyPatch(document, normalizePatch({ patch: { operations: [intoLeaf] } })), /cannot contain children/);
  }
  const withInstance = normalize({
    canvas: { width: 100, height: 100 },
    nodes: [
      { id: "button", type: "COMPONENT", w: 20, h: 20 },
      { id: "copy", type: "INSTANCE", componentId: "button", w: 20, h: 20 }
    ]
  });
  for (const op of ["append", "insert"] as const) {
    const intoInstance = { op, parent: "copy", ...(op === "insert" ? { index: 0 } : {}), node: { id: "x", type: "RECTANGLE", w: 1, h: 1 } };
    assert.throws(() => applyPatch(withInstance, normalizePatch({ patch: { operations: [intoInstance] } })), /INSTANCE/);
  }
});

test("move reorders within parent using after-removal index", () => {
  const document = normalize({
    canvas: { width: 300, height: 200 },
    nodes: [{ id: "list", type: "FRAME", w: 200, h: 100, children: [
      { id: "a", type: "RECTANGLE", w: 10, h: 10 },
      { id: "b", type: "RECTANGLE", w: 10, h: 10 },
      { id: "c", type: "RECTANGLE", w: 10, h: 10 },
      { id: "d", type: "RECTANGLE", w: 10, h: 10 }
    ] }]
  });
  // Move b to final index 2 after removal → [a, c, b, d]
  const reordered = applyPatch(document, normalizePatch({
    patch: { operations: [{ op: "move", id: "b", parent: "list", index: 2 }] }
  }));
  assert.deepEqual(childIds(reordered.document, "list"), ["a", "c", "b", "d"]);

  const clamped = applyPatch(document, normalizePatch({
    patch: { operations: [{ op: "move", id: "a", parent: "list", index: 99 }] }
  }));
  assert.deepEqual(childIds(clamped.document, "list"), ["b", "c", "d", "a"]);
});

test("move reparents, clamps, and rejects cycles, missing targets, roots, and instances", () => {
  const document = normalize({
    canvas: { id: "canvas", width: 300, height: 200 },
    nodes: [{
      id: "outer", type: "FRAME", w: 200, h: 100, children: [
        { id: "inner", type: "FRAME", w: 80, h: 80, children: [
          { id: "leaf", type: "RECTANGLE", w: 10, h: 10 }
        ] },
        { id: "sibling", type: "FRAME", w: 40, h: 40, children: [] }
      ]
    }]
  });

  const reparented = applyPatch(document, normalizePatch({
    patch: { operations: [{ op: "move", id: "leaf", parent: "sibling", index: 0 }] }
  }));
  assert.deepEqual(childIds(reparented.document, "inner"), []);
  assert.deepEqual(childIds(reparented.document, "sibling"), ["leaf"]);

  assert.throws(
    () => applyPatch(document, normalizePatch({ patch: { operations: [{ op: "move", id: "outer", parent: "inner", index: 0 }] } })),
    /itself or its descendants/
  );
  assert.throws(
    () => applyPatch(document, normalizePatch({ patch: { operations: [{ op: "move", id: "missing", parent: "outer", index: 0 }] } })),
    /was not found/
  );
  assert.throws(
    () => applyPatch(document, normalizePatch({ patch: { operations: [{ op: "move", id: "leaf", parent: "missing", index: 0 }] } })),
    /was not found/
  );
  assert.throws(
    () => applyPatch(document, normalizePatch({ patch: { operations: [{ op: "move", id: "canvas", parent: "outer", index: 0 }] } })),
    /document root/
  );
  assert.throws(
    () => applyPatch(document, normalizePatch({ patch: { operations: [{ op: "insert", parent: "leaf", index: 0, node: { id: "x", type: "RECTANGLE", w: 1, h: 1 } }] } })),
    /cannot contain children/
  );

  const withInstance = normalize({
    canvas: { width: 100, height: 100 },
    nodes: [
      { id: "button", type: "COMPONENT", w: 20, h: 20 },
      { id: "copy", type: "INSTANCE", componentId: "button", w: 20, h: 20, children: [{ id: "slot", type: "FRAME", w: 10, h: 10 }] }
    ]
  });
  assert.throws(
    () => applyPatch(withInstance, normalizePatch({ patch: { operations: [{ op: "insert", parent: "copy", index: 0, node: { id: "x", type: "RECTANGLE", w: 1, h: 1 } }] } })),
    /INSTANCE/
  );
  assert.throws(
    () => applyPatch(withInstance, normalizePatch({ patch: { operations: [{ op: "move", id: "button", parent: "slot", index: 0 }] } })),
    /INSTANCE/
  );
  assert.throws(
    () => applyPatch(withInstance, normalizePatch({ patch: { operations: [{ op: "move", id: "slot", parent: "button", index: 0 }] } })),
    /inside an INSTANCE and cannot be moved/
  );
});

test("end-to-end insert+move+set patch validates the resulting multi-node document", () => {
  const source = {
    canvas: { id: "screen", width: 390, height: 844, fill: "#F6F0E4" },
    nodes: [{
      id: "card",
      type: "FRAME",
      w: 320,
      h: 200,
      fill: "#FFFFFF",
      children: [
        { id: "title", type: "TEXT", w: 280, h: 24, text: "Before", font: { family: "Inter", style: "Bold", size: 18 }, fill: "#111111" },
        { id: "body", type: "TEXT", w: 280, h: 40, text: "Details", font: { family: "Inter", style: "Regular", size: 14 }, fill: "#333333" },
        { id: "footer", type: "FRAME", w: 280, h: 40, children: [
          { id: "chip-a", type: "RECTANGLE", w: 40, h: 20, fill: "#6C5CFF" },
          { id: "chip-b", type: "RECTANGLE", w: 40, h: 20, fill: "#B69B62" }
        ] }
      ]
    }]
  };
  const document = normalize(source);
  assert.deepEqual(validateDocument(document), []);

  const patch = normalizePatch({
    patch: {
      operations: [
        { op: "insert", parent: "footer", index: 1, node: { id: "chip-mid", type: "RECTANGLE", w: 40, h: 20, fill: "#00AA88" } },
        { op: "move", id: "body", parent: "card", index: 0 },
        { op: "set", id: "title", set: { text: "After patch", fill: "#001122" } },
        { op: "append", parent: "card", node: { id: "note", type: "TEXT", w: 280, h: 16, text: "Note", font: { size: 12 }, fill: "#666666" } }
      ]
    }
  });
  const result = applyPatch(document, patch);
  assert.deepEqual(validateDocument(result.document), []);
  assert.deepEqual(childIds(result.document, "card"), ["body", "title", "footer", "note"]);
  assert.deepEqual(childIds(result.document, "footer"), ["chip-a", "chip-mid", "chip-b"]);
  assert.equal(findNode(result.document, "title")?.properties.text, "After patch");
  assert.deepEqual(result.affectedIds, ["chip-mid", "body", "title", "note"]);
  // Original document is untouched (round-trip safety).
  assert.deepEqual(childIds(document, "card"), ["title", "body", "footer"]);
  assert.equal(findNode(document, "title")?.properties.text, "Before");
});


// --- Typed, merging patch set (PR1) -----------------------------------------

const patchOf = (...operations: unknown[]) => ({ patch: { operations } });
const setOp = (id: string, set: Record<string, unknown>) => ({ op: "set", id, set });
const nodeById = (document: InternalDocument, id: string): InternalNode => {
  const found = findNode(document, id);
  assert.ok(found, `node ${id}`);
  return found;
};
const applyRaw = (document: InternalDocument, ...operations: unknown[]) => {
  const result = validatePatch(document, patchOf(...operations));
  assert.equal(result.valid, true, result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  return result.document!;
};
const rejects = (document: InternalDocument, pattern: RegExp, ...operations: unknown[]) => {
  const result = validatePatch(document, patchOf(...operations));
  assert.equal(result.valid, false, `expected rejection matching ${pattern}`);
  assert.match(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"), pattern);
  return result.issues;
};

const baseDocument = () => normalize({
  canvas: { id: "screen", width: 800, height: 600, fill: "#FFFFFF" },
  nodes: [
    { id: "outer", type: "FRAME", x: 100, y: 40, w: 500, h: 400, children: [
      { id: "inner", type: "FRAME", x: 50, y: 30, w: 300, h: 200, children: [
        { id: "leaf", type: "RECTANGLE", x: 10, y: 5, w: 20, h: 20, fill: "#FF0000" }
      ] },
      { id: "sibling", type: "FRAME", x: 200, y: 250, w: 100, h: 100, children: [] }
    ] },
    { id: "stack", type: "FRAME", x: 0, y: 460, w: 400, h: 100, layout: { direction: "HORIZONTAL", itemSpacing: 8, padding: { left: 16, top: 12, right: 16, bottom: 12 }, primaryAxisAlignItems: "CENTER" }, children: [
      { id: "chip", type: "RECTANGLE", w: 40, h: 20, fill: "#00FF00" }
    ] },
    { id: "title", type: "TEXT", x: 20, y: 10, w: 300, h: 40, text: "Hello", font: { family: "Inter", style: "Bold", size: 24 }, fills: [] },
    { id: "styled", type: "TEXT", x: 20, y: 60, w: 300, h: 40, text: "Hi there", font: { family: "Inter", style: "Regular", size: 16 }, fill: "#111111", runs: [{ start: 0, end: 2, font: { style: "Bold" } }] },
    { id: "card", type: "RECTANGLE", x: 400, y: 10, w: 100, h: 100, effects: [{ type: "DROP_SHADOW", color: "#00000033", offset: { x: 0, y: 4 }, blur: 8 }, { type: "LAYER_BLUR", blur: 4 }] },
    { id: "group", type: "GROUP", x: 600, y: 10, w: 50, h: 50, children: [{ id: "in-group", type: "RECTANGLE", w: 10, h: 10 }] }
  ]
});

test("PATCH_SET_KEYS is the single source of truth and matches schema node props", () => {
  const specSchema = JSON.parse(readFileSync("../../spec/compact-design.schema.json", "utf8"));
  const nodeKeys = Object.keys(specSchema.$defs.node.properties);
  const expected = nodeKeys.filter((key) => !(PATCH_SET_EXCLUDED_NODE_KEYS as readonly string[]).includes(key));
  assert.deepEqual([...PATCH_SET_KEYS], expected);
  assert.deepEqual(Object.keys(specSchema.$defs.patchSet.properties), expected);
  assert.equal(specSchema.$defs.patchSet.additionalProperties, false);
  assert.deepEqual(Object.keys(PATCH_SET_SEMANTICS).sort(), [...PATCH_SET_KEYS].sort());
  assert.deepEqual(Object.keys(PATCH_SET_APPLIES_TO).sort(), [...PATCH_SET_KEYS].sort());
  // Every patchSet property schema is the node property schema, except the partial
  // nested patches and descriptions documenting deferred/immutable keys.
  for (const key of expected) {
    const { description: _description, ...patchProperty } = specSchema.$defs.patchSet.properties[key];
    if (key === "layout") assert.deepEqual(patchProperty, { $ref: "#/$defs/layoutPatch" });
    else if (key === "constraints") assert.deepEqual(patchProperty, { $ref: "#/$defs/constraintsPatch" });
    else if (key === "font") assert.deepEqual(patchProperty, { $ref: "#/$defs/fontPatch" });
    else assert.deepEqual(patchProperty, specSchema.$defs.node.properties[key], key);
  }
  assert.equal(specSchema.$defs.layoutPatch.required, undefined);
  assert.deepEqual(specSchema.$defs.patchOperation.oneOf[0].properties.set, { $ref: "#/$defs/patchSet" });
  assert.deepEqual([...PATCH_SET_DEFERRED_KEYS], ["componentId", "componentProperties", "instanceProperties", "componentPropertyReferences", "variantAxes", "variant", "prototype", "styleRefs", "bindings", "variableModes"]);
});

test("a typo set key fails in the schema and in core", () => {
  const typo = patchOf(setOp("title", { txet: "Oops" }));
  const result = validate(typo);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "SCHEMA_ADDITIONALPROPERTIES" && issue.path.includes("/set")));
  // The first issue names the offending key precisely, ahead of the oneOf noise.
  assert.equal(result.issues[0].code, "PATCH_SET_UNSUPPORTED");
  assert.equal(result.issues[0].path, "patch.operations[0].set.txet");
  assert.match(result.issues[0].message, /unknown set key 'txet'/);
  assert.throws(() => normalizePatch(typo), /unknown set key 'txet'/);
  rejects(baseDocument(), /additional properties/, setOp("title", { txet: "Oops" }));
  // Nested typos fail too.
  assert.equal(validate(patchOf(setOp("stack", { layout: { itemSpaceing: 4 } }))).valid, false);
  assert.equal(validate(patchOf(setOp("title", { font: { weight: 700 } }))).valid, false);
  assert.equal(validate(patchOf(setOp("title", { font: {} }))).valid, false);
  assert.throws(() => normalizePatch(patchOf(setOp("title", { font: {} }))), /non-empty object/);
});

test("patch documents no longer short-circuit validation", () => {
  for (const set of [{ bindings: { fill: "brand" } }, { styleRefs: { fill: "Brand" } }, { variant: { State: "On" } }, { instanceProperties: { Label: "x" } }, { prototype: [] }, { svg: "<svg/>" }, { fill: "#000000", fills: ["#FFFFFF"] }]) {
    const result = validate(patchOf(setOp("title", set)));
    assert.equal(result.valid, false, JSON.stringify(set));
  }
  const deferred = validate(patchOf(setOp("title", { bindings: { fill: "brand" } })));
  assert.equal(deferred.issues[0].code, "PATCH_SET_UNSUPPORTED");
  assert.equal(deferred.issues[0].path, "patch.operations[0].set.bindings");
  assert.match(deferred.issues[0].message, /cannot be patched yet/);
});

test("set on TEXT adds no defaults: no fill injection and no Arial", () => {
  const document = baseDocument();
  const normalized = normalizePatch(patchOf(setOp("title", { text: "Changed" }))).patch.operations[0].normalized!;
  assert.deepEqual(normalized, { text: "Changed" });
  const after = applyRaw(document, setOp("title", { text: "Changed" }));
  assert.deepEqual(nodeById(after, "title").properties.styles.fills, []);
  assert.deepEqual(nodeById(after, "title").properties.font, { family: "Inter", style: "Bold", size: 24 });
  const shape = applyRaw(document, setOp("card", { cornerRadius: 4 }));
  assert.deepEqual(nodeById(shape, "card").properties.styles.fills, [], "no fill default on other types either");
});

test("{font:{size:32}} keeps family and style; partial fonts merge", () => {
  const document = baseDocument();
  const sized = applyRaw(document, setOp("title", { font: { size: 32 } }));
  assert.deepEqual(nodeById(sized, "title").properties.font, { family: "Inter", style: "Bold", size: 32 });
  const restyled = applyRaw(document, setOp("title", { font: { style: "Regular" } }));
  assert.deepEqual(nodeById(restyled, "title").properties.font, { family: "Inter", style: "Regular", size: 24 });
});

test("{layout:{itemSpacing:24}} keeps direction and padding; padding merges per side", () => {
  const document = baseDocument();
  const spaced = applyRaw(document, setOp("stack", { layout: { itemSpacing: 24 } }));
  assert.deepEqual(nodeById(spaced, "stack").properties.layout, { direction: "HORIZONTAL", itemSpacing: 24, padding: { left: 16, top: 12, right: 16, bottom: 12 }, primaryAxisAlignItems: "CENTER" });
  const padded = applyRaw(document, setOp("stack", { layout: { padding: { left: 40 } } }));
  assert.deepEqual(nodeById(padded, "stack").properties.layout?.padding, { left: 40, top: 12, right: 16, bottom: 12 });
  assert.equal(nodeById(padded, "stack").properties.layout?.itemSpacing, 8);
});

test("partial layout on a frame without Auto Layout errors unless direction is given", () => {
  const document = baseDocument();
  rejects(document, /set\.layout\.direction.*no Auto Layout yet/, setOp("outer", { layout: { itemSpacing: 12 } }));
  const enabled = applyRaw(document, setOp("outer", { layout: { direction: "VERTICAL", itemSpacing: 12 } }));
  assert.deepEqual(nodeById(enabled, "outer").properties.layout, { direction: "VERTICAL", itemSpacing: 12 });
  rejects(document, /does not apply to RECTANGLE/, setOp("leaf", { layout: { direction: "VERTICAL" } }));
  const stretch = patchOf(setOp("stack", { layout: { counterAxisAlignItems: "STRETCH" } }));
  assert.equal(validate(stretch).valid, false, "schema layoutPatch excludes STRETCH");
  assert.throws(() => normalizePatch(stretch), /STRETCH cannot be patched yet/);
});

test("constraints deep-merge over the Figma default", () => {
  const document = baseDocument();
  const once = applyRaw(document, setOp("leaf", { constraints: { horizontal: "CENTER" } }));
  assert.deepEqual(nodeById(once, "leaf").properties.constraints, { horizontal: "CENTER", vertical: "MIN" });
  const twice = applyRaw(once, setOp("leaf", { constraints: { vertical: "MAX" } }));
  assert.deepEqual(nodeById(twice, "leaf").properties.constraints, { horizontal: "CENTER", vertical: "MAX" });
});

test("effects, shadow and elevation replace the whole effect list", () => {
  const document = baseDocument();
  assert.equal(nodeById(document, "card").properties.styles.effects.length, 2);
  const shadowed = applyRaw(document, setOp("card", { shadow: { y: 2, blur: 6 } }));
  assert.deepEqual(nodeById(shadowed, "card").properties.styles.effects.map((effect) => [effect.type, effect.radius, effect.offset?.y]), [["DROP_SHADOW", 6, 2]]);
  const cleared = applyRaw(document, setOp("card", { effects: [] }));
  assert.deepEqual(nodeById(cleared, "card").properties.styles.effects, []);
  const elevated = applyRaw(document, setOp("card", { elevation: "FLOATING" }));
  assert.equal(nodeById(elevated, "card").properties.styles.effects.length, 2);
  const fills = applyRaw(document, setOp("leaf", { fills: ["#000000", "#FFFFFF"] }));
  assert.equal(nodeById(fills, "leaf").properties.styles.fills.length, 2, "fills replace, not append");
});

test("runs vs text: text is content, runs style ranges; styled targets reject content changes", () => {
  const document = baseDocument();
  const both = applyRaw(document, setOp("title", { text: "Big deal", runs: [{ start: 0, end: 3, font: { size: 40 } }] }));
  assert.equal(nodeById(both, "title").properties.text, "Big deal");
  assert.deepEqual(nodeById(both, "title").properties.runs, [{ start: 0, end: 3, font: { size: 40 } }]);
  const runsOnly = applyRaw(document, setOp("title", { runs: [{ text: "One " }, { text: "two", fill: "#FF0000" }] }));
  assert.equal(nodeById(runsOnly, "title").properties.text, "One two");
  rejects(document, /every run must carry its own text/, setOp("title", { runs: [{ start: 0, end: 2 }] }));
  rejects(document, /per-range text styling/, setOp("styled", { text: "New" }));
  // Node-level typography on a styled node applies to the whole text: run overrides of that attribute clear.
  const restyled = applyRaw(document, setOp("styled", { font: { family: "Roboto", style: "Medium" } }));
  assert.deepEqual(nodeById(restyled, "styled").properties.runs, [{ start: 0, end: 2 }]);
  rejects(document, /set font.family and font.style together/, setOp("styled", { font: { family: "Roboto" } }));
  const sized = applyRaw(document, setOp("styled", { font: { size: 20 } }));
  assert.deepEqual(nodeById(sized, "styled").properties.runs, [{ start: 0, end: 2, font: { style: "Bold" } }]);
});

test("x/y are parent-relative at any depth and move the subtree", () => {
  const document = baseDocument();
  // screen(0,0) > outer(100,40) > inner(+50,+30) > leaf(+10,+5)
  assert.deepEqual(nodeById(document, "leaf").properties.position, { x: 160, y: 75 });
  const moved = applyRaw(document, setOp("leaf", { x: 20 }));
  assert.deepEqual(nodeById(moved, "leaf").properties.position, { x: 170, y: 75 }, "x relative to inner; y untouched");
  const innerMoved = applyRaw(document, setOp("inner", { x: 0, y: 0 }));
  assert.deepEqual(nodeById(innerMoved, "inner").properties.position, { x: 100, y: 40 });
  assert.deepEqual(nodeById(innerMoved, "leaf").properties.position, { x: 110, y: 45 }, "descendants keep their relative offset");
  const inserted = applyRaw(document, { op: "insert", parent: "inner", index: 0, node: { id: "new", type: "RECTANGLE", x: 1, y: 2, w: 5, h: 5, children: [] } });
  assert.deepEqual(nodeById(inserted, "new").properties.position, { x: 151, y: 72 }, "inserted nodes are parent-relative too");
  rejects(document, /children of a GROUP cannot be positioned/, setOp("in-group", { x: 1 }));
  rejects(document, /parent uses Auto Layout/, setOp("chip", { x: 5 }));
  const absolute = applyRaw(document, setOp("chip", { layoutPositioning: "ABSOLUTE", x: 5, y: 6 }));
  assert.deepEqual(nodeById(absolute, "chip").properties.position, { x: 5, y: 466 });
});

test("move keeps parent-relative x/y, then set x is relative to the new parent", () => {
  const document = baseDocument();
  const result = applyRaw(document, { op: "move", id: "leaf", parent: "sibling", index: 0 }, setOp("leaf", { x: 7 }));
  // sibling at (100+200, 40+250) = (300, 290); leaf keeps y offset 5, x becomes 7.
  assert.deepEqual(nodeById(result, "leaf").properties.position, { x: 307, y: 295 });
});

test("set on a node inserted earlier in the same patch applies in core (Figma preflight rejects it)", () => {
  const document = baseDocument();
  const result = applyRaw(document, { op: "append", parent: "sibling", node: { id: "fresh", type: "RECTANGLE", w: 5, h: 5 } }, setOp("fresh", { w: 9 }));
  assert.equal(nodeById(result, "fresh").properties.size.width, 9);
});

test("set rejects keys that do not apply to the target type and bound or style-linked fields", () => {
  const document = baseDocument();
  rejects(document, /'text' does not apply to RECTANGLE/, setOp("leaf", { text: "x" }));
  rejects(document, /'w' does not apply to GROUP/, setOp("group", { w: 80 }));
  rejects(document, /FILL requires an Auto Layout parent/, setOp("leaf", { layoutSizingHorizontal: "FILL" }));
  rejects(document, /only applies to children of an Auto Layout parent/, setOp("leaf", { layoutGrow: 1 }));
  rejects(document, /node 'missing' was not found/, setOp("missing", { name: "x" }));
  const bound = normalize({
    canvas: { width: 100, height: 100 },
    variables: [{ name: "Tokens", items: [{ id: "brand", name: "brand", type: "COLOR", value: { r: 1, g: 2, b: 3 } }, { id: "size", name: "size", type: "FLOAT", value: 10 }] }],
    styles: [{ id: "body", name: "Body", type: "TEXT", font: { family: "Inter", style: "Regular", size: 14 } }],
    nodes: [
      { id: "box", type: "RECTANGLE", w: 10, h: 10, fill: "#010203", bindings: { fill: "brand", width: "size" } },
      { id: "copy", type: "TEXT", w: 10, h: 10, text: "x", styleRefs: { text: "body" } }
    ]
  });
  rejects(bound, /variable-bound field\(s\) width/, setOp("box", { w: 20 }));
  rejects(bound, /linked to a text style/, setOp("copy", { font: { size: 20 } }));
  const recoloured = applyRaw(bound, setOp("box", { fill: "#FFFFFF" }));
  assert.deepEqual(nodeById(recoloured, "box").properties.bindings, { width: "size" }, "setting fill detaches the fill binding, as in Figma");
});

test("validatePatch reports bad references in the patched document", () => {
  const document = baseDocument();
  const issues = rejects(document, /component 'ghost' is not defined/, { op: "append", parent: "sibling", node: { id: "inst", type: "INSTANCE", componentId: "ghost", w: 5, h: 5 } });
  assert.equal(issues[0].code, "PATCH_RESULT_INVALID");
  rejects(document, /variable 'nope' is not defined/, { op: "append", parent: "sibling", node: { id: "b", type: "RECTANGLE", w: 5, h: 5, bindings: { fill: "nope" } } });
  rejects(document, /style 'Nope' is not defined/, { op: "append", parent: "sibling", node: { id: "s", type: "RECTANGLE", w: 5, h: 5, styleRefs: { fill: "Nope" } } });
  assert.throws(() => applyPatch(document, normalizePatch(patchOf({ op: "append", parent: "sibling", node: { id: "inst", type: "INSTANCE", componentId: "ghost", w: 5, h: 5 } }))), PatchError);
});

// A document that is already invalid before any patch: two missing variables,
// plus valid components, an instance and two variant sets for indirect issues.
const preInvalidDocument = () => normalize({
  canvas: { id: "screen", width: 800, height: 600, fill: "#FFFFFF" },
  variables: [{ name: "Theme", modes: ["Light"], items: [{ id: "ink", name: "ink", type: "COLOR", values: { Light: { r: 17, g: 17, b: 17 } } }] }],
  nodes: [
    { id: "a", type: "RECTANGLE", x: 0, y: 0, w: 10, h: 10, fill: "#FF0000", bindings: { fill: "missing-var" } },
    { id: "b", type: "RECTANGLE", x: 20, y: 0, w: 10, h: 10, fill: "#00FF00" },
    { id: "box", type: "FRAME", x: 0, y: 100, w: 300, h: 200, children: [
      { id: "x", type: "RECTANGLE", x: 0, y: 0, w: 10, h: 10 },
      { id: "y", type: "RECTANGLE", x: 20, y: 0, w: 10, h: 10, fill: "#0000FF", bindings: { fill: "missing-2" } }
    ] },
    { id: "other", type: "FRAME", x: 400, y: 100, w: 300, h: 200, children: [] },
    { id: "comp", type: "COMPONENT", x: 0, y: 400, w: 40, h: 40 },
    { id: "inst", type: "INSTANCE", x: 100, y: 400, w: 40, h: 40, componentId: "comp" },
    { id: "set-sm", type: "COMPONENT_SET", x: 200, y: 400, w: 100, h: 50, variantAxes: { size: ["sm"] }, children: [
      { id: "sm-1", type: "COMPONENT", w: 40, h: 40, variant: { size: "sm" } },
      { id: "sm-2", type: "COMPONENT", x: 50, w: 40, h: 40, variant: { size: "sm" } }
    ] },
    { id: "set-lg", type: "COMPONENT_SET", x: 400, y: 400, w: 100, h: 50, variantAxes: { size: ["lg"] }, children: [
      { id: "lg-1", type: "COMPONENT", w: 40, h: 40, variant: { size: "lg" } }
    ] }
  ]
});
const preExisting = /missing-var|missing-2/;

test("post-patch validation ignores issues already in the input (Gate repro: missing variable on a, rename b)", () => {
  const document = preInvalidDocument();
  const before = validateDocument(document);
  assert.equal(before.length, 2, before.join("; "));
  assert.match(before.join("\n"), /variable 'missing-var' is not defined/);
  const result = validatePatch(document, patchOf(setOp("b", { name: "renamed" })));
  assert.equal(result.valid, true, result.issues.map((issue) => issue.message).join("; "));
  assert.equal(nodeById(result.document!, "b").name, "renamed");
  assert.deepEqual(validateDocument(result.document!), before, "pre-existing issues are still there, untouched, and not reported");
  assert.doesNotThrow(() => applyPatch(document, normalizePatch(patchOf(setOp("b", { name: "renamed" })))));
});

test("post-patch validation still fails on issues the patch introduces and names only those", () => {
  const document = preInvalidDocument();
  const patch = patchOf(setOp("b", { name: "renamed" }), { op: "append", parent: "other", node: { id: "fresh", type: "RECTANGLE", w: 5, h: 5, bindings: { fill: "brand-new" } } });
  const result = validatePatch(document, patch);
  assert.equal(result.valid, false);
  assert.equal(result.issues.length, 1, result.issues.map((issue) => issue.message).join("; "));
  assert.equal(result.issues[0].code, "PATCH_RESULT_INVALID");
  assert.match(result.issues[0].message, /node 'fresh'.*variable 'brand-new' is not defined/);
  assert.doesNotMatch(JSON.stringify(result.issues), preExisting);
  assert.throws(() => applyPatch(document, normalizePatch(patch)), (error: unknown) => error instanceof PatchError && error.issues.length === 1 && /brand-new/.test(error.message) && !preExisting.test(error.message));
  // A second copy of an existing problem is new, too: the comparison is a multiset per node.
  const copy = validatePatch(document, patchOf({ op: "append", parent: "other", node: { id: "twin", type: "RECTANGLE", w: 5, h: 5, bindings: { fill: "missing-var" } } }));
  assert.equal(copy.valid, false);
  assert.equal(copy.issues.length, 1);
  assert.match(copy.issues[0].message, /node 'twin'/);
  // The diff is uncapped: with more than 30 pre-existing issues a new one is still found.
  const noisy = normalize({ canvas: { id: "screen", width: 800, height: 600 }, nodes: [
    ...Array.from({ length: 35 }, (_, index) => ({ id: `n${index}`, type: "RECTANGLE", w: 5, h: 5, bindings: { fill: `gone-${index}` } })),
    { id: "host", type: "FRAME", w: 50, h: 50, children: [] }
  ] });
  const late = validatePatch(noisy, patchOf({ op: "append", parent: "host", node: { id: "late", type: "RECTANGLE", w: 5, h: 5, bindings: { fill: "gone-late" } } }));
  assert.equal(late.valid, false);
  assert.deepEqual(late.issues.map((issue) => /gone-late/.test(issue.message)), [true]);
});

test("touching a node that already has an issue does not count that issue as new", () => {
  const document = preInvalidDocument();
  const result = validatePatch(document, patchOf(setOp("a", { name: "still broken", x: 5, opacity: 0.5 }), setOp("y", { name: "also broken", w: 12 })));
  assert.equal(result.valid, true, result.issues.map((issue) => issue.message).join("; "));
  assert.equal(validateDocument(result.document!).length, 2);
  // Fixing the issue (replacing the bound fill detaches the binding) is fine as well.
  const fixed = validatePatch(document, patchOf(setOp("a", { fill: "#123456" })));
  assert.equal(fixed.valid, true);
  assert.equal(validateDocument(fixed.document!).length, 1);
});

test("issue identity is node id + property path, so index shifts from insert, move and remove don't make old issues new", () => {
  const document = preInvalidDocument();
  const ok = (label: string, ...operations: unknown[]) => {
    const result = validatePatch(document, patchOf(...operations));
    assert.equal(result.valid, true, `${label}: ${result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    assert.equal(validateDocument(result.document!).length, 2, `${label}: pre-existing issues remain`);
    return result.document!;
  };
  // (a) insert a sibling before nodes that already have issues: y's and a's paths both shift.
  ok("insert in box", { op: "insert", parent: "box", index: 0, node: { id: "new-1", type: "RECTANGLE", w: 5, h: 5 } });
  ok("insert at root", { op: "insert", parent: "screen", index: 0, node: { id: "new-2", type: "FRAME", w: 5, h: 5, children: [] } });
  // (b) move and remove that shift indexes, including moving the broken node itself.
  ok("reorder", { op: "move", id: "x", parent: "box", index: 1 });
  ok("move broken node", { op: "move", id: "y", parent: "other", index: 0 });
  ok("move ahead of a", { op: "move", id: "other", parent: "screen", index: 0 });
  ok("remove sibling", { op: "remove", id: "x" });
  ok("remove before a", { op: "remove", id: "b" }, { op: "remove", id: "other" });
  // Index-shifting remove plus insert plus move in one patch.
  ok("combined", { op: "remove", id: "x" }, { op: "insert", parent: "screen", index: 0, node: { id: "new-3", type: "RECTANGLE", w: 5, h: 5 } }, { op: "move", id: "a", parent: "other", index: 0 });
});

test("issues the patch causes on nodes it only touched indirectly are still reported", () => {
  const document = preInvalidDocument();
  // Removing a component breaks the untouched instance that uses it.
  const removed = validatePatch(document, patchOf({ op: "remove", id: "comp" }));
  assert.equal(removed.valid, false);
  assert.equal(removed.issues.length, 1);
  assert.match(removed.issues[0].message, /node 'inst'.*component 'comp' is not defined/);
  // Moving a variant into a set that doesn't declare its value creates a new conflict.
  const moved = validatePatch(document, patchOf({ op: "move", id: "sm-2", parent: "set-lg", index: 1 }));
  assert.equal(moved.valid, false);
  assert.equal(moved.issues.length, 1, moved.issues.map((issue) => issue.message).join("; "));
  assert.match(moved.issues[0].message, /node 'sm-2'.*value 'sm' is not declared in variantAxes/);
  assert.doesNotMatch(JSON.stringify([...removed.issues, ...moved.issues]), preExisting);
});

test("e2e: the showcase document goes through a sequence of set patches, validates, and round-trips", () => {
  const original = normalize(fixture("design-language-showcase.json"));
  assert.deepEqual(validateDocument(original), []);
  const chartBefore = nodeById(original, "revenue-chart");
  const chartTextBefore = chartBefore.children[0].properties.position;
  const steps: unknown[][] = [
    [setOp("revenue-chart", { x: 60, cornerRadius: 12 })],
    [setOp("topbar", { layout: { itemSpacing: 24 } }), setOp("metric-row", { layout: { padding: { left: 4 } } })],
    [setOp("upgrade-card", { fill: "#101828", effects: [] }), setOp("sidebar", { w: 280 })],
    [setOp("main", { name: "Main content", opacity: 0.95 })],
    [{ op: "move", id: "revenue-chart", parent: "main", index: 0 }, setOp("revenue-chart", { y: 400 })]
  ];
  let current = original;
  for (const operations of steps) current = applyRaw(current, ...operations);
  assert.deepEqual(validateDocument(current), []);
  const main = nodeById(current, "main");
  const chart = nodeById(current, "revenue-chart");
  assert.equal(main.name, "Main content");
  assert.deepEqual(chart.properties.position, { x: main.properties.position.x + 60, y: main.properties.position.y + 400 });
  const chartText = chart.children[0].properties.position;
  assert.deepEqual({ x: chartText.x - chart.properties.position.x, y: chartText.y - chart.properties.position.y }, { x: chartTextBefore.x - chartBefore.properties.position.x, y: chartTextBefore.y - chartBefore.properties.position.y }, "children ride along");
  const topbar = nodeById(current, "topbar").properties.layout!;
  assert.equal(topbar.itemSpacing, 24);
  assert.equal(topbar.direction, nodeById(original, "topbar").properties.layout?.direction);
  assert.deepEqual(nodeById(current, "metric-row").properties.layout?.padding, { ...nodeById(original, "metric-row").properties.layout?.padding, left: 4 });
  // Round trip: the original is untouched and replaying the same sequence is deterministic.
  assert.deepEqual(nodeById(original, "revenue-chart").properties.position, chartBefore.properties.position);
  let replay = original;
  for (const operations of steps) replay = applyRaw(replay, ...operations);
  assert.deepEqual(replay, current);
  // A patched document is a valid input for further patches.
  assert.equal(validatePatch(current, patchOf(setOp("main", { opacity: 1 }))).valid, true);
});


test("componentPropertyReferences links children to owning COMPONENT properties", () => {
  const source = {
    canvas: { width: 400, height: 200 },
    nodes: [
      { id: "icon", type: "COMPONENT", w: 16, h: 16, fill: "#111111" },
      {
        id: "button",
        type: "COMPONENT",
        w: 160,
        h: 48,
        componentProperties: [
          { name: "Label", type: "TEXT", defaultValue: "Continue" },
          { name: "ShowIcon", type: "BOOLEAN", defaultValue: true },
          { name: "Icon", type: "INSTANCE_SWAP", defaultValue: "icon" }
        ],
        children: [
          { id: "label", type: "TEXT", w: 100, h: 20, text: "Continue", componentPropertyReferences: { characters: "Label" } },
          { id: "icon-slot", type: "INSTANCE", componentId: "icon", w: 16, h: 16, componentPropertyReferences: { visible: "ShowIcon", mainComponent: "Icon" } }
        ]
      },
      { id: "button-1", type: "INSTANCE", componentId: "button", w: 160, h: 48, instanceProperties: { Label: "Start free", ShowIcon: false } }
    ]
  };
  const result = validate(source);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
  const document = normalize(source);
  const canvasChildren = document.nodes[0].children;
  const button = canvasChildren.find((node) => node.id === "button")!;
  const instance = canvasChildren.find((node) => node.id === "button-1")!;
  assert.deepEqual(button.children[0].properties.componentPropertyReferences, { characters: "Label" });
  assert.deepEqual(button.children[1].properties.componentPropertyReferences, { visible: "ShowIcon", mainComponent: "Icon" });
  assert.deepEqual(instance.properties.instanceProperties, { Label: "Start free", ShowIcon: false });
});

test("rejects componentPropertyReferences with wrong type, missing prop, wrong node type, or crossing INSTANCE", () => {
  const baseProps = [
    { name: "Label", type: "TEXT", defaultValue: "Hi" },
    { name: "ShowIcon", type: "BOOLEAN", defaultValue: true },
    { name: "Icon", type: "INSTANCE_SWAP", defaultValue: "icon" }
  ];
  const wrongType = validate({
    canvas: { width: 100, height: 100 },
    nodes: [{
      id: "button", type: "COMPONENT", w: 40, h: 40, componentProperties: baseProps,
      children: [{ id: "label", type: "TEXT", w: 20, h: 10, text: "Hi", componentPropertyReferences: { characters: "ShowIcon" } }]
    }]
  });
  assert.equal(wrongType.valid, false);
  assert.ok(wrongType.issues.some((issue) => /characters/.test(issue.path) && /TEXT/.test(issue.message)));

  const missing = validate({
    canvas: { width: 100, height: 100 },
    nodes: [{
      id: "button", type: "COMPONENT", w: 40, h: 40, componentProperties: baseProps,
      children: [{ id: "label", type: "TEXT", w: 20, h: 10, text: "Hi", componentPropertyReferences: { characters: "Missing" } }]
    }]
  });
  assert.equal(missing.valid, false);
  assert.ok(missing.issues.some((issue) => /Missing/.test(issue.message)));

  const wrongNode = validate({
    canvas: { width: 100, height: 100 },
    nodes: [{
      id: "button", type: "COMPONENT", w: 40, h: 40, componentProperties: baseProps,
      children: [{ id: "box", type: "RECTANGLE", w: 20, h: 10, componentPropertyReferences: { characters: "Label" } }]
    }]
  });
  assert.equal(wrongNode.valid, false);
  assert.ok(wrongNode.issues.some((issue) => /TEXT nodes/.test(issue.message)));

  const crossing = validate({
    canvas: { width: 100, height: 100 },
    nodes: [
      { id: "icon", type: "COMPONENT", w: 8, h: 8 },
      {
        id: "button", type: "COMPONENT", w: 40, h: 40, componentProperties: baseProps,
        children: [{
          id: "slot", type: "INSTANCE", componentId: "icon", w: 8, h: 8,
          children: [{ id: "nested-text", type: "TEXT", w: 8, h: 8, text: "x", componentPropertyReferences: { characters: "Label" } }]
        }]
      }
    ]
  });
  assert.equal(crossing.valid, false);
  assert.ok(crossing.issues.some((issue) => /nested INSTANCE/.test(issue.message)));

  const mainOnText = validate({
    canvas: { width: 100, height: 100 },
    nodes: [{
      id: "button", type: "COMPONENT", w: 40, h: 40, componentProperties: baseProps,
      children: [{ id: "label", type: "TEXT", w: 20, h: 10, text: "Hi", componentPropertyReferences: { mainComponent: "Icon" } }]
    }]
  });
  assert.equal(mainOnText.valid, false);
  assert.ok(mainOnText.issues.some((issue) => /INSTANCE nodes/.test(issue.message)));
});

test("rejects instanceProperties keys/types that do not match the main component", () => {
  const missingKey = validate({
    canvas: { width: 100, height: 100 },
    nodes: [
      { id: "button", type: "COMPONENT", w: 40, h: 40, componentProperties: [{ name: "Label", type: "TEXT", defaultValue: "Hi" }] },
      { id: "copy", type: "INSTANCE", componentId: "button", w: 40, h: 40, instanceProperties: { Title: "Nope" } }
    ]
  });
  assert.equal(missingKey.valid, false);
  assert.ok(missingKey.issues.some((issue) => /Title/.test(issue.message)));

  const wrongValue = validate({
    canvas: { width: 100, height: 100 },
    nodes: [
      { id: "button", type: "COMPONENT", w: 40, h: 40, componentProperties: [{ name: "ShowIcon", type: "BOOLEAN", defaultValue: true }] },
      { id: "copy", type: "INSTANCE", componentId: "button", w: 40, h: 40, instanceProperties: { ShowIcon: "yes" } }
    ]
  });
  assert.equal(wrongValue.valid, false);
  assert.ok(wrongValue.issues.some((issue) => /boolean/.test(issue.message)));
});


test("rejects INSTANCE_SWAP defaultValue or override that is missing or not a COMPONENT", () => {
  const missingDefault = validate({
    canvas: { width: 100, height: 100 },
    nodes: [{
      id: "button", type: "COMPONENT", w: 40, h: 40,
      componentProperties: [{ name: "Icon", type: "INSTANCE_SWAP", defaultValue: "ghost-icon" }]
    }]
  });
  assert.equal(missingDefault.valid, false);
  assert.ok(missingDefault.issues.some((issue) => issue.path.includes("componentProperties") && /ghost-icon/.test(issue.message) && /not defined/.test(issue.message)));

  const nonComponentDefault = validate({
    canvas: { width: 100, height: 100 },
    nodes: [
      { id: "frame-slot", type: "FRAME", w: 16, h: 16 },
      {
        id: "button", type: "COMPONENT", w: 40, h: 40,
        componentProperties: [{ name: "Icon", type: "INSTANCE_SWAP", defaultValue: "frame-slot" }]
      }
    ]
  });
  assert.equal(nonComponentDefault.valid, false);
  assert.ok(nonComponentDefault.issues.some((issue) => issue.path.includes("componentProperties") && /frame-slot/.test(issue.message) && /FRAME/.test(issue.message) && /COMPONENT/.test(issue.message)));

  const missingOverride = validate({
    canvas: { width: 100, height: 100 },
    nodes: [
      { id: "icon", type: "COMPONENT", w: 8, h: 8 },
      {
        id: "button", type: "COMPONENT", w: 40, h: 40,
        componentProperties: [{ name: "Icon", type: "INSTANCE_SWAP", defaultValue: "icon" }]
      },
      { id: "copy", type: "INSTANCE", componentId: "button", w: 40, h: 40, instanceProperties: { Icon: "missing-icon" } }
    ]
  });
  assert.equal(missingOverride.valid, false);
  assert.ok(missingOverride.issues.some((issue) => issue.path.includes("instanceProperties.Icon") && /missing-icon/.test(issue.message)));

  const nonComponentOverride = validate({
    canvas: { width: 100, height: 100 },
    nodes: [
      { id: "icon", type: "COMPONENT", w: 8, h: 8 },
      { id: "frame-slot", type: "FRAME", w: 8, h: 8 },
      {
        id: "button", type: "COMPONENT", w: 40, h: 40,
        componentProperties: [{ name: "Icon", type: "INSTANCE_SWAP", defaultValue: "icon" }]
      },
      { id: "copy", type: "INSTANCE", componentId: "button", w: 40, h: 40, instanceProperties: { Icon: "frame-slot" } }
    ]
  });
  assert.equal(nonComponentOverride.valid, false);
  assert.ok(nonComponentOverride.issues.some((issue) => issue.path.includes("instanceProperties.Icon") && /frame-slot/.test(issue.message) && /FRAME/.test(issue.message)));
});
