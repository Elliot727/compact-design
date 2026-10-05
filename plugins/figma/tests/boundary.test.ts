import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isVariableModeLimitError, variableModeLimitWarning } from "../src/plugin/mode-limit";
import { compactEffects, compactLayoutGrids, compactOverflow, compactStrokeAppearance, compactTextTypography, exportCanvasId, uniqueExportIds } from "../src/plugin/exporter";
import { clearEffectWarnings, effectFromData, effectsFromData, effectWarnings } from "../src/plugin/paints";
import {
  collectStyleIdsFromNode,
  compactStyleExportId,
  isUsableStyleId,
  styleRefsFromNodeIds,
  uniqueStyleExportIds
} from "../src/plugin/export-styles";
import {
  assembleVariableGroups,
  buildExplicitVariableModes,
  compactVariableExportId,
  exportColorChannels,
  exportFigmaVariableValue,
  nodeFieldBindings,
  paintColorAliasId,
  resolveAliasedRawValue,
  uniqueVariableExportIds
} from "../src/plugin/export-variables";
import { planExport, type ExportCandidate } from "../src/plugin/export-plan";
import { validate } from "@compact-design/core";

test("Figma adapter consumes core and does not duplicate language modules", () => {
  const files: string[] = [];
  const walk = (directory: string): void => readdirSync(directory).forEach((name) => { const path = join(directory, name); statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") && files.push(path); });
  walk("src");
  const source = files.map((path) => readFileSync(path, "utf8")).join("\n");
  assert.match(source, /from "@compact-design\/core"/);
  assert.doesNotMatch(source, /function (normalizeDocument|validateDocument|lintDocument)\b/);
});

test("core workspace has no Figma runtime or typing dependency", () => {
  const manifest = JSON.parse(readFileSync("../../packages/core/package.json", "utf8"));
  assert.equal(manifest.dependencies?.["@figma/plugin-typings"], undefined);
  assert.equal(manifest.devDependencies?.["@figma/plugin-typings"], undefined);
});

test("plugin UI polls the Compact Design MCP bridge on localhost", () => {
  const source = readFileSync("src/ui/bridge.ts", "utf8");
  assert.match(source, /localhost:18791/);
  assert.match(source, /\/poll/);
});

test("export assigns unique IDs when copied layers retain plugin IDs", () => {
  assert.deepEqual(uniqueExportIds(["card", "card", "card"]), ["card", "card-2", "card-3"]);
  assert.deepEqual(uniqueExportIds(["1087:813", "1087:813"]), ["1087:813", "1087:813-2"]);
});

test("non-frame export roots get a canvas id that does not collide with the layer", () => {
  assert.equal(exportCanvasId("button", "FRAME"), "button");
  assert.equal(exportCanvasId("button", "COMPONENT"), "button-canvas");
});


test("export layoutGrids maps Figma grids to Compact shape with 0-255 color", () => {
  assert.deepEqual(compactLayoutGrids([
    { pattern: "GRID", sectionSize: 8, visible: true, color: { r: 1, g: 0, b: 0, a: 0.1 } },
    { pattern: "COLUMNS", alignment: "STRETCH", count: 12, gutterSize: 20, offset: 0, visible: true, color: { r: 0, g: 0, b: 1, a: 0.1 } },
    { pattern: "ROWS", alignment: "MIN", count: 4, gutterSize: 8, offset: 16, sectionSize: 64, visible: false, color: { r: 0, g: 0.5, b: 0, a: 1 } }
  ] as LayoutGrid[]), [
    { pattern: "GRID", sectionSize: 8, color: { r: 255, g: 0, b: 0, a: 0.1 }, visible: true },
    { pattern: "COLUMNS", alignment: "STRETCH", count: 12, gutterSize: 20, offset: 0, color: { r: 0, g: 0, b: 255, a: 0.1 }, visible: true },
    { pattern: "ROWS", alignment: "MIN", count: 4, gutterSize: 8, offset: 16, sectionSize: 64, color: { r: 0, g: 128, b: 0, a: 1 }, visible: false }
  ]);
  assert.deepEqual(compactLayoutGrids([]), []);
});


test("export stroke appearance omits defaults and skips mixed values", () => {
  const mixed = Symbol("mixed");
  assert.deepEqual(compactStrokeAppearance({ strokeAlign: "CENTER", strokeCap: "NONE", strokeJoin: "MITER" }, mixed), {});
  assert.deepEqual(compactStrokeAppearance({ strokeAlign: "INSIDE", strokeCap: "ROUND", strokeJoin: "ROUND" }, mixed), {
    strokeAlign: "INSIDE",
    strokeCap: "ROUND",
    strokeJoin: "ROUND"
  });
  assert.deepEqual(compactStrokeAppearance({ strokeAlign: "OUTSIDE", strokeCap: mixed, strokeJoin: mixed }, mixed), {
    strokeAlign: "OUTSIDE"
  });
  assert.deepEqual(compactStrokeAppearance({ strokeCap: "SQUARE", strokeJoin: "BEVEL" }, mixed), {
    strokeCap: "SQUARE",
    strokeJoin: "BEVEL"
  });
  assert.deepEqual(compactStrokeAppearance({}, mixed), {});
});

test("export text typography emits Probe brief fields and skips defaults", () => {
  const mixed = Symbol("mixed");
  assert.deepEqual(compactTextTypography({
    textCase: "ORIGINAL",
    paragraphIndent: 0,
    listSpacing: 0,
    hangingPunctuation: false,
    hangingList: false
  }, mixed), {});
  assert.deepEqual(compactTextTypography({
    textCase: "UPPER",
    paragraphIndent: 24,
    listSpacing: 8,
    hangingPunctuation: true,
    hangingList: true
  }, mixed), {
    textCase: "UPPER",
    paragraphIndent: 24,
    listSpacing: 8,
    hangingPunctuation: true,
    hangingList: true
  });
  assert.deepEqual(compactTextTypography({
    textCase: mixed,
    paragraphIndent: mixed,
    listSpacing: mixed,
    hangingPunctuation: false,
    hangingList: false
  }, mixed), {});
  assert.deepEqual(compactTextTypography({
    textCase: "TITLE",
    hangingPunctuation: true
  }, mixed), {
    textCase: "TITLE",
    hangingPunctuation: true
  });
  assert.deepEqual(compactTextTypography({}, mixed), {});
});


test("export overflow and fixed children emits Probe brief fields and skips defaults", () => {
  assert.deepEqual(compactOverflow({
    overflowDirection: "NONE",
    numberOfFixedChildren: 0
  }), {});
  assert.deepEqual(compactOverflow({
    overflowDirection: "VERTICAL",
    numberOfFixedChildren: 2
  }), {
    overflowDirection: "VERTICAL_SCROLLING",
    numberOfFixedChildren: 2
  });
  assert.deepEqual(compactOverflow({
    overflowDirection: "HORIZONTAL",
    numberOfFixedChildren: 0
  }), {
    overflowDirection: "HORIZONTAL_SCROLLING"
  });
  assert.deepEqual(compactOverflow({
    overflowDirection: "BOTH",
    numberOfFixedChildren: 1
  }), {
    overflowDirection: "HORIZONTAL_AND_VERTICAL_SCROLLING",
    numberOfFixedChildren: 1
  });
  assert.deepEqual(compactOverflow({
    overflowDirection: "NONE",
    numberOfFixedChildren: 3
  }), {
    numberOfFixedChildren: 3
  });
  assert.deepEqual(compactOverflow({}), {});
});

test("export style ids prefer plugin data then name then figma id", () => {
  assert.equal(compactStyleExportId("Northstar/Heading", "heading-style", "S:1"), "heading-style");
  assert.equal(compactStyleExportId("Northstar/Heading", "", "S:1"), "Northstar/Heading");
  assert.equal(compactStyleExportId("Northstar/Heading", undefined, "S:1"), "Northstar/Heading");
  assert.equal(compactStyleExportId("", undefined, "S:1"), "S:1");
  assert.deepEqual(uniqueStyleExportIds(["surface", "surface", "body"]), ["surface", "surface-2", "body"]);
});

test("export styleRefs maps fill/stroke/text and skips empty or mixed ids", () => {
  const mixed = Symbol("mixed");
  const resolve = (id: string) => ({ "S:fill": "surface-style", "S:stroke": "border-style", "S:text": "heading-style" }[id]);
  assert.deepEqual(styleRefsFromNodeIds({
    fillStyleId: "S:fill",
    strokeStyleId: "S:stroke",
    textStyleId: "S:text"
  }, resolve, mixed), { fill: "surface-style", stroke: "border-style", text: "heading-style" });
  assert.equal(styleRefsFromNodeIds({ fillStyleId: "", strokeStyleId: mixed, textStyleId: mixed }, resolve, mixed), undefined);
  assert.equal(styleRefsFromNodeIds({ fillStyleId: "S:unknown" }, resolve, mixed), undefined);
  assert.equal(isUsableStyleId("", mixed), false);
  assert.equal(isUsableStyleId(mixed, mixed), false);
  assert.equal(isUsableStyleId("S:fill", mixed), true);
  assert.deepEqual(collectStyleIdsFromNode({
    type: "TEXT",
    fillStyleId: "S:fill",
    strokeStyleId: "",
    textStyleId: "S:text"
  }, mixed), ["S:fill", "S:text"]);
  assert.deepEqual(collectStyleIdsFromNode({
    type: "RECTANGLE",
    fillStyleId: "S:fill",
    textStyleId: "S:text"
  }, mixed), ["S:fill"]);
});

test("exportSelection does not copy node-only props onto canvas", () => {
  const source = readFileSync("src/plugin/exporter.ts", "utf8");
  assert.doesNotMatch(source, /canvas\.(bindings|variableModes|styleRefs)\s*=/);
});

test("exported FRAME canvas with styleRefs on nodes validates without canvas node-only props", () => {
  const polluted = validate({
    canvas: {
      id: "home",
      name: "Home",
      width: 390,
      height: 844,
      fill: "#FFFFFF",
      clipsContent: true,
      styleRefs: { fill: "ink" },
      bindings: { fill: "surface" },
      variableModes: { Theme: "Dark" }
    },
    nodes: [{ id: "card", type: "FRAME", w: 100, h: 40, styleRefs: { fill: "ink" } }],
    styles: [{ id: "ink", name: "Ink", type: "PAINT", paints: ["#112233"] }],
    variables: [{
      name: "Theme",
      modes: ["Light", "Dark"],
      items: [{ id: "surface", name: "colour/surface", type: "COLOR", values: { Light: { r: 248, g: 245, b: 238, a: 1 }, Dark: { r: 26, g: 27, b: 24, a: 1 } } }]
    }]
  });
  assert.equal(polluted.valid, false);
  assert.ok(polluted.issues.some((issue) => issue.code === "SCHEMA_ADDITIONALPROPERTIES" && issue.path.startsWith("$/canvas")));

  const clean = validate({
    canvas: {
      id: "home",
      name: "Home",
      x: 0,
      width: 390,
      height: 844,
      fill: "#FFFFFF",
      clipsContent: true
    },
    nodes: [
      { id: "card", type: "FRAME", w: 100, h: 40, styleRefs: { fill: "ink" }, bindings: { fill: "surface" }, variableModes: { Theme: "Dark" } }
    ],
    styles: [{ id: "ink", name: "Ink", type: "PAINT", paints: ["#112233"] }],
    variables: [{
      name: "Theme",
      modes: ["Light", "Dark"],
      items: [{ id: "surface", name: "colour/surface", type: "COLOR", values: { Light: { r: 248, g: 245, b: 238, a: 1 }, Dark: { r: 26, g: 27, b: 24, a: 1 } } }]
    }]
  });
  assert.equal(clean.valid, true, clean.issues.map((issue) => `${issue.code} ${issue.path}: ${issue.message}`).join("\n"));
  const root = clean.document!.nodes[0];
  assert.equal(root.id, "home");
  assert.equal(root.properties.bindings, undefined);
  assert.equal(root.properties.variableModes, undefined);
  assert.equal(root.properties.styleRefs, undefined);
  const card = root.children[0];
  assert.deepEqual(card.properties.styleRefs, { fill: "ink" });
  assert.deepEqual(card.properties.bindings, { fill: "surface" });
  assert.deepEqual(card.properties.variableModes, { Theme: "Dark" });
});


function layer(partial: ExportCandidate): ExportCandidate {
  return partial;
}

test("page export returns every top-level layer and keeps an in-page component linked", () => {
  const plan = planExport([
    layer({ figmaId: "btn", compactId: "button", type: "COMPONENT", name: "Button", parentFigmaId: null }),
    layer({ figmaId: "screen", compactId: "home", type: "FRAME", name: "Home", parentFigmaId: null }),
    layer({ figmaId: "use", compactId: "use-button", type: "INSTANCE", name: "Submit", parentFigmaId: "screen", mainComponentFigmaId: "btn" })
  ], { scope: "page" });
  assert.deepEqual(plan.rootIds, ["btn", "screen"]);
  assert.deepEqual(plan.warnings, []);
});

test("export by compact id includes an outside main component before the target", () => {
  const plan = planExport([
    layer({ figmaId: "set", compactId: "button-set", type: "COMPONENT_SET", name: "Button", parentFigmaId: "library" }),
    layer({ figmaId: "primary", compactId: "button-primary", type: "COMPONENT", name: "State=Default", parentFigmaId: "set" }),
    layer({ figmaId: "library", compactId: "library", type: "FRAME", name: "Library", parentFigmaId: null }),
    layer({ figmaId: "screen", compactId: "home", type: "FRAME", name: "Home", parentFigmaId: null }),
    layer({ figmaId: "use", compactId: "use-button", type: "INSTANCE", name: "Submit", parentFigmaId: "screen", mainComponentFigmaId: "primary" })
  ], { id: "home" });
  assert.deepEqual(plan.rootIds, ["set", "screen"]);
  assert.match(plan.warnings.join("\n"), /Included 'Button'/);
});

test("export by id reports a missing layer and a component that lives on another page", () => {
  assert.throws(() => planExport([
    layer({ figmaId: "screen", compactId: "home", type: "FRAME", name: "Home", parentFigmaId: null })
  ], { id: "missing" }), /missing/);
  const plan = planExport([
    layer({ figmaId: "screen", compactId: "home", type: "FRAME", name: "Home", parentFigmaId: null }),
    layer({ figmaId: "use", compactId: "use-button", type: "INSTANCE", name: "Submit", parentFigmaId: "screen", mainComponentFigmaId: "remote" })
  ], { id: "home" });
  assert.deepEqual(plan.rootIds, ["screen"]);
  assert.match(plan.warnings[0], /flattened/);
});

test("selection export still requires a selection", () => {
  assert.throws(() => planExport([], { scope: "selection", selectionIds: [] }), /Select at least one/);
});

test("export path reads instance main components asynchronously under dynamic-page", () => {
  const exporter = readFileSync("src/plugin/exporter.ts", "utf8");
  const main = readFileSync("src/plugin/main.ts", "utf8");
  assert.match(exporter, /getMainComponentAsync\s*\(/);
  assert.doesNotMatch(exporter, /\.mainComponent\b/);
  assert.doesNotMatch(exporter, /(?<!get)getMainComponent\s*\(/);
  assert.match(main, /await collectExportCandidates\(/);
  assert.match(readFileSync("manifest.json", "utf8"), /"documentAccess"\s*:\s*"dynamic-page"/);
});

test("built UI contains one syntactically valid, uncorrupted script", () => {
  const html = readFileSync("dist/ui.html", "utf8");
  assert.doesNotMatch(html, /<!-- UI_SCRIPT -->/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0][1]));
});

test("Figma variable mode plan limits degrade to a clear warning", () => {
  assert.equal(isVariableModeLimitError(new Error("in addMode: Limited to 1 modes only")), true);
  assert.equal(isVariableModeLimitError(new Error("Permission denied")), false);
  const warning = variableModeLimitWarning("Theme", ["Light"], ["Dark"]);
  assert.match(warning, /Imported Light/);
  assert.match(warning, /omitted Dark/);
});

test("compact variable export id prefers plugin data over name", () => {
  assert.equal(compactVariableExportId("colour/surface", "surface"), "surface");
  assert.equal(compactVariableExportId("colour/surface"), "colour/surface");
  assert.equal(compactVariableExportId("colour/surface", ""), "colour/surface");
});

test("export color channels scale Figma 0-1 RGB to Compact 0-255", () => {
  assert.deepEqual(exportColorChannels({ r: 1, g: 0, b: 0.5, a: 0.5 }), { r: 255, g: 0, b: 128, a: 0.5 });
  assert.deepEqual(exportColorChannels({ r: 0, g: 0, b: 0 }, 0.25), { r: 0, g: 0, b: 0, a: 0.25 });
});

test("export variable value keeps floats and resolves aliases when lookup is provided", () => {
  assert.deepEqual(exportFigmaVariableValue("FLOAT", 16), { value: 16 });
  assert.deepEqual(exportFigmaVariableValue("COLOR", { r: 1, g: 1, b: 1, a: 1 }), { value: { r: 255, g: 255, b: 255, a: 1 } });
  assert.deepEqual(exportFigmaVariableValue("COLOR", { type: "VARIABLE_ALIAS", id: "VariableID:1:2" }), { skippedAlias: true });
  const lookup = (id: string) => id === "VariableID:1:2"
    ? { modes: [{ modeId: "m", name: "Light" }], valuesByMode: { m: { r: 1, g: 0, b: 0, a: 1 } } }
    : undefined;
  assert.deepEqual(
    exportFigmaVariableValue("COLOR", { type: "VARIABLE_ALIAS", id: "VariableID:1:2" }, "Light", lookup),
    { value: { r: 255, g: 0, b: 0, a: 1 } }
  );
});

test("paint color alias and node field bindings map to compact keys", () => {
  assert.equal(paintColorAliasId({ type: "SOLID", boundVariables: { color: { id: "VariableID:1:2" } } }), "VariableID:1:2");
  assert.equal(paintColorAliasId({ type: "IMAGE" }), undefined);
  const keys = new Map([["VariableID:1:2", "surface"], ["VariableID:3:4", "radius"]]);
  assert.deepEqual(nodeFieldBindings({
    width: { type: "VARIABLE_ALIAS", id: "VariableID:3:4" },
    fills: [{ type: "VARIABLE_ALIAS", id: "VariableID:1:2" }],
    topLeftRadius: { type: "VARIABLE_ALIAS", id: "VariableID:3:4" },
    topRightRadius: { type: "VARIABLE_ALIAS", id: "VariableID:3:4" },
    bottomRightRadius: { type: "VARIABLE_ALIAS", id: "VariableID:3:4" },
    bottomLeftRadius: { type: "VARIABLE_ALIAS", id: "VariableID:3:4" }
  }, (id) => keys.get(id)), { width: "radius", cornerRadius: "radius" });
});

test("explicit variable modes resolve collection and mode names", () => {
  const modes = buildExplicitVariableModes(
    { "VariableCollectionId:1:1": "1:2" },
    (id) => id === "VariableCollectionId:1:1" ? { name: "Theme", modes: [{ modeId: "1:1", name: "Light" }, { modeId: "1:2", name: "Dark" }] } : undefined
  );
  assert.deepEqual(modes, { Theme: "Dark" });
  assert.equal(buildExplicitVariableModes({ missing: "x" }, () => undefined), undefined);
});

test("assemble variable groups emits Theme Light/Dark with bindings-ready ids", () => {
  const { groups, exportIdByFigmaId } = assembleVariableGroups([{
    name: "Theme",
    modes: [{ modeId: "m-light", name: "Light" }, { modeId: "m-dark", name: "Dark" }],
    items: [{
      figmaId: "VariableID:surface",
      preferredId: "surface",
      name: "colour/surface",
      type: "COLOR",
      valuesByMode: {
        "m-light": { r: 248 / 255, g: 245 / 255, b: 238 / 255, a: 1 },
        "m-dark": { r: 26 / 255, g: 27 / 255, b: 24 / 255, a: 1 }
      }
    }]
  }], () => undefined);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].modes, ["Light", "Dark"]);
  assert.equal(groups[0].items[0].id, "surface");
  assert.equal(exportIdByFigmaId.get("VariableID:surface"), "surface");
  assert.deepEqual(groups[0].items[0].values.Light, { r: 248, g: 245, b: 238, a: 1 });
  assert.deepEqual(groups[0].items[0].values.Dark, { r: 26, g: 27, b: 24, a: 1 });
});

test("alias values resolve cycle-safe; unresolved aliases drop the variable", () => {
  const catalog: Record<string, { modes: Array<{ modeId: string; name: string }>; valuesByMode: Record<string, unknown> }> = {
    "VariableID:base": {
      modes: [{ modeId: "m-light", name: "Light" }, { modeId: "m-dark", name: "Dark" }],
      valuesByMode: {
        "m-light": { r: 1, g: 0, b: 0, a: 1 },
        "m-dark": { r: 0, g: 0, b: 1, a: 1 }
      }
    },
    "VariableID:alias": {
      modes: [{ modeId: "m-light", name: "Light" }, { modeId: "m-dark", name: "Dark" }],
      valuesByMode: {
        "m-light": { type: "VARIABLE_ALIAS", id: "VariableID:base" },
        "m-dark": { type: "VARIABLE_ALIAS", id: "VariableID:base" }
      }
    },
    "VariableID:loop-a": {
      modes: [{ modeId: "m-light", name: "Light" }, { modeId: "m-dark", name: "Dark" }],
      valuesByMode: {
        "m-light": { type: "VARIABLE_ALIAS", id: "VariableID:loop-b" },
        "m-dark": { type: "VARIABLE_ALIAS", id: "VariableID:loop-b" }
      }
    },
    "VariableID:loop-b": {
      modes: [{ modeId: "m-light", name: "Light" }, { modeId: "m-dark", name: "Dark" }],
      valuesByMode: {
        "m-light": { type: "VARIABLE_ALIAS", id: "VariableID:loop-a" },
        "m-dark": { type: "VARIABLE_ALIAS", id: "VariableID:loop-a" }
      }
    }
  };
  const lookup = (id: string) => catalog[id];
  assert.deepEqual(
    resolveAliasedRawValue({ type: "VARIABLE_ALIAS", id: "VariableID:base" }, "Dark", lookup),
    { value: { r: 0, g: 0, b: 1, a: 1 } }
  );
  assert.equal(resolveAliasedRawValue({ type: "VARIABLE_ALIAS", id: "VariableID:loop-a" }, "Light", lookup).cycle, true);

  const dropped: string[] = [];
  const { groups, exportIdByFigmaId } = assembleVariableGroups([{
    name: "Theme",
    modes: [{ modeId: "m-light", name: "Light" }, { modeId: "m-dark", name: "Dark" }],
    items: [
      { figmaId: "VariableID:alias", preferredId: "surface", name: "colour/surface", type: "COLOR", valuesByMode: catalog["VariableID:alias"].valuesByMode },
      { figmaId: "VariableID:loop-a", preferredId: "loop", name: "loop", type: "COLOR", valuesByMode: catalog["VariableID:loop-a"].valuesByMode }
    ]
  }], lookup, (figmaId) => dropped.push(figmaId));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 1);
  assert.equal(groups[0].items[0].id, "surface");
  assert.deepEqual(groups[0].items[0].values.Light, { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(groups[0].items[0].values.Dark, { r: 0, g: 0, b: 255, a: 1 });
  assert.equal(exportIdByFigmaId.has("VariableID:alias"), true);
  assert.equal(exportIdByFigmaId.has("VariableID:loop-a"), false);
  assert.deepEqual(dropped, ["VariableID:loop-a"]);
});

test("name-fallback variable ids dedupe across collisions", () => {
  assert.deepEqual(uniqueVariableExportIds(["colour/surface", "colour/surface", "brand"]), ["colour/surface", "colour/surface-2", "brand"]);
  const { groups, exportIdByFigmaId } = assembleVariableGroups([
    {
      name: "Theme",
      modes: [{ modeId: "m", name: "Default" }],
      items: [{ figmaId: "VariableID:a", preferredId: "colour/surface", name: "colour/surface", type: "FLOAT", valuesByMode: { m: 8 } }]
    },
    {
      name: "Density",
      modes: [{ modeId: "n", name: "Default" }],
      items: [{ figmaId: "VariableID:b", preferredId: "colour/surface", name: "colour/surface", type: "FLOAT", valuesByMode: { n: 16 } }]
    }
  ], () => undefined);
  assert.equal(groups[0].items[0].id, "colour/surface");
  assert.equal(groups[1].items[0].id, "colour/surface-2");
  assert.equal(exportIdByFigmaId.get("VariableID:a"), "colour/surface");
  assert.equal(exportIdByFigmaId.get("VariableID:b"), "colour/surface-2");
});

test("compactEffects preserves NOISE, TEXTURE, GLASS and classic four", () => {
  assert.deepEqual(compactEffects([
    { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.3 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true, blendMode: "NORMAL" },
    { type: "INNER_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 1, y: 2 }, radius: 4, spread: 1, visible: true, blendMode: "NORMAL" },
    { type: "LAYER_BLUR", blurType: "NORMAL", radius: 10, visible: true },
    { type: "BACKGROUND_BLUR", blurType: "PROGRESSIVE", radius: 20, startRadius: 0, startOffset: { x: 0.5, y: 0 }, endOffset: { x: 0.5, y: 1 }, visible: true },
    { type: "NOISE", noiseType: "MULTITONE", color: { r: 1, g: 0, b: 0, a: 1 }, visible: true, blendMode: "OVERLAY", noiseSize: 2, density: 0.5, opacity: 0.8 },
    { type: "TEXTURE", visible: true, noiseSize: 3, radius: 1, clipToShape: false },
    { type: "GLASS", visible: true, lightIntensity: 0.6, lightAngle: -45, refraction: 0.3, depth: 2, dispersion: 0.1, radius: 4 },
    { type: "SHADER", visible: true, id: "shader-1" }
  ] as Effect[]), [
    { type: "DROP_SHADOW", color: "#0000004D", offset: { x: 0, y: 4 }, blur: 8, spread: 0, visible: true },
    { type: "INNER_SHADOW", color: "#00000033", offset: { x: 1, y: 2 }, blur: 4, spread: 1, visible: true },
    { type: "LAYER_BLUR", blur: 10, visible: true },
    { type: "BACKGROUND_BLUR", blur: 20, visible: true, blurType: "PROGRESSIVE", startRadius: 0, startOffset: { x: 0.5, y: 0 }, endOffset: { x: 0.5, y: 1 } },
    { type: "NOISE", noiseType: "MULTITONE", color: "#FF0000", noiseSize: 2, density: 0.5, visible: true, blendMode: "OVERLAY", opacity: 0.8 },
    { type: "TEXTURE", noiseSize: 3, radius: 1, clipToShape: false, visible: true },
    { type: "GLASS", lightIntensity: 0.6, lightAngle: -45, refraction: 0.3, depth: 2, dispersion: 0.1, radius: 4, visible: true },
    { type: "SHADER", id: "shader-1", visible: true }
  ]);
});

test("compactEffects exports SHADER id, visible, and properties verbatim", () => {
  const properties = {
    "def:amount": 0.25,
    "def:tint": { r: 1, g: 0, b: 0, a: 0.5 },
    "def:center": { x: 0.5, y: 0.5 },
    "def:bound": { type: "VARIABLE_ALIAS", id: "VariableID:1:2" }
  };
  const exported = compactEffects([
    { type: "SHADER", visible: true, id: "shader-props", properties },
    { type: "SHADER", visible: true, id: "shader-empty", properties: {} },
    { type: "SHADER", visible: false, id: "shader-hidden" }
  ] as Effect[]);
  assert.deepEqual(exported, [
    { type: "SHADER", id: "shader-props", visible: true, properties },
    { type: "SHADER", id: "shader-empty", visible: true }
  ]);
  assert.notEqual((exported[0] as { properties: unknown }).properties, properties);
  const result = validate({ canvas: { width: 100, height: 100 }, nodes: [{ id: "fx", type: "FRAME", w: 40, h: 40, effects: exported as never }] });
  assert.equal(result.valid, true, result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
});

test("effectFromData builds Figma Effect objects for NOISE, TEXTURE, GLASS", () => {
  assert.deepEqual(effectFromData({
    type: "NOISE", noiseType: "DUOTONE", color: { r: 17, g: 34, b: 51, a: 1 }, secondaryColor: { r: 170, g: 187, b: 204, a: 1 },
    noiseSize: 2, density: 0.4, blendMode: "OVERLAY", visible: true
  }), {
    type: "NOISE", noiseType: "DUOTONE", color: { r: 17 / 255, g: 34 / 255, b: 51 / 255, a: 1 },
    secondaryColor: { r: 170 / 255, g: 187 / 255, b: 204 / 255, a: 1 },
    noiseSize: 2, density: 0.4, blendMode: "OVERLAY", visible: true
  });
  assert.deepEqual(effectFromData({ type: "TEXTURE", noiseSize: 3, radius: 1.5, clipToShape: true, visible: true }), {
    type: "TEXTURE", noiseSize: 3, radius: 1.5, clipToShape: true, visible: true
  });
  assert.deepEqual(effectFromData({
    type: "GLASS", lightIntensity: 0.7, lightAngle: -30, refraction: 0.4, depth: 2, dispersion: 0.2, radius: 8, visible: true
  }), {
    type: "GLASS", lightIntensity: 0.7, lightAngle: -30, refraction: 0.4, depth: 2, dispersion: 0.2, radius: 8, visible: true
  });
  assert.equal(effectFromData({ type: "SHADER", visible: true }), null);
  assert.deepEqual(effectFromData({ type: "SHADER", id: "shader-1", visible: false, properties: { "def:amount": 0.5 } }), {
    type: "SHADER", id: "shader-1", visible: false, properties: { "def:amount": 0.5 }
  });
  assert.deepEqual(effectFromData({
    type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.3 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true, showShadowBehindNode: true
  }), {
    type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.3 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true, blendMode: "NORMAL", showShadowBehindNode: true
  });
});

test("effectsFromData imports each SHADER before applying and maps id/properties", async () => {
  clearEffectWarnings();
  const imported: string[] = [];
  const effects = await effectsFromData([
    { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.3 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true },
    { type: "SHADER", id: "shader-1", visible: true, properties: { "def:amount": 0.5, "def:center": { x: 0.5, y: 0.5 } } },
    { type: "SHADER", id: "shader-1", visible: false }
  ], "Card", async (id) => { imported.push(id); return { id, imported: true }; });
  assert.deepEqual(imported, ["shader-1"], "importShaderById should be awaited once per shader id per import run");
  assert.deepEqual(effects.map((effect) => effect.type), ["DROP_SHADOW", "SHADER", "SHADER"]);
  assert.deepEqual(effects[1], { type: "SHADER", id: "shader-1", visible: true, properties: { "def:amount": 0.5, "def:center": { x: 0.5, y: 0.5 } } });
  assert.deepEqual(effects[2], { type: "SHADER", id: "shader-1", visible: false });
  assert.equal(effectWarnings.size, 0);
});

test("effectsFromData skips SHADER effects that fail to import and records a warning", async () => {
  clearEffectWarnings();
  const effects = await effectsFromData([
    { type: "SHADER", id: "missing", visible: true },
    { type: "LAYER_BLUR", radius: 4, visible: true },
    { type: "SHADER", id: "ok", visible: true },
    { type: "SHADER", visible: true }
  ], "Hero", async (id) => {
    if (id === "missing") throw new Error("Shader not found");
    return { id, imported: true };
  });
  assert.deepEqual(effects, [
    { type: "LAYER_BLUR", radius: 4, visible: true },
    { type: "SHADER", id: "ok", visible: true }
  ]);
  const warnings = [...effectWarnings];
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Hero: skipped SHADER 'missing'.*Shader not found/);
  assert.match(warnings[1], /Hero: skipped a SHADER effect without an id/);
  clearEffectWarnings();
  assert.equal(effectWarnings.size, 0);
});
