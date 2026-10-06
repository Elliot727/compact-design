import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isVariableModeLimitError, variableModeLimitWarning } from "../src/plugin/mode-limit";
import { authoredComponentPropertyName, compactEffects, compactLayoutGrids, compactOverflow, compactStrokeAppearance, compactTextTypography, exportCanvasId, exportSelection, uniqueExportIds } from "../src/plugin/exporter";
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
import { applyPatch as applyCorePatch, normalize, normalizePatch, PATCH_SET_KEYS, PATCH_SET_SEMANTICS, validate, validatePatch, type InternalDocument, type InternalNode, type InternalPatchDocument, type PatchSetKey } from "@compact-design/core";
import { applyPatch as applyFigmaPatch, FIGMA_SET_ENTRIES } from "../src/plugin/patch";
import { createNode } from "../src/plugin/nodes";
import { effectsFromData, paints } from "../src/plugin/paints";

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


// --- Patch insert/move: mocked Figma API parity with core -----------------

type MockNode = {
  id: string;
  name: string;
  type: string;
  parent: MockNode | null;
  children: MockNode[];
  removed: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  fills: unknown;
  strokes: unknown[];
  effects: unknown[];
  pluginData: Record<string, string>;
  resize: (w: number, h: number) => void;
  appendChild: (child: MockNode) => void;
  insertChild: (index: number, child: MockNode) => void;
  remove: () => void;
  clone: () => MockNode;
  getPluginData: (key: string) => string;
  setPluginData: (key: string, value: string) => void;
  [key: string]: unknown;
};

const MIXED = Symbol("mixed");
const FRAME_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"]);
const NO_SCENE_PROPS = new Set(["PAGE"]);

function typeDefaults(type: string): Record<string, unknown> {
  if (NO_SCENE_PROPS.has(type)) return {};
  const base: Record<string, unknown> = { opacity: 1, blendMode: "PASS_THROUGH", visible: true, locked: false, isMask: false, boundVariables: {} };
  if (type === "GROUP" || type === "BOOLEAN_OPERATION") return { ...base, layoutAlign: "INHERIT", layoutGrow: 0, layoutPositioning: "AUTO", ...(type === "BOOLEAN_OPERATION" ? { booleanOperation: "UNION", strokeWeight: 1, strokeAlign: "CENTER", strokeJoin: "MITER", dashPattern: [], constraints: { horizontal: "MIN", vertical: "MIN" } } : {}) };
  Object.assign(base, {
    strokeWeight: 1, strokeAlign: "INSIDE", strokeJoin: "MITER", dashPattern: [],
    constraints: { horizontal: "MIN", vertical: "MIN" }, layoutAlign: "INHERIT", layoutGrow: 0, layoutPositioning: "AUTO",
    layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED", minWidth: null, maxWidth: null, minHeight: null, maxHeight: null
  });
  if (FRAME_TYPES.has(type) || type === "RECTANGLE") Object.assign(base, { cornerRadius: 0, topLeftRadius: 0, topRightRadius: 0, bottomRightRadius: 0, bottomLeftRadius: 0, strokeTopWeight: 1, strokeRightWeight: 1, strokeBottomWeight: 1, strokeLeftWeight: 1 });
  if (FRAME_TYPES.has(type)) Object.assign(base, {
    layoutMode: "NONE", itemSpacing: 0, counterAxisSpacing: 0, paddingLeft: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0,
    primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", layoutWrap: "NO_WRAP",
    clipsContent: true, layoutGrids: [], overflowDirection: "NONE", numberOfFixedChildren: 0,
    setExplicitVariableModeForCollection(this: MockNode, collection: { name: string }, modeId: string) { (this.explicitModes as Record<string, string>)[collection.name] = modeId; },
    explicitModes: {},
    componentPropertyReferences: null as { characters?: string; visible?: string; mainComponent?: string } | null
  });
  if (type === "COMPONENT") Object.assign(base, {
    componentPropertyDefinitions: {} as Record<string, { type: string; defaultValue: string | boolean; preferredValues?: unknown[] }>,
    _propSeq: 0,
    addComponentProperty(this: MockNode, name: string, propertyType: string, defaultValue: string | boolean, options: { preferredValues?: unknown[] } = {}) {
      const key = `${name}#${this._propSeq}:0`;
      this._propSeq = Number(this._propSeq) + 1;
      const definitions = this.componentPropertyDefinitions as Record<string, { type: string; defaultValue: string | boolean; preferredValues?: unknown[] }>;
      definitions[key] = { type: propertyType, defaultValue, ...(options.preferredValues ? { preferredValues: options.preferredValues } : {}) };
      return key;
    },
    createInstance(this: MockNode) {
      const main = this;
      const instance = createMockNode("INSTANCE", this.name);
      for (const child of this.children) instance.appendChild(child.clone());
      // Store the main component id (not a live object) so clone() stays acyclic; resolve via figma.getNodeByIdAsync.
      instance.mainComponentId = this.id;
      const definitions = this.componentPropertyDefinitions as Record<string, { type: string; defaultValue: string | boolean }>;
      instance.componentProperties = Object.fromEntries(Object.entries(definitions).map(([key, def]) => [key, { type: def.type, value: def.defaultValue }]));
      instance.getMainComponentAsync = async () => {
        const api = (globalThis as { figma?: { getNodeByIdAsync?: (id: string) => Promise<MockNode | null> } }).figma;
        if (api?.getNodeByIdAsync) return api.getNodeByIdAsync(String(instance.mainComponentId));
        return main;
      };
      instance.setProperties = (overrides: Record<string, string | boolean>) => {
        const props = instance.componentProperties as Record<string, { type: string; value: string | boolean }>;
        for (const [key, value] of Object.entries(overrides)) {
          if (props[key]) props[key] = { ...props[key], value };
          else props[key] = { type: typeof value === "boolean" ? "BOOLEAN" : "TEXT", value };
        }
        const applyOverrides = (mainChild: MockNode, instanceChild: MockNode) => {
          const refs = mainChild.componentPropertyReferences as { characters?: string; visible?: string; mainComponent?: string } | null;
          if (refs) {
            if (refs.characters && typeof props[refs.characters]?.value === "string") instanceChild.characters = props[refs.characters].value;
            if (refs.visible && typeof props[refs.visible]?.value === "boolean") instanceChild.visible = props[refs.visible].value;
            if (refs.mainComponent && typeof props[refs.mainComponent]?.value === "string") instanceChild.swappedComponentId = props[refs.mainComponent].value;
          }
          for (let i = 0; i < mainChild.children.length; i++) {
            if (instanceChild.children[i]) applyOverrides(mainChild.children[i], instanceChild.children[i]);
          }
        };
        for (let i = 0; i < main.children.length; i++) {
          if (instance.children[i]) applyOverrides(main.children[i], instance.children[i]);
        }
      };
      const copyRefs = (mainChild: MockNode, instanceChild: MockNode) => {
        instanceChild.componentPropertyReferences = mainChild.componentPropertyReferences
          ? { ...(mainChild.componentPropertyReferences as object) }
          : null;
        for (let i = 0; i < mainChild.children.length; i++) {
          if (instanceChild.children[i]) copyRefs(mainChild.children[i], instanceChild.children[i]);
        }
      };
      for (let i = 0; i < main.children.length; i++) {
        if (instance.children[i]) copyRefs(main.children[i], instance.children[i]);
      }
      return instance;
    }
  });
  if (type === "INSTANCE") Object.assign(base, {
    componentProperties: {} as Record<string, { type: string; value: string | boolean }>,
    getMainComponentAsync: async () => null as MockNode | null,
    setProperties(this: MockNode, overrides: Record<string, string | boolean>) {
      const props = this.componentProperties as Record<string, { type: string; value: string | boolean }>;
      for (const [key, value] of Object.entries(overrides)) {
        if (props[key]) props[key] = { ...props[key], value };
        else props[key] = { type: typeof value === "boolean" ? "BOOLEAN" : "TEXT", value };
      }
    }
  });
  // Non-frame nodes also need the refs field for TEXT/RECTANGLE/etc. children of components.
  if (!FRAME_TYPES.has(type) && !NO_SCENE_PROPS.has(type)) {
    base.componentPropertyReferences = null;
  }
  if (["POLYGON", "STAR"].includes(type)) Object.assign(base, { pointCount: 5, cornerRadius: 0 });
  if (type === "STAR") base.innerRadius = 0.5;
  if (type === "ELLIPSE") Object.assign(base, { arcData: { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0 }, strokeCap: "NONE" });
  if (type === "LINE" || type === "VECTOR") Object.assign(base, { strokeCap: "NONE" });
  if (type === "VECTOR") Object.assign(base, { vectorPaths: [], cornerRadius: 0 });
  if (type === "TEXT") Object.assign(base, {
    characters: "", fontName: { family: "Inter", style: "Regular" }, fontSize: 12, lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PERCENT", value: 0 },
    textDecoration: "NONE", textCase: "ORIGINAL", paragraphSpacing: 0, paragraphIndent: 0, listSpacing: 0, hangingPunctuation: false, hangingList: false,
    textAlignHorizontal: "LEFT", textAlignVertical: "TOP", textAutoResize: "NONE", textTruncation: "DISABLED", maxLines: null, hyperlink: null, textStyleId: "",
    rangeFonts: [] as Array<{ start: number; end: number; font: { family: string; style: string } }>,
    getRangeAllFontNames(this: MockNode) {
      const fonts = this.fontName === MIXED ? (this.rangeFonts as Array<{ font: { family: string; style: string } }>).map((range) => range.font) : [this.fontName as { family: string; style: string }];
      return [...new Map(fonts.map((font) => [`${font.family}/${font.style}`, font])).values()];
    },
    setRangeFontName(this: MockNode, start: number, end: number, font: { family: string; style: string }) {
      const current = this.fontName as { family: string; style: string } | symbol;
      const whole = start === 0 && end >= String(this.characters).length;
      if (whole) { this.fontName = font; this.rangeFonts = []; return; }
      if (current !== MIXED && typeof current === "object" && current.family === font.family && current.style === font.style) return;
      this.rangeFonts = [...(current !== MIXED ? [{ start: 0, end: String(this.characters).length, font: current }] : this.rangeFonts as unknown[]), { start, end, font }];
      this.fontName = MIXED;
    },
    setRangeFontSize(this: MockNode, start: number, end: number, size: number) { if (start === 0 && end >= String(this.characters).length) this.fontSize = size; else if (size !== this.fontSize) this.fontSize = MIXED; },
    setRangeFills(this: MockNode, start: number, end: number, fills: unknown[]) { this.fills = start === 0 && end >= String(this.characters).length ? fills : MIXED; },
    setRangeTextDecoration(this: MockNode, _start: number, _end: number, value: string) { if (value !== this.textDecoration) this.textDecoration = MIXED; },
    setRangeLetterSpacing(this: MockNode) { this.letterSpacing = MIXED; },
    setRangeHyperlink(this: MockNode) { this.hyperlink = MIXED; }
  });
  base.setBoundVariable = function (this: MockNode, field: string, variable: { id: string }) { (this.boundVariables as Record<string, unknown>)[field] = { type: "VARIABLE_ALIAS", id: variable.id }; };
  return base;
}

function cloneMockValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneMockValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneMockValue(item)]));
  return value;
}

function createMockNode(type: string, name = type): MockNode {
  const node: MockNode = {
    ...typeDefaults(type),
    id: `figma:${Math.random().toString(36).slice(2, 9)}`,
    name,
    type,
    parent: null,
    children: [],
    removed: false,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    fills: [],
    strokes: [],
    effects: [],
    pluginData: {},
    resize(w: number, h: number) { this.width = w; this.height = h; },
    appendChild(child: MockNode) { this.insertChild(this.children.length, child); },
    insertChild(index: number, child: MockNode) {
      if (child.parent) {
        const from = child.parent.children.indexOf(child);
        if (from >= 0) child.parent.children.splice(from, 1);
      }
      child.parent = this;
      const at = Math.max(0, Math.min(index, this.children.length));
      this.children.splice(at, 0, child);
    },
    remove() {
      if (this.parent) {
        const from = this.parent.children.indexOf(this);
        if (from >= 0) this.parent.children.splice(from, 1);
      }
      this.parent = null;
      this.removed = true;
    },
    clone() {
      // Like Figma: a full copy of properties, plugin data, and the subtree.
      const copy = createMockNode(this.type, this.name);
      for (const [key, value] of Object.entries(this)) {
        if (["id", "parent", "children", "removed"].includes(key) || typeof value === "function") continue;
        copy[key] = cloneMockValue(value);
      }
      if (this.type === "INSTANCE" && copy.mainComponentId) {
        copy.getMainComponentAsync = async () => {
          const api = (globalThis as { figma?: { getNodeByIdAsync?: (id: string) => Promise<MockNode | null> } }).figma;
          return api?.getNodeByIdAsync ? api.getNodeByIdAsync(String(copy.mainComponentId)) : null;
        };
      }
      for (const child of this.children) copy.appendChild(child.clone());
      return copy;
    },
    getPluginData(key: string) { return this.pluginData[key] || ""; },
    setPluginData(key: string, value: string) { this.pluginData[key] = value; }
  };
  return node;
}

function emptyPatchContext() {
  return {
    sourceNodes: new Map(),
    componentPropertyKeys: new Map(),
    resources: {
      paintStyles: new Map(),
      textStyles: new Map(),
      variables: new Map(),
      variableCollections: new Map(),
      createdStyles: [],
      createdCollections: [],
      warnings: [],
      unavailableVariableModes: new Map()
    },
    createdNodes: [] as MockNode[]
  };
}

const loadedFonts: string[] = [];

function installFigmaMock(pageChildren: MockNode[]) {
  const page = createMockNode("PAGE", "Page 1");
  page.children = pageChildren;
  for (const child of pageChildren) child.parent = page;

  const findAll = (): MockNode[] => {
    const out: MockNode[] = [];
    const walk = (nodes: MockNode[]) => {
      for (const node of nodes) {
        if (node.removed) continue;
        out.push(node);
        walk(node.children);
      }
    };
    walk(page.children);
    return out;
  };

  const figmaMock = {
    mixed: MIXED,
    currentPage: Object.assign(page, { findAll, selection: [] as MockNode[] }),
    getNodeByIdAsync: async (id: string) => findAll().find((node) => node.id === id) || null,
    createFrame: () => createMockNode("FRAME"),
    createRectangle: () => createMockNode("RECTANGLE"),
    createEllipse: () => createMockNode("ELLIPSE"),
    createLine: () => createMockNode("LINE"),
    createPolygon: () => createMockNode("POLYGON"),
    createStar: () => createMockNode("STAR"),
    createSection: () => createMockNode("SECTION"),
    createSlice: () => createMockNode("SLICE"),
    createVector: () => createMockNode("VECTOR"),
    createText: () => createMockNode("TEXT"),
    createComponent: () => createMockNode("COMPONENT"),
    loadFontAsync: async (font: { family: string; style: string }) => {
      loadedFonts.push(`${font.family} ${font.style}`);
      if (font.family === "Missing Font") throw new Error("font not found");
    },
    variables: {
      setBoundVariableForPaint: (paint: Record<string, unknown>, field: string, variable: { id: string }) => ({ ...paint, boundVariables: { [field]: { type: "VARIABLE_ALIAS", id: variable.id } } })
    },
    createImage: () => ({ hash: "img" }),
    createImageAsync: async () => ({ hash: "img" })
  };
  (globalThis as { figma?: unknown }).figma = figmaMock;
  return { page, figmaMock };
}

