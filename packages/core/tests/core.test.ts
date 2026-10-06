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