function compactIds(parent: MockNode): string[] {
  return parent.children.map((child) => child.getPluginData("compactDesignId"));
}

test("Figma patch insert clamps and seats at the requested index", async () => {
  const list = createMockNode("FRAME", "list");
  list.setPluginData("compactDesignId", "list");
  for (const id of ["a", "b", "c"]) {
    const child = createMockNode("RECTANGLE", id);
    child.setPluginData("compactDesignId", id);
    list.appendChild(child);
  }
  installFigmaMock([list]);
  const context = emptyPatchContext();
  await applyFigmaPatch(normalizePatch({
    patch: { operations: [{ op: "insert", parent: "list", index: 1, node: { id: "mid", type: "RECTANGLE", w: 10, h: 10 } }] }
  }), context as never);
  assert.deepEqual(compactIds(list), ["a", "mid", "b", "c"]);

  await applyFigmaPatch(normalizePatch({
    patch: { operations: [{ op: "insert", parent: "list", index: 99, node: { id: "tail", type: "RECTANGLE", w: 10, h: 10 } }] }
  }), context as never);
  assert.deepEqual(compactIds(list), ["a", "mid", "b", "c", "tail"]);
});

test("Figma patch move uses after-removal index and rejects cycles, roots, instances, and missing ids", async () => {
  const canvas = createMockNode("FRAME", "canvas");
  canvas.setPluginData("compactDesignId", "canvas");
  const list = createMockNode("FRAME", "list");
  list.setPluginData("compactDesignId", "list");
  canvas.appendChild(list);
  for (const id of ["a", "b", "c", "d"]) {
    const child = createMockNode("RECTANGLE", id);
    child.setPluginData("compactDesignId", id);
    list.appendChild(child);
  }
  const nest = createMockNode("FRAME", "nest");
  nest.setPluginData("compactDesignId", "nest");
  list.appendChild(nest);
  const instance = createMockNode("INSTANCE", "copy");
  instance.setPluginData("compactDesignId", "copy");
  canvas.appendChild(instance);
  installFigmaMock([canvas]);

  const context = emptyPatchContext();

  await applyFigmaPatch(normalizePatch({
    patch: { operations: [{ op: "move", id: "b", parent: "list", index: 2 }] }
  }), context as never);
  assert.deepEqual(compactIds(list), ["a", "c", "b", "d", "nest"]);

  await assert.rejects(
    () => applyFigmaPatch(normalizePatch({ patch: { operations: [{ op: "move", id: "a", parent: "list-missing", index: 0 }] } }), context as never),
    /was not found/
  );
  await assert.rejects(
    () => applyFigmaPatch(normalizePatch({ patch: { operations: [{ op: "move", id: "ghost", parent: "list", index: 0 }] } }), context as never),
    /was not found/
  );
  await assert.rejects(
    () => applyFigmaPatch(normalizePatch({ patch: { operations: [{ op: "move", id: "canvas", parent: "list", index: 0 }] } }), context as never),
    /document root/
  );
  await assert.rejects(
    () => applyFigmaPatch(normalizePatch({ patch: { operations: [{ op: "insert", parent: "copy", index: 0, node: { id: "x", type: "RECTANGLE", w: 1, h: 1 } }] } }), context as never),
    /INSTANCE/
  );
  await assert.rejects(
    () => applyFigmaPatch(normalizePatch({ patch: { operations: [{ op: "move", id: "list", parent: "a", index: 0 }] } }), context as never),
    /cannot contain children/
  );
  await assert.rejects(
    () => applyFigmaPatch(normalizePatch({ patch: { operations: [{ op: "move", id: "list", parent: "nest", index: 0 }] } }), context as never),
    /itself or its descendants/
  );

  // Nested child inside INSTANCE cannot be moved out.
  const slot = createMockNode("FRAME", "slot");
  slot.setPluginData("compactDesignId", "slot");
  instance.appendChild(slot);
  await assert.rejects(
    () => applyFigmaPatch(normalizePatch({ patch: { operations: [{ op: "move", id: "slot", parent: "list", index: 0 }] } }), context as never),
    /inside an INSTANCE and cannot be moved/
  );
});

test("core and Figma applicator agree on insert/move/reparent/append child order", async () => {
  const source = {
    canvas: { id: "screen", width: 300, height: 200 },
    nodes: [{
      id: "list",
      type: "FRAME",
      w: 200,
      h: 100,
      children: [
        { id: "a", type: "RECTANGLE", w: 10, h: 10 },
        { id: "b", type: "RECTANGLE", w: 10, h: 10 },
        { id: "c", type: "RECTANGLE", w: 10, h: 10 }
      ]
    }, {
      id: "other",
      type: "FRAME",
      w: 100,
      h: 100,
      children: [{ id: "z", type: "RECTANGLE", w: 10, h: 10 }]
    }]
  };
  const operations = [
    { op: "insert", parent: "list", index: 1, node: { id: "mid", type: "RECTANGLE", w: 10, h: 10 } },
    { op: "move", id: "c", parent: "list", index: 0 },
    { op: "move", id: "a", parent: "other", index: 0 },
    { op: "append", parent: "list", node: { id: "tail", type: "RECTANGLE", w: 10, h: 10 } }
  ];
  const coreDoc = normalize(source);
  const coreResult = applyCorePatch(coreDoc, normalizePatch({ patch: { operations } }));
  const idsUnder = (root: typeof coreDoc, id: string): string[] => {
    const visit = (nodes: typeof root.nodes): string[] | null => {
      for (const node of nodes) {
        if (node.id === id) return node.children.map((child) => child.id);
        const nested = visit(node.children);
        if (nested) return nested;
      }
      return null;
    };
    return visit(root.nodes) || [];
  };
  const coreList = idsUnder(coreResult.document, "list");
  const coreOther = idsUnder(coreResult.document, "other");

  const screen = createMockNode("FRAME", "screen");
  screen.setPluginData("compactDesignId", "screen");
  const list = createMockNode("FRAME", "list");
  list.setPluginData("compactDesignId", "list");
  const other = createMockNode("FRAME", "other");
  other.setPluginData("compactDesignId", "other");
  screen.appendChild(list);
  screen.appendChild(other);
  for (const id of ["a", "b", "c"]) {
    const child = createMockNode("RECTANGLE", id);
    child.setPluginData("compactDesignId", id);
    list.appendChild(child);
  }
  const z = createMockNode("RECTANGLE", "z");
  z.setPluginData("compactDesignId", "z");
  other.appendChild(z);
  installFigmaMock([screen]);

  await applyFigmaPatch(normalizePatch({ patch: { operations } }), emptyPatchContext() as never);

  assert.deepEqual(compactIds(list), coreList);
  assert.deepEqual(compactIds(other), coreOther);
  assert.deepEqual(coreList, ["c", "mid", "b", "tail"]);
  assert.deepEqual(coreOther, ["a", "z"]);
});


test("Figma patch rejects arbitrary non-imported Figma node ids", async () => {
  const list = createMockNode("FRAME", "list");
  list.setPluginData("compactDesignId", "list");
  const orphan = createMockNode("RECTANGLE", "orphan");
  // orphan has a Figma id but no compactDesignId — not in the plugin index
  list.appendChild(orphan);
  installFigmaMock([list]);

  await assert.rejects(
    () => applyFigmaPatch(normalizePatch({
      patch: { operations: [{ op: "set", id: orphan.id, set: { name: "hijacked" } }] }
    }), emptyPatchContext() as never),
    /was not found/
  );
  await assert.rejects(
    () => applyFigmaPatch(normalizePatch({
      patch: { operations: [{ op: "move", id: orphan.id, parent: "list", index: 0 }] }
    }), emptyPatchContext() as never),
    /was not found/
  );
  assert.equal(orphan.getPluginData("compactDesignId"), "");
  assert.equal(list.children.includes(orphan), true);
});

test("Figma patch rolls back insert and move when a later op fails", async () => {
  const list = createMockNode("FRAME", "list");
  list.setPluginData("compactDesignId", "list");
  for (const id of ["a", "b", "c"]) {
    const child = createMockNode("RECTANGLE", id);
    child.setPluginData("compactDesignId", id);
    list.appendChild(child);
  }
  const other = createMockNode("FRAME", "other");
  other.setPluginData("compactDesignId", "other");
  installFigmaMock([list, other]);

  const snapshot = () => ({
    list: compactIds(list).slice(),
    other: compactIds(other).slice(),
    listLen: list.children.length,
    otherLen: other.children.length
  });
  const before = snapshot();

  // Preflight passes (all ids exist / parents valid). The third op fails mid-apply
  // inside createNode, so insert + move must roll back.
  await assert.rejects(
    () => applyFigmaPatch(normalizePatch({
      patch: {
        operations: [
          { op: "insert", parent: "list", index: 1, node: { id: "mid", type: "RECTANGLE", w: 10, h: 10 } },
          { op: "move", id: "c", parent: "other", index: 0 },
          { op: "insert", parent: "list", index: 0, node: { id: "boom", type: "NOT_A_NODE", w: 10, h: 10 } }
        ]
      }
    }), emptyPatchContext() as never),
    /Unsupported node type/
  );

  assert.deepEqual(snapshot(), before, "tree must be unchanged after failed patch");
  assert.equal(list.children.some((child) => child.getPluginData("compactDesignId") === "mid"), false);
  assert.equal(other.children.some((child) => child.getPluginData("compactDesignId") === "c"), false);
  assert.deepEqual(compactIds(list), ["a", "b", "c"]);
});

test("Figma append uses the same parent validation as insert", async () => {
  const list = createMockNode("FRAME", "list");
  list.setPluginData("compactDesignId", "list");
  const leaf = createMockNode("RECTANGLE", "leaf");
  leaf.setPluginData("compactDesignId", "leaf");
  list.appendChild(leaf);
  const instance = createMockNode("INSTANCE", "copy");
  instance.setPluginData("compactDesignId", "copy");
  installFigmaMock([list, instance]);
  const context = emptyPatchContext();

  for (const op of ["append", "insert"] as const) {
    const missing = { op, parent: "nope", ...(op === "insert" ? { index: 0 } : {}), node: { id: `x-${op}`, type: "RECTANGLE", w: 1, h: 1 } };
    await assert.rejects(() => applyFigmaPatch(normalizePatch({ patch: { operations: [missing] } }), context as never), /was not found/);
    const intoLeaf = { op, parent: "leaf", ...(op === "insert" ? { index: 0 } : {}), node: { id: `y-${op}`, type: "RECTANGLE", w: 1, h: 1 } };
    await assert.rejects(() => applyFigmaPatch(normalizePatch({ patch: { operations: [intoLeaf] } }), context as never), /cannot contain children/);
    const intoInstance = { op, parent: "copy", ...(op === "insert" ? { index: 0 } : {}), node: { id: `z-${op}`, type: "RECTANGLE", w: 1, h: 1 } };
    await assert.rejects(() => applyFigmaPatch(normalizePatch({ patch: { operations: [intoInstance] } }), context as never), /INSTANCE/);
  }
});


// --- Typed, merging patch set: Figma applicator (PR1) ------------------------

function importContext(variables = new Map<string, { id: string }>(), collections = new Map<string, unknown>()) {
  return {
    sourceNodes: new Map(),
    componentPropertyKeys: new Map(),
    resources: { paintStyles: new Map(), textStyles: new Map(), variables, variableCollections: collections, createdStyles: [], createdCollections: [], warnings: [], unavailableVariableModes: new Map() },
    createdNodes: [] as MockNode[]
  };
}

/** Import a core document into the mocked scene through the real plugin createNode. */
async function importIntoMock(document: InternalDocument, context = importContext()): Promise<MockNode> {
  const { page } = installFigmaMock([]);
  for (const root of document.nodes) await createNode(root, page as never, { x: 0, y: 0 }, context as never);
  return page;
}

function mockById(page: MockNode, id: string): MockNode {
  const visit = (nodes: MockNode[]): MockNode | null => {
    for (const node of nodes) {
      if (node.getPluginData("compactDesignId") === id) return node;
      const found = visit(node.children);
      if (found) return found;
    }
    return null;
  };
  const found = visit(page.children);
  assert.ok(found, `mock node ${id}`);
  return found;
}

type ComparableState = Record<string, unknown>;
const effectSummary = (effects: unknown) => (Array.isArray(effects) ? effects : []).map((effect) => {
  const value = effect as { type: string; radius?: number; offset?: { x: number; y: number } };
  return { type: value.type, radius: value.radius, offset: value.offset };
});

async function figmaState(page: MockNode): Promise<Record<string, ComparableState>> {
  const result: Record<string, ComparableState> = {};
  const visit = (node: MockNode) => {
    const id = node.getPluginData("compactDesignId");
    if (id) {
      const fillList = Array.isArray(node.fills) ? node.fills as Array<Record<string, unknown>> : [];
      const fills = Array.isArray(node.fills) ? fillList.map(({ boundVariables: _bound, ...paint }) => paint) : node.fills;
      const state: ComparableState = { name: node.name, x: node.x, y: node.y, w: node.width, h: node.height, opacity: node.opacity, fills, fillBound: Boolean(fillList[0]?.boundVariables), strokes: node.strokes, effects: effectSummary(node.effects), constraints: node.constraints, children: node.children.map((child) => child.getPluginData("compactDesignId")) };
      if ("cornerRadius" in node) state.cornerRadius = node.cornerRadius;
      if (FRAME_TYPES.has(node.type)) {
        state.layoutMode = node.layoutMode;
        if (node.layoutMode !== "NONE") state.layout = { itemSpacing: node.itemSpacing, padding: [node.paddingLeft, node.paddingTop, node.paddingRight, node.paddingBottom], primary: node.primaryAxisAlignItems, counter: node.counterAxisAlignItems, primarySizing: node.primaryAxisSizingMode, counterSizing: node.counterAxisSizingMode };
      }
      if (node.type === "TEXT") state.text = { characters: node.characters, fontName: node.fontName, fontSize: node.fontSize, lineHeight: node.lineHeight, align: node.textAlignHorizontal, letterSpacing: node.letterSpacing, textCase: node.textCase };
      result[id] = state;
    }
    node.children.forEach(visit);
  };
  page.children.forEach(visit);
  return result;
}

async function coreState(document: InternalDocument): Promise<Record<string, ComparableState>> {
  const result: Record<string, ComparableState> = {};
  const sizing = (value: string | undefined) => value === "HUG" || value === "AUTO" ? "AUTO" : "FIXED";
  const visit = async (node: InternalNode, parent: InternalNode | null) => {
    const p = node.properties;
    const origin = parent ? parent.properties.position : { x: 0, y: 0 };
    const state: ComparableState = { name: node.name, x: p.position.x - origin.x, y: p.position.y - origin.y, w: p.size.width, h: p.size.height, opacity: p.opacity ?? 1, fills: await paints(p.styles.fills), fillBound: Boolean(p.bindings?.fill), strokes: await paints(p.styles.strokes), effects: effectSummary(await effectsFromData(p.styles.effects)), constraints: p.constraints ?? { horizontal: "MIN", vertical: "MIN" }, children: node.children.map((child) => child.id) };
    if (["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "RECTANGLE"].includes(node.type)) state.cornerRadius = p.cornerRadius ?? 0;
    if (["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(node.type)) {
      state.layoutMode = p.layout?.direction ?? "NONE";
      if (p.layout?.direction) state.layout = { itemSpacing: p.layout.itemSpacing ?? 0, padding: [p.layout.padding?.left ?? 0, p.layout.padding?.top ?? 0, p.layout.padding?.right ?? 0, p.layout.padding?.bottom ?? 0], primary: p.layout.primaryAxisAlignItems ?? "MIN", counter: p.layout.counterAxisAlignItems ?? "MIN", primarySizing: sizing(p.layout.primaryAxisSizingMode), counterSizing: sizing(p.layout.counterAxisSizingMode) };
    }
    if (node.type === "TEXT") {
      const lineHeight = p.lineHeight?.unit === "PERCENT" || p.lineHeight?.unit === "PIXELS" ? { unit: p.lineHeight.unit, value: p.lineHeight.value } : { unit: "AUTO" };
      state.text = { characters: p.text, fontName: { family: p.font?.family, style: p.font?.style }, fontSize: p.font?.size, lineHeight, align: p.alignment ?? "LEFT", letterSpacing: p.letterSpacing ?? { unit: "PERCENT", value: 0 }, textCase: p.textCase ?? "ORIGINAL" };
    }
    result[node.id] = state;
    for (const child of node.children) await visit(child, node);
  };
  for (const root of document.nodes) await visit(root, null);
  return result;
}

const parityDocument = () => normalize({
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
    { id: "card", type: "RECTANGLE", x: 400, y: 10, w: 100, h: 100, effects: [{ type: "DROP_SHADOW", color: "#00000033", offset: { x: 0, y: 4 }, blur: 8 }, { type: "LAYER_BLUR", blur: 4 }] }
  ]
});

const setOp = (id: string, set: Record<string, unknown>) => ({ op: "set", id, set });
const checkedPatch = (...operations: unknown[]): InternalPatchDocument => {
  const result = validate({ patch: { operations } });
  assert.equal(result.valid, true, result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  return result.patch!;
};

async function assertParity(document: InternalDocument, steps: unknown[][]): Promise<InternalDocument> {
  const page = await importIntoMock(document);
  assert.deepEqual(await figmaState(page), await coreState(document), "import parity before patching");
  let current = document;
  for (const [index, operations] of steps.entries()) {
    const patch = checkedPatch(...operations);
    current = applyCorePatch(current, patch).document;
    await applyFigmaPatch(patch, emptyPatchContext() as never);
    assert.deepEqual(await figmaState(page), await coreState(current), `step ${index}: ${JSON.stringify(operations)}`);
  }
  return current;
}

test("FIGMA_SET_ENTRIES covers exactly the core PATCH_SET_KEYS list", () => {
  assert.deepEqual(Object.keys(FIGMA_SET_ENTRIES).sort(), [...PATCH_SET_KEYS].sort());
  for (const key of PATCH_SET_KEYS) {
    const rejected = FIGMA_SET_ENTRIES[key].phase === "rejected";
    assert.equal(rejected, ["deferred", "immutable"].includes(PATCH_SET_SEMANTICS[key]), key);
  }
});

test("parity: the same set patches give the same result in core and mocked Figma", async () => {
  await assertParity(parityDocument(), [
    [setOp("title", { font: { size: 32 } })],
    [setOp("title", { text: "Changed", align: "CENTER", lineHeight: 1.4, letterSpacing: { unit: "PIXELS", value: 1 }, textCase: "UPPER" })],
    [setOp("stack", { layout: { itemSpacing: 24 } })],
    [setOp("stack", { layout: { padding: { left: 40 }, primaryAxisAlignItems: "MAX" } })],
    [setOp("leaf", { x: 20 })],
    [setOp("inner", { x: 0, y: 0, w: 320 })],
    [setOp("leaf", { constraints: { horizontal: "CENTER" }, fill: "#0000FF", cornerRadius: 6, opacity: 0.5 })],
    [setOp("card", { shadow: { y: 2, blur: 6 } })],
    [setOp("card", { effects: [] })],
    [setOp("outer", { layout: { direction: "VERTICAL", itemSpacing: 12 } })],
    [setOp("chip", { layoutPositioning: "ABSOLUTE", x: 5, y: 6 })],
    [setOp("title", { font: { family: "Roboto", style: "Medium" } }), setOp("card", { name: "Card", w: 120, h: 80 })]
  ]);
});

test("move from #36 then set x lands in the same place in core and mocked Figma", async () => {
  const final = await assertParity(parityDocument(), [
    [{ op: "move", id: "leaf", parent: "sibling", index: 0 }, setOp("leaf", { x: 7 })],
    [{ op: "move", id: "sibling", parent: "screen", index: 0 }, setOp("sibling", { y: 3 })]
  ]);
  const leaf = final.nodes[0].children.find((node) => node.id === "sibling")!.children[0];
  assert.deepEqual(leaf.properties.position, { x: 200 + 7, y: 3 + 5 }, "sibling keeps its relative (200, _) under screen; leaf x is relative to sibling");
});

test("every settable key applies in Figma or fails explicitly — no silent drops", async () => {
  const sample: Record<PatchSetKey, [string, unknown]> = {
    name: ["rect", "Renamed"], x: ["rect", 5], y: ["rect", 6], w: ["rect", 50], h: ["rect", 60], rotation: ["rect", 15],
    fill: ["rect", "#FF0000"], fills: ["rect", ["#00FF00"]], stroke: ["rect", "#0000FF"], strokes: ["rect", ["#0000FF"]],
    strokeWeight: ["rect", 3], strokeTopWeight: ["rect", 2], strokeRightWeight: ["rect", 2], strokeBottomWeight: ["rect", 2], strokeLeftWeight: ["rect", 2],
    strokeAlign: ["rect", "CENTER"], strokeCap: ["line", "ROUND"], strokeJoin: ["rect", "ROUND"], dashPattern: ["rect", [4, 2]],
    cornerRadius: ["rect", 8], cornerRadii: ["rect", [1, 2, 3, 4]], opacity: ["rect", 0.5], blendMode: ["rect", "MULTIPLY"], visible: ["rect", false], locked: ["rect", true], isMask: ["rect", true], clipsContent: ["frame", false],
    effects: ["rect", [{ type: "LAYER_BLUR", blur: 4 }]], elevation: ["rect", "LOW"], shadow: ["rect", { y: 2 }],
    layout: ["stack", { itemSpacing: 24 }], constraints: ["rect", { horizontal: "CENTER" }],
    layoutSizingHorizontal: ["stackChild", "FILL"], layoutSizingVertical: ["stackText", "HUG"], layoutAlign: ["stackChild", "STRETCH"], layoutGrow: ["stackChild", 1], layoutPositioning: ["stackChild", "ABSOLUTE"],
    minWidth: ["stackChild", 10], maxWidth: ["stackChild", 500], minHeight: ["stackChild", 5], maxHeight: ["stackChild", 400], layoutGrids: ["frame", [{ pattern: "GRID", sectionSize: 8 }]],
    text: ["text", "Changed"], font: ["text", { size: 30 }], lineHeight: ["text", 1.5], letterSpacing: ["text", { unit: "PIXELS", value: 1 }], align: ["text", "CENTER"], verticalAlignment: ["text", "BOTTOM"],
    textDecoration: ["text", "UNDERLINE"], textCase: ["text", "UPPER"], paragraphSpacing: ["text", 4], paragraphIndent: ["text", 2], listSpacing: ["text", 3], hangingPunctuation: ["text", true], hangingList: ["text", true],
    textAutoResize: ["text", "HEIGHT"], textTruncation: ["text", "ENDING"], maxLines: ["text", 2], runs: ["text", [{ text: "Ab" }, { text: "cd", fill: "#FF0000" }]],
    pointCount: ["polygon", 6], innerRadius: ["star", 0.3], startingAngle: ["ellipse", 1], endingAngle: ["ellipse", 2], innerRadiusRatio: ["ellipse", 0.4],
    svg: ["rect", "<svg/>"], vectorPaths: ["vector", [{ windingRule: "NONZERO", data: "M 0,0 L 1,1 Z" }]],
    componentId: ["rect", "c"], componentProperties: ["rect", []], instanceProperties: ["rect", {}], componentPropertyReferences: ["rect", { characters: "Label" }], variantAxes: ["rect", {}], variant: ["rect", {}],
    operation: ["bool", "SUBTRACT"], prototype: ["rect", []], overflowDirection: ["frame", "VERTICAL"], numberOfFixedChildren: ["stack", 1],
    styleRefs: ["rect", { fill: "x" }], bindings: ["rect", { fill: "x" }], variableModes: ["rect", { Theme: "Dark" }]
  };
  assert.deepEqual(Object.keys(sample).sort(), [...PATCH_SET_KEYS].sort());
  const build = () => {
    const make = (type: string, id: string, parent: MockNode) => { const node = createMockNode(type, id); node.setPluginData("compactDesignId", id); parent.appendChild(node); return node; };
    const screen = createMockNode("FRAME", "screen"); screen.setPluginData("compactDesignId", "screen");
    for (const [type, id] of [["RECTANGLE", "rect"], ["LINE", "line"], ["FRAME", "frame"], ["TEXT", "text"], ["POLYGON", "polygon"], ["STAR", "star"], ["ELLIPSE", "ellipse"], ["VECTOR", "vector"]]) make(type, id, screen);
    const stack = make("FRAME", "stack", screen); stack.layoutMode = "HORIZONTAL";
    make("FRAME", "stackChild", stack); const stackText = make("TEXT", "stackText", stack); stackText.characters = "x";
    const bool = make("BOOLEAN_OPERATION", "bool", screen); make("RECTANGLE", "boolChild", bool);
    (mockLookup(screen, "text") as MockNode).characters = "Hello";
    installFigmaMock([screen]);
    return screen;
  };
  const snapshot = (node: MockNode) => JSON.stringify(node, (key, value) => key === "parent" || key === "children" ? undefined : typeof value === "symbol" ? "MIXED" : value);
  for (const key of PATCH_SET_KEYS) {
    const [target, value] = sample[key];
    const screen = build();
    const before = snapshot(mockLookup(screen, target));
    const semantics = PATCH_SET_SEMANTICS[key];
    if (semantics === "deferred" || semantics === "immutable") {
      // Even when handed an un-validated internal patch, Figma rejects explicitly.
      const raw = { patch: { operations: [{ op: "SET", id: target, set: { [key]: value }, normalized: {} }] } } as unknown as InternalPatchDocument;
      await assert.rejects(() => applyFigmaPatch(raw, emptyPatchContext() as never), /cannot be patched/, key);
      assert.equal(snapshot(mockLookup(screen, target)), before, `${key}: rejected set must not change the node`);
      continue;
    }
    await applyFigmaPatch(checkedPatch(setOp(target, { [key]: value })), emptyPatchContext() as never);
    assert.notEqual(snapshot(mockLookup(screen, target)), before, `${key}: set must change the Figma node`);
  }
});

function mockLookup(root: MockNode, id: string): MockNode {
  if (root.getPluginData("compactDesignId") === id) return root;
  for (const child of root.children) { const found = mockLookup(child, id); if (found.getPluginData("compactDesignId") === id) return found; }
  return root.getPluginData("compactDesignId") === id ? root : { getPluginData: () => "" } as unknown as MockNode;
}

test("Figma partial font keeps family/style; figma.mixed fonts are handled explicitly", async () => {
  const page = await importIntoMock(parityDocument());
  const title = mockById(page, "title");
  await applyFigmaPatch(checkedPatch(setOp("title", { font: { size: 32 } })), emptyPatchContext() as never);
  assert.deepEqual(title.fontName, { family: "Inter", style: "Bold" });
  assert.equal(title.fontSize, 32);
  // Mix fonts across ranges, as runs would.
  (title.setRangeFontName as (start: number, end: number, font: unknown) => void)(0, 2, { family: "Roboto", style: "Black" });
  assert.equal(title.fontName, MIXED);
  await applyFigmaPatch(checkedPatch(setOp("title", { font: { size: 18 } })), emptyPatchContext() as never);
  const current = mockById(page, "title");
  assert.equal(current.fontSize, 18, "size alone applies across mixed ranges");
  assert.ok(loadedFonts.includes("Roboto Black") && loadedFonts.includes("Inter Bold"), "every range font is loaded before editing");
  await assert.rejects(() => applyFigmaPatch(checkedPatch(setOp("title", { font: { family: "Roboto" } })), emptyPatchContext() as never), /set font.family and font.style together/);
  await assert.rejects(() => applyFigmaPatch(checkedPatch(setOp("title", { text: "New" })), emptyPatchContext() as never), /per-range text styling/);
  await applyFigmaPatch(checkedPatch(setOp("title", { font: { family: "Roboto", style: "Medium" } })), emptyPatchContext() as never);
  assert.deepEqual(mockById(page, "title").fontName, { family: "Roboto", style: "Medium" });
});

test("Figma set on TEXT does not inject a fill and a missing font fails atomically", async () => {
  const page = await importIntoMock(parityDocument());
  await applyFigmaPatch(checkedPatch(setOp("title", { text: "Still unfilled" })), emptyPatchContext() as never);
  assert.deepEqual(mockById(page, "title").fills, []);
  const before = await figmaState(page);
  await assert.rejects(() => applyFigmaPatch(checkedPatch(setOp("card", { cornerRadius: 30 }), setOp("title", { font: { family: "Missing Font", style: "Regular" } })), emptyPatchContext() as never), /Missing Font Regular' is not available/);
  assert.deepEqual(await figmaState(page), before, "earlier set in the same patch is rolled back");
});

test("Figma partial layout: error without direction on a plain frame, merge on Auto Layout", async () => {
  const page = await importIntoMock(parityDocument());
  await assert.rejects(() => applyFigmaPatch(checkedPatch(setOp("outer", { layout: { itemSpacing: 4 } })), emptyPatchContext() as never), /no Auto Layout yet/);
  assert.equal(mockById(page, "outer").layoutMode, "NONE");
  await applyFigmaPatch(checkedPatch(setOp("stack", { layout: { itemSpacing: 24 } })), emptyPatchContext() as never);
  const stack = mockById(page, "stack");
  assert.deepEqual([stack.layoutMode, stack.itemSpacing, stack.paddingLeft, stack.paddingTop, stack.primaryAxisAlignItems], ["HORIZONTAL", 24, 16, 12, "CENTER"]);
  await applyFigmaPatch(checkedPatch(setOp("stack", { layout: { direction: "VERTICAL" } })), emptyPatchContext() as never);
  assert.deepEqual([mockById(page, "stack").layoutMode, mockById(page, "stack").paddingLeft, mockById(page, "stack").itemSpacing], ["VERTICAL", 16, 24], "direction change keeps padding and spacing");
});

test("Figma effects/shadow replace the effect list", async () => {
  const page = await importIntoMock(parityDocument());
  assert.equal((mockById(page, "card").effects as unknown[]).length, 2);
  await applyFigmaPatch(checkedPatch(setOp("card", { shadow: { y: 2 } })), emptyPatchContext() as never);
  assert.deepEqual(effectSummary(mockById(page, "card").effects).map((effect) => effect.type), ["DROP_SHADOW"]);
});

test("set on a node inserted in the same patch: Figma preflight rejects it and changes nothing", async () => {
  const page = await importIntoMock(parityDocument());
  const before = await figmaState(page);
  await assert.rejects(() => applyFigmaPatch(checkedPatch({ op: "append", parent: "sibling", node: { id: "fresh", type: "RECTANGLE", w: 5, h: 5 } }, setOp("fresh", { w: 9 })), emptyPatchContext() as never), /node 'fresh' was not found/);
  assert.deepEqual(await figmaState(page), before);
});

test("Figma rolls back sets and moves when a later set breaks a rule", async () => {
  const page = await importIntoMock(parityDocument());
  const before = await figmaState(page);
  await assert.rejects(() => applyFigmaPatch(checkedPatch(
    setOp("stack", { layout: { itemSpacing: 99 } }),
    { op: "move", id: "leaf", parent: "sibling", index: 0 },
    setOp("leaf", { x: 40 }),
    setOp("card", { text: "not a text node" })
  ), emptyPatchContext() as never), /'text' does not apply to RECTANGLE/);
  assert.deepEqual(await figmaState(page), before);
});

test("Figma rollback restores nested set/insert/remove sequences without stray backups", async () => {
  const page = await importIntoMock(parityDocument());
  const before = await figmaState(page);
  const countIds = () => { const ids: string[] = []; const visit = (node: MockNode) => { const id = node.getPluginData("compactDesignId"); if (id) ids.push(id); node.children.forEach(visit); }; page.children.forEach(visit); return ids.sort(); };
  const idsBefore = countIds();
  await assert.rejects(() => applyFigmaPatch(checkedPatch(
    setOp("leaf", { fill: "#123456" }),
    { op: "insert", parent: "inner", index: 0, node: { id: "added", type: "RECTANGLE", w: 3, h: 3 } },
    setOp("inner", { cornerRadius: 9 }),
    setOp("outer", { name: "Outer renamed" }),
    { op: "remove", id: "sibling" },
    setOp("title", { font: { family: "Missing Font", style: "Bold" } })
  ), emptyPatchContext() as never), /not available/);
  assert.deepEqual(await figmaState(page), before);
  assert.deepEqual(countIds(), idsBefore, "no duplicate or leftover compact ids");
  assert.equal(page.children.some((child) => child.name === "Compact Design patch backup"), false, "backup holder is removed");
  // A successful patch also leaves no holder behind.
  await applyFigmaPatch(checkedPatch(setOp("leaf", { fill: "#123456" }), setOp("inner", { cornerRadius: 9 })), emptyPatchContext() as never);
  assert.equal(page.children.some((child) => child.name === "Compact Design patch backup"), false);
  assert.deepEqual(countIds(), idsBefore);
});

test("GROUP children: insert is group-relative, set x/y is rejected in both engines", async () => {
  const document = normalize({ canvas: { id: "screen", width: 400, height: 400 }, nodes: [{ id: "holder", type: "FRAME", x: 10, y: 10, w: 300, h: 300, children: [] }] });
  const { page } = installFigmaMock([]);
  await createNode(document.nodes[0], page as never, { x: 0, y: 0 }, importContext() as never);
  const holder = mockById(page, "holder");
  const group = createMockNode("GROUP", "group"); group.setPluginData("compactDesignId", "group"); group.x = 40; group.y = 50; holder.appendChild(group);
  const member = createMockNode("RECTANGLE", "member"); member.setPluginData("compactDesignId", "member"); member.x = 40; member.y = 50; group.appendChild(member);
  await applyFigmaPatch(checkedPatch({ op: "append", parent: "group", node: { id: "dot", type: "RECTANGLE", x: 5, y: 6, w: 2, h: 2 } }), emptyPatchContext() as never);
  assert.deepEqual([mockById(page, "dot").x, mockById(page, "dot").y], [45, 56], "Figma stores group children in the group's parent space");
  await assert.rejects(() => applyFigmaPatch(checkedPatch(setOp("member", { x: 1 })), emptyPatchContext() as never), /children of a GROUP cannot be positioned/);
  const coreDocument = normalize({ canvas: { id: "screen", width: 400, height: 400 }, nodes: [{ id: "holder", type: "FRAME", x: 10, y: 10, w: 300, h: 300, children: [{ id: "group", type: "GROUP", x: 40, y: 50, w: 10, h: 10, children: [{ id: "member", type: "RECTANGLE", w: 10, h: 10 }] }] }] });
  const appended = validatePatch(coreDocument, { patch: { operations: [{ op: "append", parent: "group", node: { id: "dot", type: "RECTANGLE", x: 5, y: 6, w: 2, h: 2 } }] } });
  assert.equal(appended.valid, true);
  const dot = appended.document!.nodes[0].children[0].children[0].children[1];
  assert.deepEqual(dot.properties.position, { x: 10 + 40 + 5, y: 10 + 50 + 6 }, "same absolute position as Figma (holder 10 + group 40 + 5)");
  assert.equal(validatePatch(coreDocument, { patch: { operations: [setOp("member", { x: 1 })] } }).valid, false);
});

test("e2e: a real multi-node document imports, takes a sequence of set patches, validates, and round-trips identically", async () => {
  const sample = JSON.parse(readFileSync(join("..", "..", "examples", "update-patch-theme-sample.json"), "utf8"));
  const document = normalize(sample);
  assert.equal(validate(sample).valid, true);
  const variables = new Map([["surface", { id: "var:surface" }], ["ink", { id: "var:ink" }], ["gap", { id: "var:gap" }]]);
  const collections = new Map([["Theme", { id: "col:theme", name: "Theme", modes: [{ name: "Light", modeId: "1" }, { name: "Dark", modeId: "2" }] }]]);
  const page = await importIntoMock(document, importContext(variables, collections));
  assert.deepEqual(await figmaState(page), await coreState(document));
  const steps: unknown[][] = [
    [setOp("theme-title", { text: "The same design.\nA different mood." }), setOp("theme-card", { cornerRadius: 40 })],
    [setOp("theme-card", { layout: { itemSpacing: 28, padding: { top: 48 } } })],
    [setOp("theme-title", { font: { size: 48 } }), setOp("theme-eyebrow", { textCase: "UPPER", letterSpacing: { unit: "PERCENT", value: 8 } })],
    [setOp("theme-copy", { fill: "#3A3A3A" })],
    [setOp("theme-card", { x: 120, y: 96, w: 640 })]
  ];
  let current = document;
  for (const [index, operations] of steps.entries()) {
    const raw = { patch: { operations } };
    const checked = validatePatch(current, raw);
    assert.equal(checked.valid, true, `step ${index}: ${checked.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    current = checked.document!;
    await applyFigmaPatch(checked.patch!, emptyPatchContext() as never);
    assert.deepEqual(await figmaState(page), await coreState(current), `step ${index}`);
  }
  assert.equal(validatePatch(current, { patch: { operations: [setOp("theme-card", { opacity: 1 })] } }).valid, true);
  const findCore = (id: string) => { const visit = (nodes: InternalNode[]): InternalNode | null => { for (const node of nodes) { if (node.id === id) return node; const found = visit(node.children); if (found) return found; } return null; }; return visit(current.nodes)!; };
  assert.equal(findCore("theme-copy").properties.bindings, undefined, "fill set detaches the fill binding in core");
  assert.equal(((mockById(page, "theme-copy").fills as Array<{ boundVariables?: unknown }>)[0]).boundVariables, undefined, "and in Figma");
  assert.deepEqual(findCore("theme-title").properties.bindings, { fill: "ink" }, "unrelated bindings survive");
  assert.deepEqual(findCore("theme-card").properties.layout?.padding, { left: 32, top: 48, right: 32, bottom: 32 });
});


test("authoredComponentPropertyName strips Figma #id suffixes", () => {
  assert.equal(authoredComponentPropertyName("Label#0:1"), "Label");
  assert.equal(authoredComponentPropertyName("ShowIcon#2:3"), "ShowIcon");
  assert.equal(authoredComponentPropertyName("Plain"), "Plain");
});

test("component property links: import maps authored names to generated keys and export round-trips", async () => {
  const source = {
    canvas: { id: "screen", width: 400, height: 200, fill: "#FFFFFF" },
    nodes: [
      { id: "icon-star", type: "COMPONENT", name: "Icon/Star", w: 16, h: 16, fill: "#111111" },
      {
        id: "button",
        type: "COMPONENT",
        name: "Button",
        w: 160,
        h: 48,
        fill: "#2563EB",
        componentProperties: [
          { name: "Label", type: "TEXT", defaultValue: "Continue" },
          { name: "ShowIcon", type: "BOOLEAN", defaultValue: true },
          { name: "Icon", type: "INSTANCE_SWAP", defaultValue: "icon-star" }
        ],
        children: [
          { id: "button-label", type: "TEXT", name: "Label", w: 100, h: 20, text: "Continue", fill: "#FFFFFF", componentPropertyReferences: { characters: "Label" } },
          { id: "button-icon", type: "INSTANCE", name: "Icon", componentId: "icon-star", w: 16, h: 16, componentPropertyReferences: { visible: "ShowIcon", mainComponent: "Icon" } }
        ]
      },
      {
        id: "button-1",
        type: "INSTANCE",
        name: "Button Instance",
        componentId: "button",
        x: 200,
        w: 160,
        h: 48,
        instanceProperties: { Label: "Start free", ShowIcon: false }
      }
    ]
  };

  const checked = validate(source);
  assert.equal(checked.valid, true, JSON.stringify(checked.issues, null, 2));
  const document = normalize(source);

  const context = importContext();
  const page = await importIntoMock(document, context);

  const button = mockById(page, "button");
  const definitions = button.componentPropertyDefinitions as Record<string, { type: string; defaultValue: string | boolean }>;
  const keys = Object.keys(definitions);
  assert.equal(keys.length, 3);
  assert.ok(keys.every((key) => key.includes("#")), `expected generated keys with # suffixes, got ${keys.join(", ")}`);
  assert.deepEqual(keys.map(authoredComponentPropertyName).sort(), ["Icon", "Label", "ShowIcon"]);
  assert.equal(definitions[keys.find((key) => key.startsWith("Icon#"))!].defaultValue, mockById(page, "icon-star").id);

  const label = mockById(page, "button-label");
  const iconSlot = mockById(page, "button-icon");
  const labelKey = keys.find((key) => key.startsWith("Label#"))!;
  const showKey = keys.find((key) => key.startsWith("ShowIcon#"))!;
  const iconKey = keys.find((key) => key.startsWith("Icon#"))!;
  assert.deepEqual(label.componentPropertyReferences, { characters: labelKey });
  assert.deepEqual(iconSlot.componentPropertyReferences, { visible: showKey, mainComponent: iconKey });

  const instance = mockById(page, "button-1");
  const instanceProps = instance.componentProperties as Record<string, { type: string; value: string | boolean }>;
  assert.equal(instanceProps[labelKey]?.value, "Start free");
  assert.equal(instanceProps[showKey]?.value, false);

  // Export selection of the three roots and compare to input modulo normalization.
  const roots = page.children.slice();
  const { document: exported } = await exportSelection(roots as never);
  const exportedNodes = (exported.nodes || (exported.canvases as Array<{ nodes: unknown[] }>)?.[0]?.nodes) as Array<Record<string, unknown>>;
  // exportSelection wraps each root: COMPONENT/INSTANCE become canvas children.
  // Flatten to top-level compact nodes for comparison.
  const flat: Array<Record<string, unknown>> = [];
  if (Array.isArray(exported.nodes)) {
    // Single-canvas path: canvas was the first FRAME-like selection — our roots aren't FRAMEs so each is wrapped.
  }
  // Multi-root non-FRAME selection yields canvases[]
  if (Array.isArray(exported.canvases)) {
    for (const canvas of exported.canvases as Array<{ nodes: Array<Record<string, unknown>> }>) {
      for (const node of canvas.nodes || []) flat.push(node);
    }
  } else if (Array.isArray(exported.nodes)) {
    for (const node of exported.nodes as Array<Record<string, unknown>>) flat.push(node);
  }

  const byId = Object.fromEntries(flat.map((node) => [node.id, node]));
  assert.ok(byId["button"], `exported ids: ${flat.map((node) => node.id).join(", ")}`);
  assert.ok(byId["icon-star"]);
  assert.ok(byId["button-1"]);

  const exportedButton = byId["button"] as { componentProperties: Array<{ name: string; type: string; defaultValue: unknown }>; children: Array<Record<string, unknown>> };
  assert.deepEqual(
    exportedButton.componentProperties.map((property) => ({ name: property.name, type: property.type })).sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: "Icon", type: "INSTANCE_SWAP" },
      { name: "Label", type: "TEXT" },
      { name: "ShowIcon", type: "BOOLEAN" }
    ]
  );
  const iconProp = exportedButton.componentProperties.find((property) => property.name === "Icon")!;
  assert.equal(iconProp.defaultValue, "icon-star");

  const exportedLabel = exportedButton.children.find((child) => child.id === "button-label")!;
  const exportedIcon = exportedButton.children.find((child) => child.id === "button-icon")!;
  assert.deepEqual(exportedLabel.componentPropertyReferences, { characters: "Label" });
  assert.deepEqual(exportedIcon.componentPropertyReferences, { visible: "ShowIcon", mainComponent: "Icon" });

  const exportedInstance = byId["button-1"] as { componentId: string; instanceProperties: Record<string, unknown> };
  assert.equal(exportedInstance.componentId, "button");
  assert.equal(exportedInstance.instanceProperties.Label, "Start free");
  assert.equal(exportedInstance.instanceProperties.ShowIcon, false);
  assert.ok(!Object.keys(exportedInstance.instanceProperties).some((key) => key.includes("#")), "instanceProperties must use authored names");

  // Re-validate the exported document shape (rebuild a compact doc from flats).
  const roundTrip = validate({
    canvas: { id: "screen", width: 400, height: 200, fill: "#FFFFFF" },
    nodes: flat
  });
  assert.equal(roundTrip.valid, true, JSON.stringify(roundTrip.issues, null, 2));
});

test("Figma-native component with generated keys exports through the same authored model", async () => {
  const icon = createMockNode("COMPONENT", "Icon");
  icon.setPluginData("compactDesignId", "icon-star");
  icon.resize(16, 16);
  const button = createMockNode("COMPONENT", "Button");
  button.setPluginData("compactDesignId", "button");
  button.resize(160, 48);
  const labelKey = (button as MockNode & { addComponentProperty: Function }).addComponentProperty("Label", "TEXT", "Continue");
  const showKey = (button as MockNode & { addComponentProperty: Function }).addComponentProperty("ShowIcon", "BOOLEAN", true);
  const label = createMockNode("TEXT", "Label");
  label.setPluginData("compactDesignId", "button-label");
  label.characters = "Continue";
  label.componentPropertyReferences = { characters: labelKey };
  button.appendChild(label);
  const iconSlot = createMockNode("INSTANCE", "Icon");
  iconSlot.setPluginData("compactDesignId", "button-icon");
  iconSlot.getMainComponentAsync = async () => icon;
  iconSlot.componentProperties = {};
  iconSlot.componentPropertyReferences = { visible: showKey };
  button.appendChild(iconSlot);
  installFigmaMock([icon, button]);

  const { document: exported } = await exportSelection([button] as never);
  const nodes = Array.isArray(exported.canvases)
    ? (exported.canvases as Array<{ nodes: Array<Record<string, unknown>> }>)[0].nodes
    : (exported.nodes as Array<Record<string, unknown>>);
  const exportedButton = nodes.find((node) => node.id === "button") || nodes[0];
  assert.ok(exportedButton);
  const props = exportedButton.componentProperties as Array<{ name: string; type: string }>;
  assert.deepEqual(props.map((property) => property.name).sort(), ["Label", "ShowIcon"]);
  const children = exportedButton.children as Array<Record<string, unknown>>;
  assert.deepEqual(children.find((child) => child.id === "button-label")?.componentPropertyReferences, { characters: "Label" });
  assert.deepEqual(children.find((child) => child.id === "button-icon")?.componentPropertyReferences, { visible: "ShowIcon" });
});
