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
import { applyPatch as applyCorePatch, applyResourceUpsert, matchStyle, matchVariable, normalize, normalizePatch, PATCH_SET_KEYS, PATCH_SET_SEMANTICS, validate, validatePatch, type InternalDocument, type InternalNode, type InternalPatchDocument, type PatchSetKey } from "@compact-design/core";
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

test("export and patch paths use async APIs under dynamic-page (no sync mainComponent / reactions setter)", () => {
  const exporter = readFileSync("src/plugin/exporter.ts", "utf8");
  const patch = readFileSync("src/plugin/patch.ts", "utf8");
  const nodes = readFileSync("src/plugin/nodes.ts", "utf8");
  const definitions = readFileSync("src/plugin/patch-definitions.ts", "utf8");
  const main = readFileSync("src/plugin/main.ts", "utf8");
  /** Allow CPR field access on plain data objects named refs/mapped/result/merged/current/entries. */
  const stripAllowed = (source: string) => source
    .replace(/\b(refs|mapped|result|merged|current|entries)(\.mainComponent|\["mainComponent"\]|\['mainComponent'\])/g, "$1.__cprMain__");
  for (const [name, source] of [["exporter", exporter], ["patch", patch], ["nodes", nodes], ["patch-definitions", definitions]] as const) {
    const cleaned = stripAllowed(source);
    assert.doesNotMatch(cleaned, /\.mainComponent\b/, `${name} must not sync-read InstanceNode.mainComponent`);
    assert.doesNotMatch(cleaned, /\["mainComponent"\]|\['mainComponent'\]/, `${name} must not bracket-access mainComponent on a Figma node`);
    assert.doesNotMatch(cleaned, /(?<!get)getMainComponent\s*\(/, `${name} must not call sync getMainComponent()`);
    assert.doesNotMatch(cleaned, /\.reactions\s*=/, `${name} must not sync-assign node.reactions (use setReactionsAsync)`);
  }
  assert.match(exporter, /getMainComponentAsync\s*\(/);
  assert.match(patch, /getMainComponentAsync\s*\(/);
  assert.match(patch, /loadAllPagesAsync\s*\(/);
  assert.match(patch, /setReactionsAsync\s*\(/);
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
  const base: Record<string, unknown> = { opacity: 1, blendMode: "PASS_THROUGH", visible: true, locked: false, isMask: false, boundVariables: {}, fillStyleId: "", strokeStyleId: "", textStyleId: "", explicitVariableModes: {} };
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
  if (type === "COMPONENT" || type === "COMPONENT_SET") Object.assign(base, {
    _componentPropertyDefinitions: {} as Record<string, { type: string; defaultValue: string | boolean; preferredValues?: unknown[]; variantOptions?: string[] }>,
    _propSeq: 0,
    addComponentProperty(this: MockNode, name: string, propertyType: string, defaultValue: string | boolean, options: { preferredValues?: unknown[] } = {}) {
      const key = propertyType === "VARIANT" ? name : `${name}#${this._propSeq}:0`;
      if (propertyType !== "VARIANT") this._propSeq = Number(this._propSeq) + 1;
      const definitions = (this as MockNode & { _componentPropertyDefinitions: Record<string, unknown> })._componentPropertyDefinitions;
      definitions[key] = {
        type: propertyType,
        defaultValue,
        ...(options.preferredValues ? { preferredValues: options.preferredValues } : {}),
        ...(propertyType === "VARIANT" ? { variantOptions: [String(defaultValue)] } : {})
      };
      return key;
    },
    editComponentProperty(this: MockNode, propertyName: string, update: { name?: string; defaultValue?: string | boolean; preferredValues?: unknown[] }) {
      const definitions = (this as MockNode & { _componentPropertyDefinitions: Record<string, { type: string; defaultValue: string | boolean; preferredValues?: unknown[]; variantOptions?: string[] }> })._componentPropertyDefinitions;
      const current = definitions[propertyName];
      if (!current) throw new Error(`unknown component property '${propertyName}'`);
      const nextKey = update.name && current.type !== "VARIANT" ? `${update.name}#${propertyName.split("#")[1] || "0:0"}` : (update.name || propertyName);
      const next = {
        ...current,
        ...(update.defaultValue !== undefined ? { defaultValue: update.defaultValue } : {}),
        ...(update.preferredValues ? { preferredValues: update.preferredValues } : {})
      };
      if (nextKey !== propertyName) {
        delete definitions[propertyName];
        definitions[nextKey] = next;
        if (current.type === "VARIANT" && this.type === "COMPONENT_SET") {
          const remap = (node: MockNode) => {
            if (node.type === "INSTANCE") {
              const props = (node as MockNode & { _componentProperties?: Record<string, { type: string; value: string | boolean }> })._componentProperties;
              if (props && propertyName in props) {
                props[nextKey] = { ...props[propertyName], type: "VARIANT" };
                delete props[propertyName];
              }
            }
            for (const child of node.children) remap(child);
          };
          const root = (globalThis as { figma?: { root?: { children: MockNode[] } } }).figma?.root;
          if (root) for (const page of root.children) remap(page);
        }
      } else {
        definitions[propertyName] = next;
      }
      return nextKey;
    },
    deleteComponentProperty(this: MockNode, propertyName: string) {
      const definitions = (this as MockNode & { _componentPropertyDefinitions: Record<string, { type: string }> })._componentPropertyDefinitions;
      const current = definitions[propertyName];
      if (!current) return;
      if (current.type === "VARIANT") throw new Error(`cannot delete VARIANT property '${propertyName}'`);
      delete definitions[propertyName];
    },
  });
  if (type === "COMPONENT") Object.assign(base, {
    createInstance(this: MockNode) {
      const main = this;
      const instance = createMockNode("INSTANCE", this.name);
      for (const child of this.children) {
        const copy = child.clone();
        const clearIds = (node: MockNode) => { node.setPluginData("compactDesignId", ""); node.children.forEach(clearIds); };
        clearIds(copy);
        instance.appendChild(copy);
      }
      instance.mainComponentId = this.id;
      const definitions = (this as MockNode & { _componentPropertyDefinitions: Record<string, { type: string; defaultValue: string | boolean }> })._componentPropertyDefinitions || {};
      (instance as MockNode & { _componentProperties: Record<string, { type: string; value: string | boolean }> })._componentProperties =
        Object.fromEntries(Object.entries(definitions).map(([key, def]) => [key, { type: def.type, value: def.defaultValue }]));
      instance.getMainComponentAsync = async () => {
        const api = (globalThis as { figma?: { getNodeByIdAsync?: (id: string) => Promise<MockNode | null> } }).figma;
        if (api?.getNodeByIdAsync) return api.getNodeByIdAsync(String(instance.mainComponentId));
        return main;
      };
      instance.swapComponent = (component: MockNode) => {
        instance.mainComponentId = component.id;
      };
      instance.setProperties = (overrides: Record<string, string | boolean>) => {
        const props = (instance as MockNode & { _componentProperties: Record<string, { type: string; value: string | boolean }> })._componentProperties;
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
    _componentProperties: {} as Record<string, { type: string; value: string | boolean }>,
    getMainComponentAsync: async () => null as MockNode | null,
    setProperties(this: MockNode, overrides: Record<string, string | boolean>) {
      const props = (this as MockNode & { _componentProperties: Record<string, { type: string; value: string | boolean }> })._componentProperties;
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
  base.setBoundVariable = function (this: MockNode, field: string, variable: { id: string } | null) {
    const bound = this.boundVariables as Record<string, unknown>;
    if (variable === null) delete bound[field];
    else bound[field] = { type: "VARIABLE_ALIAS", id: variable.id };
  };
  base.setFillStyleIdAsync = async function (this: MockNode, id: string) { this.fillStyleId = id; };
  base.setStrokeStyleIdAsync = async function (this: MockNode, id: string) { this.strokeStyleId = id; };
  base.setTextStyleIdAsync = async function (this: MockNode, id: string) { this.textStyleId = id; };
  base.setExplicitVariableModeForCollection = function (this: MockNode, collection: { id: string }, modeId: string) {
    const modes = (this.explicitVariableModes || {}) as Record<string, string>;
    modes[collection.id] = modeId;
    this.explicitVariableModes = modes;
  };
  base.clearExplicitVariableModeForCollection = function (this: MockNode, collection: { id: string }) {
    const modes = { ...((this.explicitVariableModes || {}) as Record<string, string>) };
    delete modes[collection.id];
    this.explicitVariableModes = modes;
  };
  return base;
}

function cloneMockValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneMockValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneMockValue(item)]));
  return value;
}


/** Like real Figma: componentPropertyDefinitions / componentProperties getters return deep copies. */
function installFigmaCopyGetters(node: MockNode): void {
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    if (!(node as MockNode & { _componentPropertyDefinitions?: unknown })._componentPropertyDefinitions) {
      (node as MockNode & { _componentPropertyDefinitions: Record<string, unknown> })._componentPropertyDefinitions = {};
    }
    Object.defineProperty(node, "componentPropertyDefinitions", {
      enumerable: true,
      configurable: true,
      get() {
        const internal = (this as MockNode & { _componentPropertyDefinitions: Record<string, { type: string; variantOptions?: string[] }> })._componentPropertyDefinitions;
        const copy = cloneMockValue(internal) as Record<string, { type: string; variantOptions?: string[] }>;
        if (this.type === "COMPONENT_SET") {
          const derived: Record<string, string[]> = {};
          for (const child of this.children) {
            if (child.type !== "COMPONENT") continue;
            for (const part of String(child.name).split(",")) {
              const trimmed = part.trim();
              const eq = trimmed.indexOf("=");
              if (eq <= 0) continue;
              const axis = trimmed.slice(0, eq);
              const option = trimmed.slice(eq + 1);
              if (!derived[axis]) derived[axis] = [];
              if (!derived[axis].includes(option)) derived[axis].push(option);
            }
          }
          for (const [key, def] of Object.entries(copy)) {
            if (def.type === "VARIANT") {
              const axis = key.includes("#") ? key.slice(0, key.indexOf("#")) : key;
              def.variantOptions = derived[axis] ? [...derived[axis]] : [...(def.variantOptions || [])];
            }
          }
        }
        return copy;
      },
      set(value: Record<string, unknown>) {
        (this as MockNode & { _componentPropertyDefinitions: Record<string, unknown> })._componentPropertyDefinitions =
          cloneMockValue(value || {}) as Record<string, unknown>;
      }
    });
  }
  if (node.type === "INSTANCE") {
    if (!(node as MockNode & { _componentProperties?: unknown })._componentProperties) {
      (node as MockNode & { _componentProperties: Record<string, unknown> })._componentProperties = {};
    }
    Object.defineProperty(node, "componentProperties", {
      enumerable: true,
      configurable: true,
      get() {
        return cloneMockValue((this as MockNode & { _componentProperties: Record<string, unknown> })._componentProperties);
      },
      set(value: Record<string, unknown>) {
        (this as MockNode & { _componentProperties: Record<string, unknown> })._componentProperties =
          cloneMockValue(value || {}) as Record<string, unknown>;
      }
    });
  }
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
      const self = this as MockNode & { _componentPropertyDefinitions?: unknown; _componentProperties?: unknown };
      if (self._componentPropertyDefinitions) {
        (copy as MockNode & { _componentPropertyDefinitions: unknown })._componentPropertyDefinitions = cloneMockValue(self._componentPropertyDefinitions);
      }
      if (self._componentProperties) {
        (copy as MockNode & { _componentProperties: unknown })._componentProperties = cloneMockValue(self._componentProperties);
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
    reactions: [] as Array<Record<string, unknown>>,
    getPluginData(key: string) { return this.pluginData[key] || ""; },
    setPluginData(key: string, value: string) { this.pluginData[key] = value; },
    async setReactionsAsync(reactions: Array<Record<string, unknown>>) {
      const multi = reactions.some((reaction) => Array.isArray(reaction.actions) && (reaction.actions as unknown[]).length > 1);
      if (multi && !(this as MockNode & { __allowMultiAction?: boolean }).__allowMultiAction) {
        throw new Error("in setReactionsAsync: Multiple actions per reaction are not supported on the current plan");
      }
      this.reactions = reactions;
    }
  };
  installFigmaCopyGetters(node);
  return node;
}

function emptyPatchContext() {
  return {
    sourceNodes: new Map(),
    componentPropertyKeys: new Map(),
    componentPropertyTypes: new Map(),
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

type MockStyle = {
  id: string;
  name: string;
  type: "PAINT" | "TEXT";
  paints: unknown[];
  fontName: { family: string; style: string };
  fontSize: number;
  lineHeight: { unit: string; value?: number };
  letterSpacing: { unit: string; value: number };
  paragraphSpacing: number;
  removed: boolean;
  pluginData: Record<string, string>;
  getPluginData: (key: string) => string;
  setPluginData: (key: string, value: string) => void;
  remove: () => void;
};

type MockVariableCollection = {
  id: string;
  name: string;
  modes: Array<{ modeId: string; name: string }>;
  removed: boolean;
  _modeSeq: number;
  renameMode: (modeId: string, name: string) => void;
  addMode: (name: string) => string;
  removeMode: (modeId: string) => void;
  remove: () => void;
};

type MockVariable = {
  id: string;
  name: string;
  resolvedType: string;
  variableCollectionId: string;
  valuesByMode: Record<string, unknown>;
  removed: boolean;
  pluginData: Record<string, string>;
  getPluginData: (key: string) => string;
  setPluginData: (key: string, value: string) => void;
  setValueForMode: (modeId: string, value: unknown) => void;
  remove: () => void;
};

let mockStyleSeq = 0;
let mockCollectionSeq = 0;
let mockVariableSeq = 0;

function createMockStyle(type: "PAINT" | "TEXT"): MockStyle {
  mockStyleSeq += 1;
  const style: MockStyle = {
    id: `style:${mockStyleSeq}`,
    name: `Style ${mockStyleSeq}`,
    type,
    paints: [],
    fontName: { family: "Inter", style: "Regular" },
    fontSize: 12,
    lineHeight: { unit: "AUTO" },
    letterSpacing: { unit: "PERCENT", value: 0 },
    paragraphSpacing: 0,
    removed: false,
    pluginData: {},
    getPluginData(key: string) { return this.pluginData[key] || ""; },
    setPluginData(key: string, value: string) { this.pluginData[key] = value; },
    remove() { this.removed = true; }
  };
  return style;
}

function createMockVariableCollection(name: string): MockVariableCollection {
  mockCollectionSeq += 1;
  const collection: MockVariableCollection = {
    id: `VariableCollectionId:${mockCollectionSeq}`,
    name,
    modes: [{ modeId: `${mockCollectionSeq}:0`, name: "Mode 1" }],
    removed: false,
    _modeSeq: 0,
    renameMode(modeId: string, next: string) {
      const mode = this.modes.find((candidate) => candidate.modeId === modeId);
      if (mode) mode.name = next;
    },
    addMode(modeName: string) {
      const api = (globalThis as { figma?: { _modeLimit?: number } }).figma;
      if (api?._modeLimit !== undefined && this.modes.length >= api._modeLimit) {
        throw new Error(`in addMode: Limited to ${api._modeLimit} modes only`);
      }
      this._modeSeq += 1;
      const modeId = `${this.id}:${this._modeSeq}`;
      this.modes.push({ modeId, name: modeName });
      // Seed existing variables from mode 0 (Figma behaviour).
      const vars = ((globalThis as { figma?: { _variables?: MockVariable[] } }).figma?._variables || []).filter((variable) => variable.variableCollectionId === this.id && !variable.removed);
      const seedId = this.modes[0].modeId;
      for (const variable of vars) {
        if (!(modeId in variable.valuesByMode) && seedId in variable.valuesByMode) {
          variable.valuesByMode[modeId] = typeof variable.valuesByMode[seedId] === "object" && variable.valuesByMode[seedId]
            ? JSON.parse(JSON.stringify(variable.valuesByMode[seedId]))
            : variable.valuesByMode[seedId];
        }
      }
      return modeId;
    },
    removeMode(modeId: string) {
      this.modes = this.modes.filter((mode) => mode.modeId !== modeId);
      const vars = ((globalThis as { figma?: { _variables?: MockVariable[] } }).figma?._variables || []).filter((variable) => variable.variableCollectionId === this.id);
      for (const variable of vars) delete variable.valuesByMode[modeId];
    },
    remove() { this.removed = true; }
  };
  return collection;
}

function createMockVariable(name: string, collection: MockVariableCollection, resolvedType: string): MockVariable {
  mockVariableSeq += 1;
  const valuesByMode: Record<string, unknown> = {};
  for (const mode of collection.modes) {
    valuesByMode[mode.modeId] = resolvedType === "COLOR" ? { r: 0, g: 0, b: 0, a: 1 } : resolvedType === "FLOAT" ? 0 : resolvedType === "BOOLEAN" ? false : "";
  }
  const variable: MockVariable = {
    id: `VariableID:${mockVariableSeq}`,
    name,
    resolvedType,
    variableCollectionId: collection.id,
    valuesByMode,
    removed: false,
    pluginData: {},
    getPluginData(key: string) { return this.pluginData[key] || ""; },
    setPluginData(key: string, value: string) { this.pluginData[key] = value; },
    setValueForMode(modeId: string, value: unknown) {
      this.valuesByMode[modeId] = typeof value === "object" && value ? JSON.parse(JSON.stringify(value)) : value;
    },
    remove() { this.removed = true; }
  };
  return variable;
}

function installFigmaMock(pageChildren: MockNode[], extraPages: MockNode[][] = []) {
  const page = createMockNode("PAGE", "Page 1");
  page.children = pageChildren;
  for (const child of pageChildren) child.parent = page;
  const pages = [page];
  for (const [index, children] of extraPages.entries()) {
    const extra = createMockNode("PAGE", `Page ${index + 2}`);
    extra.children = children;
    for (const child of children) child.parent = extra;
    pages.push(extra);
  }
  let pagesLoaded = extraPages.length === 0; // single-page mocks behave as already loaded

  const walkPages = (predicate?: (node: MockNode) => boolean, allPages = false): MockNode[] => {
    const out: MockNode[] = [];
    const walk = (nodes: MockNode[]) => {
      for (const node of nodes) {
        if (node.removed) continue;
        if (!predicate || predicate(node)) out.push(node);
        walk(node.children);
      }
    };
    const targets = allPages || pagesLoaded ? pages : [page];
    for (const target of targets) walk(target.children);
    return out;
  };

  const findAll = (predicate?: (node: MockNode) => boolean): MockNode[] => walkPages(predicate, false);

  const figmaMock = {
    mixed: MIXED,
    currentPage: Object.assign(page, { findAll, selection: [] as MockNode[], loadAsync: async () => undefined }),
    root: {
      children: pages,
      findAllWithCriteria: ({ types }: { types: string[] }) => {
      if (!pagesLoaded) (figmaMock as { __findAllWithCriteriaBeforeLoad?: boolean }).__findAllWithCriteriaBeforeLoad = true;
      return walkPages((node) => types.includes(String(node.type)), false);
    },
      findAll: (predicate?: (node: MockNode) => boolean) => walkPages(predicate, true)
    },
    loadAllPagesAsync: async () => { pagesLoaded = true; (figmaMock as { __loadAllPagesAsyncCalls?: number }).__loadAllPagesAsyncCalls = ((figmaMock as { __loadAllPagesAsyncCalls?: number }).__loadAllPagesAsyncCalls || 0) + 1; },
    getNodeByIdAsync: async (id: string) => walkPages(undefined, true).find((node) => node.id === id) || null,
    createFrame: () => createMockNode("FRAME"),
    /**
     * Real Figma: grouped children keep coordinates in the *parent's* space (not the group's).
     * Moving the group later shifts every child by the same delta.
     */
    group: (nodes: MockNode[], parent: MockNode) => {
      const g = createMockNode("GROUP", "Group");
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of nodes) {
        minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + n.width); maxY = Math.max(maxY, n.y + n.height);
      }
      const bx = Number.isFinite(minX) ? minX : 0;
      const by = Number.isFinite(minY) ? minY : 0;
      let gx = bx, gy = by;
      g.width = Math.max(1, (Number.isFinite(maxX) ? maxX : 1) - bx);
      g.height = Math.max(1, (Number.isFinite(maxY) ? maxY : 1) - by);
      parent.appendChild(g);
      for (const n of nodes) g.appendChild(n); // keep x/y — already parent-space
      Object.defineProperty(g, "x", {
        configurable: true, enumerable: true,
        get: () => gx,
        set: (v: number) => { const dx = v - gx; gx = v; for (const child of g.children) child.x += dx; }
      });
      Object.defineProperty(g, "y", {
        configurable: true, enumerable: true,
        get: () => gy,
        set: (v: number) => { const dy = v - gy; gy = v; for (const child of g.children) child.y += dy; }
      });
      return g;
    },
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
    combineAsVariants: (components: MockNode[], parent: MockNode) => {
      const set = createMockNode("COMPONENT_SET", "set");
      for (const component of components) {
        if (component.parent) {
          const from = component.parent.children.indexOf(component);
          if (from >= 0) component.parent.children.splice(from, 1);
        }
        set.appendChild(component);
        for (const part of String(component.name).split(",")) {
          const trimmed = part.trim();
          const eq = trimmed.indexOf("=");
          if (eq < 0) continue;
          const axis = trimmed.slice(0, eq);
          const option = trimmed.slice(eq + 1);
          const defs = (set as MockNode & { _componentPropertyDefinitions: Record<string, { type: string }> })._componentPropertyDefinitions;
          if (!defs[axis]) {
            (set as MockNode & { addComponentProperty: Function }).addComponentProperty(axis, "VARIANT", option);
          }
        }
      }
      parent.appendChild(set);
      return set;
    },
    loadFontAsync: async (font: { family: string; style: string }) => {
      loadedFonts.push(`${font.family} ${font.style}`);
      if (font.family === "Missing Font") throw new Error("font not found");
    },
    _paintStyles: [] as MockStyle[],
    _textStyles: [] as MockStyle[],
    _variableCollections: [] as MockVariableCollection[],
    _variables: [] as MockVariable[],
    _modeLimit: undefined as number | undefined,
    getLocalPaintStylesAsync: async function (this: { _paintStyles: MockStyle[]; _textStyles: MockStyle[] }) { return this._paintStyles.filter((style) => !style.removed); },
    getLocalTextStylesAsync: async function (this: { _paintStyles: MockStyle[]; _textStyles: MockStyle[] }) { return this._textStyles.filter((style) => !style.removed); },
    createPaintStyle: function (this: { _paintStyles: MockStyle[]; _textStyles: MockStyle[] }) {
      const style = createMockStyle("PAINT");
      this._paintStyles.push(style);
      return style;
    },
    createTextStyle: function (this: { _paintStyles: MockStyle[]; _textStyles: MockStyle[] }) {
      const style = createMockStyle("TEXT");
      this._textStyles.push(style);
      return style;
    },
    variables: {
      setBoundVariableForPaint: (paint: Record<string, unknown>, field: string, variable: { id: string }) => ({ ...paint, boundVariables: { [field]: { type: "VARIABLE_ALIAS", id: variable.id } } }),
      getLocalVariableCollectionsAsync: async () => (figmaMock._variableCollections as MockVariableCollection[]).filter((collection) => !collection.removed),
      getLocalVariablesAsync: async () => (figmaMock._variables as MockVariable[]).filter((variable) => !variable.removed),
      createVariableCollection: (name: string) => {
        const collection = createMockVariableCollection(name);
        (figmaMock._variableCollections as MockVariableCollection[]).push(collection);
        return collection;
      },
      createVariable: (name: string, collection: MockVariableCollection, resolvedType: string) => {
        const variable = createMockVariable(name, collection, resolvedType);
        (figmaMock._variables as MockVariable[]).push(variable);
        return variable;
      }
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
    componentPropertyTypes: new Map(),
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
    componentId: ["rect", "c"], componentProperties: ["comp", { Title: { type: "TEXT", defaultValue: "Hi" } }], instanceProperties: ["inst", { Label: "Go" }], componentPropertyReferences: ["comp-label", { characters: "Label" }], variantAxes: ["set", { State: { rename: "Status" } }], variant: ["set-a", { State: "Hover" }],
    operation: ["bool", "SUBTRACT"], prototype: ["rect", [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NAVIGATE", destination: "screen" }] }]], overflowDirection: ["frame", "VERTICAL"], numberOfFixedChildren: ["stack", 1],
    styleRefs: ["rect", { fill: "Ink" }], bindings: ["rect", { opacity: "gap" }], variableModes: ["rect", { Theme: "Dark" }]
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
    const comp = make("COMPONENT", "comp", screen);
    (comp as MockNode).componentPropertyDefinitions = { "Label#0:1": { type: "TEXT", defaultValue: "Hi" } };
    const compLabel = make("TEXT", "comp-label", comp); compLabel.characters = "Hi";
    const inst = (comp as MockNode).createInstance();
    inst.setPluginData("compactDesignId", "inst");
    screen.appendChild(inst);
    const set = make("COMPONENT_SET", "set", screen);
    (set as MockNode).componentPropertyDefinitions = { State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] } };
    const setA = make("COMPONENT", "set-a", set); setA.name = "State=Default";
    const setB = make("COMPONENT", "set-b", set); setB.name = "State=Hover";
    installFigmaMock([screen]);
    return screen;
  };
  const richPatchContext = () => {
    const ctx = emptyPatchContext();
    ctx.resources.variables.set("gap", { id: "var:gap", name: "gap" } as never);
    ctx.resources.paintStyles.set("Ink", { id: "style:ink", name: "Ink" } as never);
    ctx.resources.variableCollections.set("Theme", { id: "col:theme", name: "Theme", modes: [{ name: "Light", modeId: "1" }, { name: "Dark", modeId: "2" }] } as never);
    return ctx;
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
    await applyFigmaPatch(checkedPatch(setOp(target, { [key]: value })), richPatchContext() as never);
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

test("set on a node inserted in the same patch applies (lockstep with core)", async () => {
  const page = await importIntoMock(parityDocument());
  await applyFigmaPatch(checkedPatch({ op: "append", parent: "sibling", node: { id: "fresh", type: "RECTANGLE", w: 5, h: 5 } }, setOp("fresh", { w: 9 })), emptyPatchContext() as never);
  assert.equal(mockById(page, "fresh").width, 9);
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


test("TEXT instance override equal to a node id is not remapped to a Figma id", async () => {
  const source = {
    canvas: { id: "screen", width: 300, height: 100, fill: "#FFFFFF" },
    nodes: [
      // A node whose compact id equals the TEXT override value — must stay as text "submit".
      { id: "submit", type: "FRAME", w: 10, h: 10, fill: "#000000" },
      {
        id: "button",
        type: "COMPONENT",
        w: 120,
        h: 40,
        componentProperties: [{ name: "Label", type: "TEXT", defaultValue: "Go" }],
        children: [
          { id: "button-label", type: "TEXT", w: 80, h: 20, text: "Go", componentPropertyReferences: { characters: "Label" } }
        ]
      },
      {
        id: "button-1",
        type: "INSTANCE",
        componentId: "button",
        x: 40,
        w: 120,
        h: 40,
        instanceProperties: { Label: "submit" }
      }
    ]
  };
  const document = normalize(source);
  const context = importContext();
  const page = await importIntoMock(document, context);
  const instance = mockById(page, "button-1");
  const props = instance.componentProperties as Record<string, { type: string; value: string | boolean }>;
  const labelEntry = Object.entries(props).find(([key]) => key.startsWith("Label#") || key === "Label");
  assert.ok(labelEntry, `expected Label property, got ${Object.keys(props).join(",")}`);
  assert.equal(labelEntry![1].value, "submit");
  assert.notEqual(labelEntry![1].value, mockById(page, "submit").id);
});

test("INSTANCE_SWAP default or override naming a missing component throws a clear error", async () => {
  const missingDefault = normalize({
    canvas: { width: 100, height: 100 },
    nodes: [{
      id: "button",
      type: "COMPONENT",
      w: 40,
      h: 40,
      componentProperties: [{ name: "Icon", type: "INSTANCE_SWAP", defaultValue: "ghost-icon" }]
    }]
  });
  await assert.rejects(
    () => importIntoMock(missingDefault),
    /component property 'Icon' references missing component 'ghost-icon'/
  );

  const missingOverride = normalize({
    canvas: { width: 100, height: 100 },
    nodes: [
      { id: "icon", type: "COMPONENT", w: 8, h: 8 },
      {
        id: "button",
        type: "COMPONENT",
        w: 40,
        h: 40,
        componentProperties: [{ name: "Icon", type: "INSTANCE_SWAP", defaultValue: "icon" }]
      },
      { id: "copy", type: "INSTANCE", componentId: "button", w: 40, h: 40, instanceProperties: { Icon: "nope" } }
    ]
  });
  await assert.rejects(
    () => importIntoMock(missingOverride),
    /component property 'Icon' references missing component 'nope'/
  );
});


test("lockstep: newly enabled patch keys match in core and Figma (bindings, styleRefs, variableModes, instanceProperties, componentPropertyReferences)", async () => {
  const source = {
    canvas: { id: "screen", width: 400, height: 200, fill: "#FFFFFF" },
    variables: [{ name: "Theme", modes: ["Light", "Dark"], items: [
      { id: "brand", name: "brand", type: "COLOR", values: { Light: { r: 37, g: 99, b: 235 }, Dark: { r: 96, g: 165, b: 250 } } },
      { id: "gap", name: "gap", type: "FLOAT", values: { Light: 8, Dark: 12 } }
    ] }],
    styles: [{ id: "ink", name: "Ink", type: "PAINT", paints: ["#111111"] }],
    nodes: [
      { id: "icon-star", type: "COMPONENT", name: "Icon/Star", w: 16, h: 16, fill: "#111111" },
      { id: "icon-check", type: "COMPONENT", name: "Icon/Check", w: 16, h: 16, fill: "#16A34A" },
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
        id: "cta",
        type: "INSTANCE",
        componentId: "button",
        x: 20,
        y: 20,
        w: 160,
        h: 48,
        instanceProperties: { Label: "Continue", ShowIcon: true, Icon: "icon-star" }
      },
      { id: "card", type: "FRAME", x: 200, y: 20, w: 120, h: 80, fill: "#FFFFFF", bindings: { fill: "brand" }, variableModes: { Theme: "Light" } }
    ]
  };
  let document = normalize(source);
  assert.equal(validate(source).valid, true);
  const variables = new Map([["brand", { id: "var:brand" }], ["gap", { id: "var:gap" }]]);
  const collections = new Map([["Theme", { id: "col:theme", name: "Theme", modes: [{ name: "Light", modeId: "1" }, { name: "Dark", modeId: "2" }] }]]);
  const paintStyles = new Map([["ink", { id: "style:ink", name: "Ink" }]]);
  const page = await importIntoMock(document, importContext(variables, collections));
  // Seed paint style into resources used by later patches via emptyPatchContext enrichment.
  const ctx = emptyPatchContext();
  ctx.resources.variables = variables as never;
  ctx.resources.variableCollections = collections as never;
  ctx.resources.paintStyles = paintStyles as never;

  const steps = [
    [setOp("cta", { instanceProperties: { Label: "Submit", Icon: "icon-check", ShowIcon: false } })],
    [setOp("button-label", { componentPropertyReferences: { visible: "ShowIcon" } })],
    [setOp("card", { bindings: { opacity: "gap" }, styleRefs: { stroke: "ink" }, variableModes: { Theme: "Dark" } })],
    [setOp("card", { bindings: { fill: null }, fill: "#EEEEEE" })]
  ];
  for (const [index, operations] of steps.entries()) {
    const patch = checkedPatch(...operations);
    const coreResult = applyCorePatch(document, patch);
    document = coreResult.document;
    const figmaResult = await applyFigmaPatch(patch, ctx as never);
    if (index === 3) {
      assert.ok(coreResult.warnings.some((w) => /detached bindings\.fill/.test(w)), "core warns on fill detach");
      assert.ok(figmaResult.warnings.some((w) => /detached bindings\.fill/.test(w)), "Figma warns on fill detach");
    }
  }
  // Core document state for the patched keys.
  const find = (id: string) => {
    const visit = (nodes: InternalNode[]): InternalNode | null => {
      for (const node of nodes) {
        if (node.id === id) return node;
        const nested = visit(node.children);
        if (nested) return nested;
      }
      return null;
    };
    return visit(document.nodes)!;
  };
  assert.deepEqual(find("cta").properties.instanceProperties, { Label: "Submit", Icon: "icon-check", ShowIcon: false });
  assert.deepEqual(find("button-label").properties.componentPropertyReferences, { characters: "Label", visible: "ShowIcon" });
  assert.deepEqual(find("card").properties.bindings, { opacity: "gap" });
  assert.deepEqual(find("card").properties.styleRefs, { stroke: "ink" });
  assert.deepEqual(find("card").properties.variableModes, { Theme: "Dark" });
  // Figma instance overrides reflect authored Label change.
  const instance = mockById(page, "cta");
  const props = instance.componentProperties as Record<string, { type: string; value: string | boolean }>;
  const label = Object.entries(props).find(([key]) => key.startsWith("Label"));
  assert.equal(label?.[1].value, "Submit");
  assert.equal(label?.[1].value, find("cta").properties.instanceProperties?.Label);
});


test("lockstep: instanceProperties null clears to component default in core and Figma", async () => {
  const source = {
    canvas: { width: 300, height: 100, fill: "#FFFFFF" },
    nodes: [
      { id: "icon-star", type: "COMPONENT", name: "Icon/Star", w: 16, h: 16, fill: "#111111" },
      { id: "icon-check", type: "COMPONENT", name: "Icon/Check", w: 16, h: 16, fill: "#16A34A" },
      {
        id: "button",
        type: "COMPONENT",
        name: "Button",
        w: 120,
        h: 40,
        fill: "#2563EB",
        componentProperties: [
          { name: "Label", type: "TEXT", defaultValue: "Continue" },
          { name: "ShowIcon", type: "BOOLEAN", defaultValue: true },
          { name: "Icon", type: "INSTANCE_SWAP", defaultValue: "icon-star" }
        ],
        children: [
          { id: "button-label", type: "TEXT", name: "Label", w: 80, h: 20, text: "Continue", fill: "#FFFFFF", componentPropertyReferences: { characters: "Label" } }
        ]
      },
      {
        id: "cta",
        type: "INSTANCE",
        componentId: "button",
        x: 10,
        y: 10,
        w: 120,
        h: 40,
        instanceProperties: { Label: "Submit", ShowIcon: false, Icon: "icon-check" }
      }
    ]
  };
  let document = normalize(source);
  const page = await importIntoMock(document, importContext());
  const patch = checkedPatch(setOp("cta", { instanceProperties: { Label: null, ShowIcon: null, Icon: null } }));
  const coreResult = applyCorePatch(document, patch);
  document = coreResult.document;
  await applyFigmaPatch(patch, emptyPatchContext() as never);

  const find = (id: string) => {
    const visit = (nodes: InternalNode[]): InternalNode | null => {
      for (const node of nodes) {
        if (node.id === id) return node;
        const nested = visit(node.children);
        if (nested) return nested;
      }
      return null;
    };
    return visit(document.nodes)!;
  };
  // Core deletes cleared keys (empty map becomes undefined) → falls back to component defaults.
  assert.equal(find("cta").properties.instanceProperties, undefined);
  // Figma resets each key to the main component's defaultValue.
  const instance = mockById(page, "cta");
  const props = instance.componentProperties as Record<string, { type: string; value: string | boolean }>;
  const byName = Object.fromEntries(Object.entries(props).map(([key, value]) => [key.includes("#") ? key.slice(0, key.indexOf("#")) : key, value]));
  assert.equal(byName.Label?.value, "Continue", "Label reset to default");
  assert.equal(byName.ShowIcon?.value, true, "ShowIcon reset to default");
  // Icon INSTANCE_SWAP default points at icon-star (Figma id of that COMPONENT).
  const star = mockById(page, "icon-star");
  assert.equal(byName.Icon?.value, star.id, "Icon reset to default COMPONENT");
});

test("rollback after failed COMPONENT patch does not orphan its instances", async () => {
  const source = {
    canvas: { width: 200, height: 100 },
    nodes: [
      { id: "master", type: "COMPONENT", name: "Master", w: 40, h: 40, fill: "#FF0000" },
      { id: "one", type: "INSTANCE", componentId: "master", x: 60, w: 40, h: 40 },
      { id: "two", type: "INSTANCE", componentId: "master", x: 110, w: 40, h: 40 }
    ]
  };
  const document = normalize(source);
  const page = await importIntoMock(document);
  const masterBefore = mockById(page, "master");
  const one = mockById(page, "one");
  const two = mockById(page, "two");
  assert.equal(one.mainComponentId, masterBefore.id);
  assert.equal(two.mainComponentId, masterBefore.id);
  // Fail mid-patch after mutating the COMPONENT (missing font on a TEXT op is not applicable —
  // force failure with an unsupported key on a second op targeting a real node).
  const okFirst = checkedPatch(setOp("master", { fill: "#00FF00", name: "Master renamed" }));
  // Hand Figma an internal patch that appends a rejected key after a successful set.
  const doomed = {
    patch: {
      operations: [
        ...okFirst.patch.operations,
        { op: "SET", id: "master", set: { svg: "<svg/>" }, normalized: {} }
      ]
    }
  } as unknown as InternalPatchDocument;
  await assert.rejects(() => applyFigmaPatch(doomed, emptyPatchContext() as never), /cannot be patched/);
  // svg is rejected at checkSet before write on second op — first op already wrote. Rollback must restore.
  const masterAfter = mockById(page, "master");
  assert.equal(masterAfter.name, "Master", "COMPONENT name restored");
  const oneAfter = mockById(page, "one");
  const twoAfter = mockById(page, "two");
  assert.equal(oneAfter.mainComponentId, masterAfter.id, "instance one still linked");
  assert.equal(twoAfter.mainComponentId, masterAfter.id, "instance two still linked");
  // Instances are not detached.
  assert.ok(await oneAfter.getMainComponentAsync());
  assert.ok(await twoAfter.getMainComponentAsync());
});


test("lockstep: componentProperties add/edit/delete and type change rejected", async () => {
  const source = {
    canvas: { width: 200, height: 80 },
    nodes: [
      { id: "icon", type: "COMPONENT", w: 8, h: 8, fill: "#000" },
      {
        id: "button", type: "COMPONENT", w: 80, h: 32, fill: "#00F",
        componentProperties: [{ name: "Label", type: "TEXT", defaultValue: "Go" }],
        children: [{ id: "label", type: "TEXT", w: 40, h: 16, text: "Go", fill: "#FFF", componentPropertyReferences: { characters: "Label" } }]
      }
    ]
  };
  let document = normalize(source);
  const page = await importIntoMock(document, importContext());
  const ctx = emptyPatchContext();
  const patch = checkedPatch(setOp("button", { componentProperties: { Label: { defaultValue: "Next" }, Icon: { type: "INSTANCE_SWAP", defaultValue: "icon" } } }));
  document = applyCorePatch(document, patch).document;
  await applyFigmaPatch(patch, ctx as never);
  const button = mockById(page, "button");
  const defs = button.componentPropertyDefinitions as Record<string, { type: string; defaultValue: unknown }>;
  const labelKey = Object.keys(defs).find((key) => key.startsWith("Label"));
  assert.equal(defs[labelKey!].defaultValue, "Next");
  assert.ok(Object.values(defs).some((def) => def.type === "INSTANCE_SWAP"));
  await assert.rejects(
    () => applyFigmaPatch(checkedPatch(setOp("button", { componentProperties: { Label: { type: "BOOLEAN", defaultValue: false } } })), ctx as never),
    /type is immutable/
  );
  // Deleting referenced Label fails post-patch validation in core
  assert.equal(validatePatch(document, { patch: { operations: [setOp("button", { componentProperties: { Label: null } })] } }).valid, false);
});

test("lockstep: variantAxes rename rewrites child names and instance VARIANT overrides; core == Figma", async () => {
  const source = {
    canvas: { width: 400, height: 120, fill: "#FFF" },
    nodes: [{
      id: "set", type: "COMPONENT_SET", w: 300, h: 80,
      variantAxes: { State: ["Default", "Hover"] },
      children: [
        { id: "d", type: "COMPONENT", w: 40, h: 20, variant: { State: "Default" }, fill: "#111", componentProperties: [{ name: "Label", type: "TEXT", defaultValue: "A" }] },
        { id: "h", type: "COMPONENT", w: 40, h: 20, variant: { State: "Hover" }, fill: "#222", componentProperties: [{ name: "Label", type: "TEXT", defaultValue: "B" }] }
      ]
    },
    { id: "use", type: "INSTANCE", componentId: "h", x: 10, y: 10, w: 40, h: 20, instanceProperties: { Label: "Hi" } }
    ]
  };
  let document = normalize(source);
  const page = await importIntoMock(document, importContext());
  const use = mockById(page, "use");
  use.componentProperties = {
    ...(use.componentProperties as object),
    State: { type: "VARIANT", value: "Hover" }
  };
  const patch = checkedPatch(setOp("set", {
    variantAxes: { State: { rename: "Status", options: ["Default", "Pressed"], renameOptions: { Hover: "Pressed" } } }
  }));
  document = applyCorePatch(document, patch).document;
  await applyFigmaPatch(patch, emptyPatchContext() as never);
  assert.deepEqual(nodeById(document, "h").properties.variant, { Status: "Pressed" });
  assert.match(nodeById(document, "h").name, /Status=Pressed/);
  assert.deepEqual(nodeById(document, "use").properties.instanceProperties, { Label: "Hi" });
  const hover = mockById(page, "h");
  assert.match(hover.name, /Status=Pressed/);
  const props = use.componentProperties as Record<string, { type: string; value: string | boolean }>;
  assert.equal(props.State, undefined, "old VARIANT axis key removed");
  assert.equal(props.Status?.value, "Pressed", "VARIANT override follows option+axis rename");
  const labelKey = Object.keys(props).find((key) => key.startsWith("Label"));
  assert.equal(props[labelKey!]?.value, "Hi", "non-variant instanceProperties survive");
  assert.ok(hover.name.includes("Status=Pressed"));
  assert.deepEqual(nodeById(document, "set").properties.variantAxes, { Status: ["Default", "Pressed"] });
});

test("lockstep: variantAxes rename does not rewrite instances of other sets", async () => {
  const source = {
    canvas: { width: 400, height: 120 },
    nodes: [
      {
        id: "set-a", type: "COMPONENT_SET", w: 100, h: 40,
        variantAxes: { Size: ["S", "M"] },
        children: [
          { id: "as", type: "COMPONENT", w: 40, h: 20, variant: { Size: "S" } },
          { id: "am", type: "COMPONENT", w: 40, h: 20, variant: { Size: "M" } }
        ]
      },
      {
        id: "set-b", type: "COMPONENT_SET", w: 100, h: 40, x: 120,
        variantAxes: { Size: ["S", "M"] },
        children: [
          { id: "bs", type: "COMPONENT", w: 40, h: 20, variant: { Size: "S" } },
          { id: "bm", type: "COMPONENT", w: 40, h: 20, variant: { Size: "M" } }
        ]
      },
      { id: "ia", type: "INSTANCE", componentId: "as", w: 40, h: 20 },
      { id: "ib", type: "INSTANCE", componentId: "bs", x: 120, w: 40, h: 20 }
    ]
  };
  let document = normalize(source);
  const page = await importIntoMock(document, importContext());
  const ia = mockById(page, "ia");
  const ib = mockById(page, "ib");
  ia.componentProperties = { ...(ia.componentProperties as object), Size: { type: "VARIANT", value: "S" } };
  ib.componentProperties = { ...(ib.componentProperties as object), Size: { type: "VARIANT", value: "S" } };
  const patch = checkedPatch(setOp("set-a", {
    variantAxes: { Size: { options: ["Small", "M"], renameOptions: { S: "Small" } } }
  }));
  document = applyCorePatch(document, patch).document;
  await applyFigmaPatch(patch, emptyPatchContext() as never);
  assert.deepEqual(nodeById(document, "ia").properties.instanceProperties?.Size ?? (ia.componentProperties as Record<string, { value: string }>).Size?.value, "Small");
  assert.equal((ia.componentProperties as Record<string, { value: string }>).Size?.value, "Small");
  assert.equal((ib.componentProperties as Record<string, { value: string }>).Size?.value, "S", "other set instance untouched");
  assert.deepEqual(nodeById(document, "ib").properties.instanceProperties, undefined);
});

test("lockstep: variant null rejected; uncarried option rejected; same-patch child can carry", async () => {
  const source = {
    canvas: { width: 200, height: 80 },
    nodes: [{
      id: "set", type: "COMPONENT_SET", w: 100, h: 40,
      variantAxes: { State: ["Default", "Hover"] },
      children: [
        { id: "d", type: "COMPONENT", w: 40, h: 20, variant: { State: "Default" } },
        { id: "h", type: "COMPONENT", w: 40, h: 20, variant: { State: "Hover" } }
      ]
    }]
  };
  let document = normalize(source);
  const page = await importIntoMock(document, importContext());
  const ctx = emptyPatchContext();
  await assert.rejects(
    () => applyFigmaPatch(checkedPatch(setOp("d", { variant: null as never })), ctx as never),
    /clearing variant|not supported/
  );
  assert.equal(validatePatch(document, { patch: { operations: [setOp("d", { variant: null as never })] } }).valid, false);
  await assert.rejects(
    () => applyFigmaPatch(checkedPatch(setOp("set", { variantAxes: { State: ["Default", "Hover", "Pressed"] } })), ctx as never),
    /not carried by any variant child/
  );
  const patch = checkedPatch(
    setOp("set", { variantAxes: { State: ["Default", "Hover", "Pressed"] } }),
    { op: "append", parent: "set", node: { id: "p", type: "COMPONENT", w: 40, h: 20, variant: { State: "Pressed" } } }
  );
  document = applyCorePatch(document, patch).document;
  await applyFigmaPatch(patch, ctx as never);
  assert.deepEqual(nodeById(document, "set").properties.variantAxes, { State: ["Default", "Hover", "Pressed"] });
  assert.match(mockById(page, "p").name, /State=Pressed/);
});

test("rollback after COMPONENT patch failure re-links instances across pages and calls loadAllPagesAsync first", async () => {
  const master = createMockNode("COMPONENT", "master");
  master.setPluginData("compactDesignId", "master");
  master.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
  const one = master.createInstance();
  one.setPluginData("compactDesignId", "one");
  const two = createMockNode("INSTANCE", "two");
  two.setPluginData("compactDesignId", "two");
  two.mainComponentId = master.id;
  two.getMainComponentAsync = async () => master;
  two.swapComponent = (component: MockNode) => { two.mainComponentId = component.id; };
  const { page, figmaMock } = installFigmaMock([master, one], [[two]]);
  assert.equal((figmaMock as { __loadAllPagesAsyncCalls?: number }).__loadAllPagesAsyncCalls || 0, 0);
  const okFirst = checkedPatch(setOp("master", { fill: "#00FF00", name: "Master renamed" }));
  const doomed = {
    patch: {
      operations: [
        ...okFirst.patch.operations,
        { op: "SET", id: "master", set: { svg: "<svg/>" }, normalized: {} }
      ]
    }
  } as unknown as InternalPatchDocument;
  await assert.rejects(() => applyFigmaPatch(doomed, emptyPatchContext() as never), /cannot be patched/);
  assert.ok(((figmaMock as { __loadAllPagesAsyncCalls?: number }).__loadAllPagesAsyncCalls || 0) >= 1, "loadAllPagesAsync called during rollback");
  assert.equal((figmaMock as { __findAllWithCriteriaBeforeLoad?: boolean }).__findAllWithCriteriaBeforeLoad, undefined, "findAllWithCriteria must not run before loadAllPagesAsync");
  const masterAfter = mockById(page, "master");
  assert.equal(masterAfter.name, "master", "COMPONENT name restored to pre-patch value");
  assert.equal(mockById(page, "one").mainComponentId, masterAfter.id);
  // Instance on the other page was re-linked too
  assert.equal(two.mainComponentId, masterAfter.id);
});

function nodeById(document: InternalDocument, id: string): InternalNode {
  const visit = (nodes: InternalNode[]): InternalNode | null => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const nested = visit(node.children);
      if (nested) return nested;
    }
    return null;
  };
  const found = visit(document.nodes);
  assert.ok(found, id);
  return found!;
}


test("lockstep: duplicate single layer, subtree + same-patch set, ids override", async () => {
  const document = normalize({
    canvas: { id: "page", width: 300, height: 200 },
    nodes: [{ id: "list", type: "FRAME", w: 200, h: 100, children: [
      { id: "card", type: "FRAME", w: 40, h: 40, children: [
        { id: "title", type: "TEXT", w: 20, h: 10, text: "Hi" },
        { id: "icon", type: "RECTANGLE", w: 8, h: 8 }
      ] },
      { id: "other", type: "RECTANGLE", w: 10, h: 10 }
    ] }]
  });
  await assertParity(document, [
    [{ op: "duplicate", id: "other", idSuffix: "-2" }],
    [
      { op: "duplicate", id: "card", idSuffix: "-copy", ids: { card: "card-featured", title: "title-featured" } },
      setOp("title-featured", { text: "Featured" })
    ]
  ]);
});

test("lockstep: duplicate top-level screen keeps x/y and seats after source", async () => {
  const document = normalize({
    canvas: { id: "page", width: 800, height: 600 },
    nodes: [
      { id: "screen-a", type: "FRAME", x: 10, y: 20, w: 100, h: 80, children: [{ id: "btn", type: "RECTANGLE", x: 5, y: 5, w: 20, h: 10 }] },
      { id: "screen-b", type: "FRAME", x: 200, y: 20, w: 100, h: 80, children: [] }
    ]
  });
  await assertParity(document, [[{ op: "duplicate", id: "screen-a", idSuffix: "-2" }]]);
});

test("lockstep: duplicate rejects collision, COMPONENT, INSTANCE parent, bad ids override", async () => {
  const document = normalize({
    canvas: { id: "page", width: 200, height: 200 },
    nodes: [
      { id: "host", type: "FRAME", w: 100, h: 100, children: [
        { id: "card", type: "FRAME", w: 40, h: 40, children: [{ id: "dot", type: "RECTANGLE", w: 4, h: 4 }] },
        { id: "card-2", type: "RECTANGLE", w: 10, h: 10 }
      ] },
      { id: "button", type: "COMPONENT", w: 20, h: 20 },
      { id: "copy", type: "INSTANCE", componentId: "button", w: 20, h: 20 }
    ]
  });
  const page = await importIntoMock(document);
  const before = await figmaState(page);
  await assert.rejects(() => applyFigmaPatch(checkedPatch({ op: "duplicate", id: "card", idSuffix: "-2" }), emptyPatchContext() as never), /already exists/);
  await assert.rejects(() => applyFigmaPatch(checkedPatch({ op: "duplicate", id: "button", idSuffix: "-2" }), emptyPatchContext() as never), /COMPONENT or COMPONENT_SET/);
  await assert.rejects(() => applyFigmaPatch(checkedPatch({ op: "duplicate", id: "card", idSuffix: "-z", parent: "copy" }), emptyPatchContext() as never), /INSTANCE/);
  await assert.rejects(() => applyFigmaPatch(checkedPatch({ op: "duplicate", id: "card", idSuffix: "-z", ids: { ghost: "ghost-2" } }), emptyPatchContext() as never), /not an id in the source subtree/);
  assert.deepEqual(await figmaState(page), before, "rejected duplicates leave the page unchanged");
});

test("lockstep: duplicate rewrites plugin data; rollback removes copy", async () => {
  const document = normalize({
    canvas: { id: "page", width: 200, height: 100 },
    nodes: [{ id: "list", type: "FRAME", w: 100, h: 80, children: [
      { id: "card", type: "FRAME", w: 40, h: 40, children: [{ id: "dot", type: "RECTANGLE", w: 4, h: 4 }] }
    ] }]
  });
  const page = await importIntoMock(document);
  const before = await figmaState(page);
  // Success path: plugin data rewritten
  await applyFigmaPatch(checkedPatch({ op: "duplicate", id: "card", idSuffix: "-2" }), emptyPatchContext() as never);
  assert.ok(mockById(page, "card-2"));
  assert.ok(mockById(page, "dot-2"));
  assert.equal(mockById(page, "card").getPluginData("compactDesignId"), "card");
  // Rollback: later op fails → copy removed, no leftover compact ids
  const page2 = await importIntoMock(document);
  const before2 = await figmaState(page2);
  await assert.rejects(() => applyFigmaPatch(checkedPatch(
    { op: "duplicate", id: "card", idSuffix: "-2" },
    setOp("card-2", { text: "nope" })
  ), emptyPatchContext() as never), /does not apply/);
  assert.deepEqual(await figmaState(page2), before2);
  const leftover: string[] = [];
  const walk = (node: MockNode) => {
    const id = node.getPluginData("compactDesignId");
    if (id) leftover.push(id);
    node.children.forEach(walk);
  };
  page2.children.forEach(walk);
  assert.deepEqual(leftover.sort(), ["card", "dot", "list", "page"].sort());
});

test("lockstep: duplicate with INSTANCE child keeps componentId", async () => {
  const document = normalize({
    canvas: { id: "page", width: 200, height: 100 },
    nodes: [
      { id: "button", type: "COMPONENT", w: 20, h: 20 },
      { id: "wrap", type: "FRAME", w: 80, h: 40, children: [
        { id: "inst", type: "INSTANCE", componentId: "button", w: 20, h: 20 }
      ] }
    ]
  });
  const final = await assertParity(document, [[{ op: "duplicate", id: "wrap", idSuffix: "-2" }]]);
  assert.equal(nodeById(final, "inst-2").properties.componentId, "button");
});

test("Figma duplicate reuses imageHash on cloned IMAGE fills (no re-upload)", async () => {
  const list = createMockNode("FRAME", "list");
  list.setPluginData("compactDesignId", "list");
  const photo = createMockNode("RECTANGLE", "photo");
  photo.setPluginData("compactDesignId", "photo");
  photo.fills = [{ type: "IMAGE", imageHash: "hash-xyz", scaleMode: "FILL" }];
  list.appendChild(photo);
  installFigmaMock([list]);
  await applyFigmaPatch(checkedPatch({ op: "duplicate", id: "photo", idSuffix: "-2" }), emptyPatchContext() as never);
  const copy = mockById(list.parent as MockNode, "photo-2");
  // list's parent is the mock page from installFigmaMock — resolve via find on list's siblings or walk from list.parent
  const copyFills = (mockById((globalThis as { figma: { currentPage: MockNode } }).figma.currentPage, "photo-2").fills as Array<{ imageHash?: string }>);
  assert.equal(copyFills[0]?.imageHash, "hash-xyz");
});


test("lockstep: duplicate into a different parent keeps parent-relative x/y", async () => {
  // Gate repro: A at (0,0) with box at (10,10); B at (300,100). Duplicate box into B → relative (10,10) inside B.
  const document = normalize({
    canvas: { id: "page", width: 800, height: 400 },
    nodes: [
      { id: "A", type: "FRAME", x: 0, y: 0, w: 100, h: 100, children: [
        { id: "box", type: "RECTANGLE", x: 10, y: 10, w: 20, h: 20 }
      ] },
      { id: "B", type: "FRAME", x: 300, y: 100, w: 100, h: 100, children: [] }
    ]
  });
  const final = await assertParity(document, [[{ op: "duplicate", id: "box", idSuffix: "-2", parent: "B" }]]);
  const box2 = nodeById(final, "box-2");
  // Core stores absolute: B(300,100) + relative(10,10) = (310,110)
  assert.deepEqual(box2.properties.position, { x: 310, y: 110 });
  const page = await importIntoMock(document);
  await applyFigmaPatch(checkedPatch({ op: "duplicate", id: "box", idSuffix: "-2", parent: "B" }), emptyPatchContext() as never);
  const figmaCopy = mockById(page, "box-2");
  assert.equal(figmaCopy.parent && (figmaCopy.parent as MockNode).getPluginData("compactDesignId"), "B");
  assert.deepEqual({ x: figmaCopy.x, y: figmaCopy.y }, { x: 10, y: 10 }, "Figma keeps parent-relative x/y after reparent");
});


test("lockstep: patch set prototype NAVIGATE, clear, missing dest, same-patch dest", async () => {
  const document = normalize({
    canvases: [
      { id: "home", width: 200, height: 100, nodes: [{ id: "cta", type: "FRAME", w: 40, h: 20 }] },
      { id: "checkout", width: 200, height: 100, nodes: [] }
    ]
  });
  await assertParity(document, [
    [setOp("cta", { prototype: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NAVIGATE", destination: "checkout", transition: { type: "DISSOLVE", easing: "EASE_OUT", duration: 0.3 } }] }] })],
    [setOp("cta", { prototype: [] })]
  ]);
  const page = await importIntoMock(document);
  await assert.rejects(() => applyFigmaPatch(checkedPatch(setOp("cta", {
    prototype: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NAVIGATE", destination: "ghost" }] }]
  })), emptyPatchContext() as never), /was not found/);

  await assertParity(document, [[
    { op: "duplicate", id: "checkout", idSuffix: "-2" },
    setOp("cta", { prototype: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NAVIGATE", destination: "checkout-2" }] }] })
  ]]);
});

test("lockstep: non-top-level NAVIGATE destination is rejected", async () => {
  const document = normalize({
    canvas: { id: "page", width: 400, height: 200 },
    nodes: [
      { id: "cta", type: "FRAME", w: 40, h: 20 },
      { id: "panel", type: "FRAME", x: 100, w: 40, h: 40 }
    ]
  });
  const page = await importIntoMock(document);
  await assert.rejects(() => applyFigmaPatch(checkedPatch(setOp("cta", {
    prototype: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NAVIGATE", destination: "panel" }] }]
  })), emptyPatchContext() as never), /must be a top-level frame/);
});

test("lockstep: prototype CHANGE_TO non-COMPONENT and SCROLL_TO across canvases", async () => {
  const document = normalize({
    canvases: [
      { id: "screen-a", width: 100, height: 80, nodes: [
        { id: "btn", type: "FRAME", w: 20, h: 10 },
        { id: "panel", type: "FRAME", w: 40, h: 40 }
      ] },
      { id: "screen-b", width: 100, height: 80, nodes: [{ id: "other", type: "FRAME", w: 20, h: 10 }] }
    ]
  });
  const page = await importIntoMock(document);
  await assert.rejects(() => applyFigmaPatch(checkedPatch(setOp("btn", {
    prototype: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "CHANGE_TO", destination: "panel" }] }]
  })), emptyPatchContext() as never), /CHANGE_TO destination/);
  await assert.rejects(() => applyFigmaPatch(checkedPatch(setOp("btn", {
    prototype: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "SCROLL_TO", destination: "other" }] }]
  })), emptyPatchContext() as never), /SCROLL_TO destination|same top-level canvas/);
});

test("lockstep: end-of-patch remove of prototype destination fails", async () => {
  const document = normalize({
    canvases: [
      { id: "home", width: 200, height: 100, nodes: [{ id: "cta", type: "FRAME", w: 40, h: 20 }] },
      { id: "checkout", width: 200, height: 100, nodes: [] }
    ]
  });
  const seeded = applyCorePatch(document, checkedPatch(setOp("cta", {
    prototype: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NAVIGATE", destination: "checkout" }] }]
  }))).document;
  const core = validatePatch(seeded, { patch: { operations: [{ op: "remove", id: "checkout" }] } });
  assert.equal(core.valid, false);
  assert.match(core.issues.map((i) => i.message).join("\n"), /was not found/);

  const page = await importIntoMock(document);
  await applyFigmaPatch(checkedPatch(setOp("cta", {
    prototype: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NAVIGATE", destination: "checkout" }] }]
  })), emptyPatchContext() as never);
  assert.ok((mockById(page, "cta").reactions as unknown[]).length >= 1);
  const before = await figmaState(page);
  await assert.rejects(() => applyFigmaPatch(checkedPatch({ op: "remove", id: "checkout" }), emptyPatchContext() as never), /no longer exists|was not found/);
  assert.deepEqual(await figmaState(page), before);
});

test("Figma prototype AFTER_TIMEOUT only on top-level; multi-action WARNING; rollback", async () => {
  const document = normalize({
    canvases: [
      { id: "screen", width: 300, height: 200, nodes: [{ id: "child", type: "FRAME", w: 20, h: 10 }] },
      { id: "next", width: 100, height: 80, nodes: [] }
    ]
  });
  const page = await importIntoMock(document);
  await assert.rejects(() => applyFigmaPatch(checkedPatch(setOp("child", {
    prototype: [{ trigger: { type: "AFTER_TIMEOUT", timeout: 2 }, actions: [{ type: "NAVIGATE", destination: "next" }] }]
  })), emptyPatchContext() as never), /AFTER_TIMEOUT.*top-level/);

  await applyFigmaPatch(checkedPatch(setOp("screen", {
    prototype: [{ trigger: { type: "AFTER_TIMEOUT", timeout: 2 }, actions: [{ type: "NAVIGATE", destination: "next" }] }]
  })), emptyPatchContext() as never);
  assert.ok((mockById(page, "screen").reactions as unknown[]).length >= 1);

  // Multi-action plan-limit WARNING (ON_CLICK on nested is fine)
  const page2 = await importIntoMock(document);
  const warned = await applyFigmaPatch(checkedPatch(setOp("child", {
    prototype: [{ trigger: { type: "ON_CLICK" }, actions: [
      { type: "NAVIGATE", destination: "next" },
      { type: "URL", url: "https://example.com" }
    ] }]
  })), emptyPatchContext() as never);
  assert.ok(warned.warnings.some((w) => /one action per reaction/i.test(w)), warned.warnings.join("; "));

  // Rollback: top-level AFTER_TIMEOUT then a failing later op leaves reactions untouched
  const page3 = await importIntoMock(document);
  await applyFigmaPatch(checkedPatch(setOp("screen", {
    prototype: [{ trigger: { type: "AFTER_TIMEOUT", timeout: 1 }, actions: [{ type: "NAVIGATE", destination: "next" }] }]
  })), emptyPatchContext() as never);
  const beforeFail = JSON.stringify(mockById(page3, "screen").reactions);
  await assert.rejects(() => applyFigmaPatch(checkedPatch(
    setOp("screen", { prototype: [{ trigger: { type: "AFTER_TIMEOUT", timeout: 9 }, actions: [{ type: "NAVIGATE", destination: "next" }] }] }),
    setOp("screen", { text: "nope" })
  ), emptyPatchContext() as never), /does not apply/);
  assert.equal(JSON.stringify(mockById(page3, "screen").reactions), beforeFail, "rollback restores prior reactions");
});

test("lockstep: prototype set→export→set is idempotent (transition easing preserved)", async () => {
  const document = normalize({
    canvases: [
      { id: "a", width: 100, height: 80, nodes: [] },
      { id: "b", width: 100, height: 80, nodes: [] }
    ]
  });
  const reaction = [{
    trigger: { type: "ON_CLICK" },
    actions: [{ type: "NAVIGATE", destination: "b", transition: { type: "SMART_ANIMATE", easing: "GENTLE", duration: 0.45 }, resetScrollPosition: true }]
  }];
  const once = applyCorePatch(document, checkedPatch(setOp("a", { prototype: reaction }))).document;
  const exported = nodeById(once, "a").properties.prototype;
  const twice = applyCorePatch(once, checkedPatch(setOp("a", { prototype: exported as unknown[] }))).document;
  assert.deepEqual(nodeById(twice, "a").properties.prototype, exported);

  const page = await importIntoMock(document);
  (mockById(page, "a") as MockNode & { __allowMultiAction?: boolean }).__allowMultiAction = true;
  await applyFigmaPatch(checkedPatch(setOp("a", { prototype: reaction })), emptyPatchContext() as never);
  const first = JSON.stringify(mockById(page, "a").reactions);
  await applyFigmaPatch(checkedPatch(setOp("a", { prototype: reaction })), emptyPatchContext() as never);
  assert.equal(JSON.stringify(mockById(page, "a").reactions), first);
});

test("componentId remains rejected while prototype is patchable", async () => {
  const document = normalize({
    canvas: { id: "page", width: 100, height: 100 },
    nodes: [{ id: "box", type: "FRAME", w: 20, h: 20 }]
  });
  const page = await importIntoMock(document);
  const raw = { patch: { operations: [{ op: "SET", id: "box", set: { componentId: "x" }, normalized: {} }] } } as unknown as InternalPatchDocument;
  await assert.rejects(() => applyFigmaPatch(raw, emptyPatchContext() as never), /cannot be patched/);
  await applyFigmaPatch(checkedPatch(setOp("box", { prototype: [] })), emptyPatchContext() as never);
});

// --- Patch resource upsert (variables / styles) -----------------------------

test("Figma patch upsert: create collection/variable/style then rollback removes them", async () => {
  const document = normalize({
    canvas: { id: "screen", width: 200, height: 100 },
    nodes: [{ id: "cta", type: "RECTANGLE", w: 40, h: 20, fill: "#ff0000" }]
  });
  const page = await importIntoMock(document);
  const ctx = emptyPatchContext();
  const api = (globalThis as { figma: { _variables: MockVariable[]; _variableCollections: MockVariableCollection[]; _paintStyles: MockStyle[]; _textStyles: MockStyle[] } }).figma;

  await assert.rejects(
    () => applyFigmaPatch(normalizePatch({
      variables: [{ name: "Theme", modes: ["Light"], items: [{ id: "brand", name: "color/brand", type: "COLOR", values: { Light: { r: 1, g: 0, b: 0, a: 1 } } }] }],
      styles: [{ id: "heading", name: "Heading", type: "TEXT", font: { family: "Inter", style: "Bold", size: 44 } }],
      patch: { operations: [
        { op: "set", id: "cta", set: { bindings: { fill: "brand" } } },
        { op: "set", id: "cta", set: { text: "nope" } }
      ] }
    }), ctx as never),
    /does not apply|text/
  );

  assert.equal(api._variableCollections.filter((c) => !c.removed).length, 0, "collections rolled back");
  assert.equal(api._variables.filter((v) => !v.removed).length, 0, "variables rolled back");
  assert.equal(api._textStyles.filter((s) => !s.removed).length, 0, "styles rolled back");
  assert.equal(mockById(page, "cta").getPluginData("compactDesignId"), "cta");
});

test("Figma patch upsert: update then fail restores per-mode values", async () => {
  const document = normalize({
    canvas: { id: "screen", width: 200, height: 100 },
    nodes: [{ id: "cta", type: "RECTANGLE", w: 40, h: 20, fill: "#ffffff" }]
  });
  const page = await importIntoMock(document);
  const ctx = emptyPatchContext();
  const api = (globalThis as { figma: {
    _variables: MockVariable[];
    _variableCollections: MockVariableCollection[];
    variables: { createVariableCollection: (n: string) => MockVariableCollection; createVariable: (n: string, c: MockVariableCollection, t: string) => MockVariable };
  } }).figma;

  // Seed an existing collection/variable outside the patch path.
  const collection = api.variables.createVariableCollection("Theme");
  collection.renameMode(collection.modes[0].modeId, "Light");
  collection.addMode("Dark");
  const variable = api.variables.createVariable("color/brand", collection, "COLOR");
  variable.setPluginData("compactDesignId", "brand");
  variable.setValueForMode(collection.modes[0].modeId, { r: 1, g: 0, b: 0, a: 1 });
  variable.setValueForMode(collection.modes[1].modeId, { r: 0, g: 0, b: 1, a: 1 });
  ctx.resources.variableCollections.set("Theme", collection as never);
  ctx.resources.variableCollections.set(collection.id, collection as never);
  ctx.resources.variables.set("brand", variable as never);
  ctx.resources.variables.set("color/brand", variable as never);

  const beforeLight = { ...(variable.valuesByMode[collection.modes[0].modeId] as object) };
  const beforeDark = { ...(variable.valuesByMode[collection.modes[1].modeId] as object) };

  await assert.rejects(
    () => applyFigmaPatch(normalizePatch({
      variables: [{ name: "Theme", items: [{ id: "brand", name: "color/brand", type: "COLOR", values: { Light: { r: 0.2, g: 0.3, b: 0.4, a: 1 } } }] }],
      patch: { operations: [
        { op: "set", id: "cta", set: { bindings: { fill: "brand" } } },
        { op: "set", id: "missing", set: { name: "x" } }
      ] }
    }), ctx as never),
    /was not found|missing/
  );

  assert.deepEqual(variable.valuesByMode[collection.modes[0].modeId], beforeLight);
  assert.deepEqual(variable.valuesByMode[collection.modes[1].modeId], beforeDark);
  assert.ok(page);
});

test("Figma patch upsert: mode add + TEXT style merge then fail restores both exactly", async () => {
  const document = normalize({
    canvas: { id: "screen", width: 200, height: 100 },
    nodes: [{ id: "cta", type: "RECTANGLE", w: 40, h: 20, fill: "#ffffff" }]
  });
  await importIntoMock(document);
  const ctx = emptyPatchContext();
  const api = (globalThis as { figma: {
    _modeLimit?: number;
    createTextStyle: () => MockStyle;
    variables: { createVariableCollection: (n: string) => MockVariableCollection; createVariable: (n: string, c: MockVariableCollection, t: string) => MockVariable };
    _variableCollections: MockVariableCollection[];
    _variables: MockVariable[];
    _textStyles: MockStyle[];
  } }).figma;

  const collection = api.variables.createVariableCollection("Theme");
  collection.renameMode(collection.modes[0].modeId, "Light");
  const variable = api.variables.createVariable("gap", collection, "FLOAT");
  variable.setPluginData("compactDesignId", "gap");
  variable.setValueForMode(collection.modes[0].modeId, 8);
  ctx.resources.variableCollections.set("Theme", collection as never);
  ctx.resources.variableCollections.set(collection.id, collection as never);
  ctx.resources.variables.set("gap", variable as never);

  const style = api.createTextStyle();
  style.name = "Heading";
  style.setPluginData("compactDesignId", "heading");
  style.fontName = { family: "Inter", style: "Bold" };
  style.fontSize = 32;
  style.paragraphSpacing = 4;
  ctx.resources.textStyles.set("heading", style as never);
  ctx.resources.textStyles.set("Heading", style as never);

  const modeNamesBefore = collection.modes.map((mode) => mode.name);
  const gapBefore = variable.valuesByMode[collection.modes[0].modeId];
  const fontBefore = { ...style.fontName };
  const sizeBefore = style.fontSize;
  const paraBefore = style.paragraphSpacing;

  await assert.rejects(
    () => applyFigmaPatch(normalizePatch({
      variables: [{ name: "Theme", modes: ["Light", "Dark"], items: [{ id: "gap", name: "gap", type: "FLOAT", values: { Dark: 16 } }] }],
      styles: [{ id: "heading", name: "Heading", type: "TEXT", font: { size: 44 } }],
      patch: { operations: [
        { op: "set", id: "cta", set: { name: "CTA" } },
        { op: "set", id: "ghost", set: { name: "nope" } }
      ] }
    }), ctx as never),
    /was not found|ghost/
  );

  assert.deepEqual(collection.modes.map((mode) => mode.name), modeNamesBefore, "mode list restored");
  assert.equal(variable.valuesByMode[collection.modes[0].modeId], gapBefore);
  assert.deepEqual(style.fontName, fontBefore);
  assert.equal(style.fontSize, sizeBefore);
  assert.equal(style.paragraphSpacing, paraBefore);
});

test("Figma patch upsert: modes[0] never renamed; created styles carry compactDesignId; plan-limit WARNING", async () => {
  const document = normalize({
    canvas: { id: "screen", width: 200, height: 100 },
    nodes: [{ id: "cta", type: "RECTANGLE", w: 40, h: 20, fill: "#ffffff" }]
  });
  await importIntoMock(document);
  const ctx = emptyPatchContext();
  const api = (globalThis as { figma: {
    _modeLimit?: number;
    createTextStyle: () => MockStyle;
    variables: { createVariableCollection: (n: string) => MockVariableCollection; createVariable: (n: string, c: MockVariableCollection, t: string) => MockVariable };
    _textStyles: MockStyle[];
    _variableCollections: MockVariableCollection[];
  } }).figma;

  const collection = api.variables.createVariableCollection("Theme");
  collection.renameMode(collection.modes[0].modeId, "Light");
  const variable = api.variables.createVariable("x", collection, "FLOAT");
  variable.setPluginData("compactDesignId", "x");
  variable.setValueForMode(collection.modes[0].modeId, 1);
  ctx.resources.variableCollections.set("Theme", collection as never);
  ctx.resources.variableCollections.set(collection.id, collection as never);
  ctx.resources.variables.set("x", variable as never);

  const { warnings } = await applyFigmaPatch(normalizePatch({
    variables: [{ name: "Theme", modes: ["Dark"], items: [{ id: "x", name: "x", type: "FLOAT", values: { Dark: 2 } }] }],
    styles: [{ id: "heading", name: "Heading", type: "TEXT", font: { family: "Inter", style: "Bold", size: 20 } }],
    patch: { operations: [{ op: "set", id: "cta", set: { name: "CTA" } }] }
  }), ctx as never);

  assert.equal(collection.modes[0].name, "Light", "mode 0 not renamed");
  assert.ok(collection.modes.some((mode) => mode.name === "Dark"));
  const created = api._textStyles.find((style) => style.name === "Heading" && !style.removed);
  assert.ok(created);
  assert.equal(created!.getPluginData("compactDesignId"), "heading");

  // Plan-limit path: limit to 1 mode on a fresh collection via import-style create.
  api._modeLimit = 1;
  const ctx2 = emptyPatchContext();
  const result2 = await applyFigmaPatch(normalizePatch({
    variables: [{ name: "Limited", modes: ["A", "B"], items: [{ id: "y", name: "y", type: "FLOAT", values: { A: 1 } }] }],
    patch: { operations: [{ op: "set", id: "cta", set: { opacity: 0.9 } }] }
  }), ctx2 as never);
  assert.ok(result2.warnings.some((warning) => /Limited|omitted B|mode/i.test(warning)), result2.warnings.join("; "));
  assert.ok(warnings || true);
});

test("lockstep: resource upsert conflicts agree in core and Figma", async () => {
  const document = normalize({
    canvas: { id: "screen", width: 100, height: 100 },
    nodes: [{ id: "cta", type: "RECTANGLE", w: 10, h: 10, fill: "#fff" }],
    variables: [{ name: "Theme", modes: ["Light"], items: [{ id: "brand", name: "color/brand", type: "COLOR", values: { Light: { r: 1, g: 0, b: 0, a: 1 } } }] }],
    styles: [{ id: "ink", name: "Ink", type: "PAINT", paints: ["#111"] }]
  });

  const cases: Array<{ label: string; patch: unknown; pattern: RegExp }> = [
    {
      label: "type conflict",
      patch: {
        variables: [{ name: "Theme", items: [{ name: "color/brand", type: "FLOAT", value: 1 }] }],
        patch: { operations: [{ op: "set", id: "cta", set: { name: "x" } }] }
      },
      pattern: /PATCH_RESOURCE_CONFLICT|already exists.*FLOAT|type/
    },
    {
      label: "id/name mismatch",
      patch: {
        variables: [{ name: "Theme", items: [{ id: "brand", name: "color/other", type: "COLOR", value: { r: 0, g: 1, b: 0, a: 1 } }] }],
        patch: { operations: [{ op: "set", id: "cta", set: { name: "x" } }] }
      },
      pattern: /cannot rename|PATCH_RESOURCE_CONFLICT/
    },
    {
      label: "unknown mode",
      patch: {
        variables: [{ name: "Theme", items: [{ id: "brand", name: "color/brand", type: "COLOR", values: { Dark: { r: 0, g: 0, b: 1, a: 1 } } }] }],
        patch: { operations: [{ op: "set", id: "cta", set: { name: "x" } }] }
      },
      pattern: /mode 'Dark'|PATCH_RESOURCE_INVALID/
    },
    {
      label: "style type conflict",
      patch: {
        styles: [{ id: "ink", name: "Ink", type: "TEXT", font: { family: "Inter", style: "Bold", size: 12 } }],
        patch: { operations: [{ op: "set", id: "cta", set: { name: "x" } }] }
      },
      pattern: /PATCH_RESOURCE_CONFLICT|type TEXT|type PAINT|already exists/
    }
  ];

  for (const entry of cases) {
    const core = validatePatch(document, entry.patch);
    assert.equal(core.valid, false, entry.label);
    assert.match(core.issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n"), entry.pattern, entry.label);

    await importIntoMock(normalize({
      canvas: { id: "screen", width: 100, height: 100 },
      nodes: [{ id: "cta", type: "RECTANGLE", w: 10, h: 10, fill: "#fff" }]
    }));
    const ctx = emptyPatchContext();
    const api = (globalThis as { figma: {
      variables: { createVariableCollection: (n: string) => MockVariableCollection; createVariable: (n: string, c: MockVariableCollection, t: string) => MockVariable };
      createPaintStyle: () => MockStyle;
    } }).figma;
    const collection = api.variables.createVariableCollection("Theme");
    collection.renameMode(collection.modes[0].modeId, "Light");
    const variable = api.variables.createVariable("color/brand", collection, "COLOR");
    variable.setPluginData("compactDesignId", "brand");
    variable.setValueForMode(collection.modes[0].modeId, { r: 1, g: 0, b: 0, a: 1 });
    ctx.resources.variableCollections.set("Theme", collection as never);
    ctx.resources.variableCollections.set(collection.id, collection as never);
    ctx.resources.variables.set("brand", variable as never);
    ctx.resources.variables.set("color/brand", variable as never);
    const paint = api.createPaintStyle();
    paint.name = "Ink";
    paint.setPluginData("compactDesignId", "ink");
    ctx.resources.paintStyles.set("ink", paint as never);
    ctx.resources.paintStyles.set("Ink", paint as never);

    await assert.rejects(
      () => applyFigmaPatch(normalizePatch(entry.patch), ctx as never),
      entry.pattern,
      entry.label
    );
  }

  // Shared match helpers
  assert.equal(matchStyle([{ id: "a", name: "A", type: "PAINT", paints: [] }], { id: "a", name: "Other" })?.by, "id");
  assert.equal(matchVariable([{ id: "v", name: "n", type: "FLOAT" }], { id: "v", name: "other" })?.by, "id");
  assert.ok(applyResourceUpsert);
});

test("Figma patch upsert: successful create + bind round-trip", async () => {
  const document = normalize({
    canvas: { id: "screen", width: 200, height: 100 },
    nodes: [{ id: "cta", type: "RECTANGLE", w: 40, h: 20, fill: "#ff0000" }]
  });
  const page = await importIntoMock(document);
  const ctx = emptyPatchContext();
  await applyFigmaPatch(normalizePatch({
    variables: [{ name: "Theme", modes: ["Light", "Dark"], items: [{ id: "brand", name: "color/brand", type: "COLOR", values: { Light: { r: 214, g: 92, b: 40, a: 1 }, Dark: { r: 255, g: 140, b: 90, a: 1 } } }] }],
    styles: [{ id: "heading", name: "Heading", type: "TEXT", font: { family: "Inter", style: "Bold", size: 44 } }],
    patch: { operations: [
      { op: "set", id: "cta", set: { bindings: { fill: "brand" } } },
      { op: "set", id: "screen", set: { variableModes: { Theme: "Dark" } } }
    ] }
  }), ctx as never);

  assert.ok(ctx.resources.variables.get("brand"), "brand visible in resources");
  assert.ok(ctx.resources.textStyles.get("heading"), "heading style keyed by compact id");
  assert.equal((ctx.resources.textStyles.get("heading") as { getPluginData: (k: string) => string }).getPluginData("compactDesignId"), "heading");
  const cta = mockById(page, "cta");
  assert.ok(cta.fills && Array.isArray(cta.fills) && (cta.fills[0] as { boundVariables?: unknown }).boundVariables, "fill bound");
});

test("Gate #45.1 lockstep: token-only patch with empty operations (core + Figma)", async () => {
  const document = normalize({
    canvas: { id: "screen", width: 200, height: 100 },
    nodes: [{ id: "cta", type: "RECTANGLE", w: 40, h: 20, fill: "#ffffff" }]
  });
  const page = await importIntoMock(document);
  const ctx = emptyPatchContext();
  const api = (globalThis as { figma: {
    variables: { createVariableCollection: (n: string) => MockVariableCollection; createVariable: (n: string, c: MockVariableCollection, t: string) => MockVariable };
  } }).figma;
  const collection = api.variables.createVariableCollection("Theme");
  collection.renameMode(collection.modes[0].modeId, "Light");
  const variable = api.variables.createVariable("color/brand", collection, "COLOR");
  variable.setPluginData("compactDesignId", "brand");
  variable.setValueForMode(collection.modes[0].modeId, { r: 1, g: 0, b: 0, a: 1 });
  ctx.resources.variableCollections.set("Theme", collection as never);
  ctx.resources.variableCollections.set(collection.id, collection as never);
  ctx.resources.variables.set("brand", variable as never);

  const patch = {
    variables: [{ name: "Theme", items: [{ id: "brand", name: "color/brand", type: "COLOR", values: { Light: { r: 0.2, g: 0.3, b: 0.4, a: 1 } } }] }],
    patch: { operations: [] }
  };
  const coreDoc = normalize({
    canvas: { id: "screen", width: 200, height: 100 },
    nodes: [{ id: "cta", type: "RECTANGLE", w: 40, h: 20, fill: "#ffffff" }],
    variables: [{ name: "Theme", modes: ["Light"], items: [{ id: "brand", name: "color/brand", type: "COLOR", values: { Light: { r: 1, g: 0, b: 0, a: 1 } } }] }]
  });
  const core = validatePatch(coreDoc, patch);
  assert.equal(core.valid, true, core.issues.map((issue) => issue.message).join("; "));

  await applyFigmaPatch(normalizePatch(patch), ctx as never);
  assert.deepEqual(variable.valuesByMode[collection.modes[0].modeId], { r: 0.2, g: 0.3, b: 0.4, a: 1 });
  assert.ok(page);
});

test("Gate #45.2 lockstep: name match with different id conflicts in both engines", async () => {
  const document = normalize({
    canvas: { id: "screen", width: 100, height: 100 },
    nodes: [{ id: "cta", type: "RECTANGLE", w: 10, h: 10, fill: "#fff" }],
    styles: [{ id: "heading", name: "Heading", type: "TEXT", font: { family: "Inter", style: "Bold", size: 32 } }],
    variables: [{ name: "Theme", modes: ["Light"], items: [{ id: "brand", name: "color/brand", type: "COLOR", values: { Light: { r: 1, g: 0, b: 0, a: 1 } } }] }]
  });
  const stylePatch = {
    styles: [{ id: "h2", name: "Heading", type: "TEXT", font: { size: 44 } }],
    patch: { operations: [] }
  };
  const coreStyle = validatePatch(document, stylePatch);
  assert.equal(coreStyle.valid, false);
  assert.equal(coreStyle.issues[0].code, "PATCH_RESOURCE_CONFLICT");

  await importIntoMock(normalize({
    canvas: { id: "screen", width: 100, height: 100 },
    nodes: [{ id: "cta", type: "RECTANGLE", w: 10, h: 10, fill: "#fff" }]
  }));
  const ctx = emptyPatchContext();
  const api = (globalThis as { figma: { createTextStyle: () => MockStyle; variables: { createVariableCollection: (n: string) => MockVariableCollection; createVariable: (n: string, c: MockVariableCollection, t: string) => MockVariable } } }).figma;
  const style = api.createTextStyle();
  style.name = "Heading";
  style.setPluginData("compactDesignId", "heading");
  style.fontName = { family: "Inter", style: "Bold" };
  style.fontSize = 32;
  ctx.resources.textStyles.set("heading", style as never);
  ctx.resources.textStyles.set("Heading", style as never);

  await assert.rejects(
    () => applyFigmaPatch(normalizePatch(stylePatch), ctx as never),
    /already has id 'heading'|PATCH_RESOURCE_CONFLICT/
  );
  assert.equal(style.getPluginData("compactDesignId"), "heading", "Figma must not overwrite compactDesignId");

  const varPatch = {
    variables: [{ name: "Theme", items: [{ id: "brand2", name: "color/brand", type: "COLOR", value: { r: 0, g: 1, b: 0, a: 1 } }] }],
    patch: { operations: [] }
  };
  assert.equal(validatePatch(document, varPatch).valid, false);
  const collection = api.variables.createVariableCollection("Theme");
  collection.renameMode(collection.modes[0].modeId, "Light");
  const variable = api.variables.createVariable("color/brand", collection, "COLOR");
  variable.setPluginData("compactDesignId", "brand");
  variable.setValueForMode(collection.modes[0].modeId, { r: 1, g: 0, b: 0, a: 1 });
  ctx.resources.variableCollections.set("Theme", collection as never);
  ctx.resources.variableCollections.set(collection.id, collection as never);
  ctx.resources.variables.set("brand", variable as never);
  ctx.resources.variables.set("color/brand", variable as never);
  await assert.rejects(
    () => applyFigmaPatch(normalizePatch(varPatch), ctx as never),
    /already has id 'brand'|PATCH_RESOURCE_CONFLICT/
  );
  assert.equal(variable.getPluginData("compactDesignId"), "brand");
});

test("Gate #45.3 lockstep: duplicate variable id across collections rejected in both engines", async () => {
  const document = normalize({
    canvas: { id: "screen", width: 100, height: 100 },
    nodes: [{ id: "cta", type: "RECTANGLE", w: 10, h: 10, fill: "#fff" }],
    variables: [{ name: "Theme", modes: ["Light"], items: [{ id: "brand", name: "color/brand", type: "COLOR", values: { Light: { r: 1, g: 0, b: 0, a: 1 } } }] }]
  });
  const patch = {
    variables: [{ name: "Other", modes: ["Light"], items: [{ id: "brand", name: "other/brand", type: "COLOR", values: { Light: { r: 0, g: 1, b: 0, a: 1 } } }] }],
    patch: { operations: [] }
  };
  const core = validatePatch(document, patch);
  assert.equal(core.valid, false);
  assert.equal(core.issues[0].code, "PATCH_RESOURCE_CONFLICT");

  await importIntoMock(normalize({
    canvas: { id: "screen", width: 100, height: 100 },
    nodes: [{ id: "cta", type: "RECTANGLE", w: 10, h: 10, fill: "#fff" }]
  }));
  const ctx = emptyPatchContext();
  const api = (globalThis as { figma: { variables: { createVariableCollection: (n: string) => MockVariableCollection; createVariable: (n: string, c: MockVariableCollection, t: string) => MockVariable }; _variableCollections: MockVariableCollection[]; _variables: MockVariable[] } }).figma;
  const collection = api.variables.createVariableCollection("Theme");
  collection.renameMode(collection.modes[0].modeId, "Light");
  const variable = api.variables.createVariable("color/brand", collection, "COLOR");
  variable.setPluginData("compactDesignId", "brand");
  variable.setValueForMode(collection.modes[0].modeId, { r: 1, g: 0, b: 0, a: 1 });
  ctx.resources.variableCollections.set("Theme", collection as never);
  ctx.resources.variableCollections.set(collection.id, collection as never);
  ctx.resources.variables.set("brand", variable as never);
  ctx.resources.variables.set("color/brand", variable as never);

  await assert.rejects(
    () => applyFigmaPatch(normalizePatch(patch), ctx as never),
    /already used by|PATCH_RESOURCE_CONFLICT/
  );
  assert.equal(api._variableCollections.filter((c) => !c.removed && c.name === "Other").length, 0, "Other collection rolled back");
});

test("Gate #45.4 lockstep: incomplete new variable fails in plan before mutation", async () => {
  const document = normalize({
    canvas: { id: "screen", width: 100, height: 100 },
    nodes: [{ id: "cta", type: "RECTANGLE", w: 10, h: 10, fill: "#fff" }],
    variables: [{ name: "Theme", modes: ["Light", "Dark"], items: [{ id: "keep", name: "keep", type: "FLOAT", values: { Light: 1, Dark: 2 } }] }]
  });
  const patch = {
    variables: [{ name: "Theme", items: [{ id: "gap", name: "gap", type: "FLOAT", values: { Light: 8 } }] }],
    patch: { operations: [] }
  };
  const core = validatePatch(document, patch);
  assert.equal(core.valid, false);
  assert.equal(core.issues[0].code, "PATCH_RESOURCE_INVALID");
  assert.match(core.issues[0].message, /missing values for mode.*Dark/);

  await importIntoMock(normalize({
    canvas: { id: "screen", width: 100, height: 100 },
    nodes: [{ id: "cta", type: "RECTANGLE", w: 10, h: 10, fill: "#fff" }]
  }));
  const ctx = emptyPatchContext();
  const api = (globalThis as { figma: { variables: { createVariableCollection: (n: string) => MockVariableCollection; createVariable: (n: string, c: MockVariableCollection, t: string) => MockVariable }; _variables: MockVariable[] } }).figma;
  const collection = api.variables.createVariableCollection("Theme");
  collection.renameMode(collection.modes[0].modeId, "Light");
  collection.addMode("Dark");
  const keep = api.variables.createVariable("keep", collection, "FLOAT");
  keep.setPluginData("compactDesignId", "keep");
  keep.setValueForMode(collection.modes[0].modeId, 1);
  keep.setValueForMode(collection.modes[1].modeId, 2);
  ctx.resources.variableCollections.set("Theme", collection as never);
  ctx.resources.variableCollections.set(collection.id, collection as never);
  ctx.resources.variables.set("keep", keep as never);

  const beforeCount = api._variables.filter((v) => !v.removed).length;
  await assert.rejects(
    () => applyFigmaPatch(normalizePatch(patch), ctx as never),
    /missing values for mode|PATCH_RESOURCE_INVALID/
  );
  assert.equal(api._variables.filter((v) => !v.removed).length, beforeCount, "no variable created");
});

test("Gate #45.5: Figma rollback restores prior compactDesignId (including absent)", async () => {
  const document = normalize({
    canvas: { id: "screen", width: 200, height: 100 },
    nodes: [{ id: "cta", type: "RECTANGLE", w: 40, h: 20, fill: "#ffffff" }]
  });
  await importIntoMock(document);
  const ctx = emptyPatchContext();
  const api = (globalThis as { figma: { createTextStyle: () => MockStyle; variables: { createVariableCollection: (n: string) => MockVariableCollection; createVariable: (n: string, c: MockVariableCollection, t: string) => MockVariable } } }).figma;

  // Style with NO compactDesignId — patch stamps one, then a later op fails.
  const style = api.createTextStyle();
  style.name = "Heading";
  style.fontName = { family: "Inter", style: "Bold" };
  style.fontSize = 32;
  assert.equal(style.getPluginData("compactDesignId"), "");
  ctx.resources.textStyles.set("Heading", style as never);

  const collection = api.variables.createVariableCollection("Theme");
  collection.renameMode(collection.modes[0].modeId, "Light");
  const variable = api.variables.createVariable("gap", collection, "FLOAT");
  // Variable also has no compact id
  assert.equal(variable.getPluginData("compactDesignId"), "");
  variable.setValueForMode(collection.modes[0].modeId, 8);
  ctx.resources.variableCollections.set("Theme", collection as never);
  ctx.resources.variableCollections.set(collection.id, collection as never);
  ctx.resources.variables.set("gap", variable as never);

  await assert.rejects(
    () => applyFigmaPatch(normalizePatch({
      variables: [{ name: "Theme", modes: ["Light", "Dark"], items: [{ name: "gap", type: "FLOAT", values: { Dark: 16 } }] }],
      styles: [{ name: "Heading", type: "TEXT", font: { size: 44 }, id: "heading" }],
      patch: { operations: [
        { op: "set", id: "cta", set: { name: "CTA" } },
        { op: "set", id: "ghost", set: { name: "nope" } }
      ] }
    }), ctx as never),
    /was not found|ghost/
  );

  assert.equal(style.getPluginData("compactDesignId"), "", "style compactDesignId restored to absent");
  assert.equal(variable.getPluginData("compactDesignId"), "", "variable compactDesignId restored to absent");
  assert.equal(style.fontSize, 32, "font size restored");
  assert.equal(collection.modes.map((m) => m.name).join(","), "Light", "mode add rolled back");
});

// --- wrap / unwrap lockstep --------------------------------------------------

test("lockstep wrap: free siblings keep absolute; wrapper at bbox; omit vs authored size", async () => {
  const document = normalize({
    canvas: { id: "screen", width: 400, height: 400 },
    nodes: [
      { id: "icon", type: "RECTANGLE", x: 24, y: 100, w: 40, h: 40, fill: "#FF0000" },
      { id: "title", type: "RECTANGLE", x: 24, y: 160, w: 80, h: 24, fill: "#00FF00" }
    ]
  });
  const final = await assertParity(document, [[{
    op: "wrap", ids: ["icon", "title"],
    node: { id: "row", type: "FRAME" }
  }]]);
  const row = final.nodes[0].children.find((n) => n.id === "row")!;
  assert.deepEqual(row.properties.position, { x: 24, y: 100 });
  assert.deepEqual(row.properties.size, { width: 80, height: 84 });
  assert.deepEqual(row.children.map((c) => c.id), ["icon", "title"]);

  const sized = await assertParity(document, [[{
    op: "wrap", ids: ["icon", "title"],
    node: { id: "box", type: "FRAME", w: 200, h: 100 }
  }]]);
  assert.deepEqual(sized.nodes[0].children.find((n) => n.id === "box")!.properties.size, { width: 200, height: 100 });
});

test("lockstep wrap under AL parent: first-id slot; ABSOLUTE sibling and wrapped child", async () => {
  const document = normalize({
    canvas: { id: "screen", width: 400, height: 400 },
    nodes: [{
      id: "stack", type: "FRAME", x: 0, y: 0, w: 300, h: 300,
      layout: { direction: "VERTICAL", itemSpacing: 8 },
      children: [
        { id: "keep", type: "RECTANGLE", x: 0, y: 0, w: 40, h: 20, fill: "#111111" },
        { id: "icon", type: "RECTANGLE", x: 0, y: 28, w: 40, h: 40, fill: "#FF0000" },
        { id: "badge", type: "RECTANGLE", x: 200, y: 10, w: 16, h: 16, fill: "#0000FF", layoutPositioning: "ABSOLUTE" },
        { id: "title", type: "RECTANGLE", x: 0, y: 76, w: 80, h: 24, fill: "#00FF00" }
      ]
    }]
  });
  const final = await assertParity(document, [[{
    op: "wrap", ids: ["icon", "title"],
    node: { id: "row", type: "FRAME", layout: { direction: "HORIZONTAL", itemSpacing: 4 } }
  }]]);
  const stack = final.nodes[0].children.find((n) => n.id === "stack")!;
  assert.deepEqual(stack.children.map((c) => c.id), ["keep", "row", "badge"]);
  assert.equal(stack.children.find((c) => c.id === "badge")!.properties.layoutPositioning, "ABSOLUTE");

  const withAbs = await assertParity(document, [[{
    op: "wrap", ids: ["icon", "badge"],
    node: { id: "chrome", type: "FRAME" }
  }]]);
  const stack2 = withAbs.nodes[0].children.find((n) => n.id === "stack")!;
  assert.equal(stack2.children[1].id, "chrome");
  const badge = stack2.children[1].children.find((c) => c.id === "badge")!;
  assert.equal(badge.properties.layoutPositioning, "ABSOLUTE");
  assert.deepEqual(badge.properties.position, { x: 200, y: 10 });
});

test("lockstep unwrap: absolutes preserved; visual WARNING identical; AL + ABSOLUTE", async () => {
  const document = normalize({
    canvas: { id: "screen", width: 400, height: 400 },
    nodes: [{
      id: "stack", type: "FRAME", x: 0, y: 0, w: 300, h: 300,
      layout: { direction: "VERTICAL", itemSpacing: 8 },
      children: [
        { id: "keep", type: "RECTANGLE", x: 0, y: 0, w: 40, h: 20, fill: "#111111" },
        {
          id: "row", type: "FRAME", x: 0, y: 28, w: 120, h: 50,
          fill: "#AABBCC", stroke: "#000000",
          effects: [{ type: "DROP_SHADOW", color: "#00000040", offset: { x: 0, y: 2 }, blur: 4 }],
          clipsContent: true,
          children: [
            { id: "icon", type: "RECTANGLE", x: 0, y: 0, w: 40, h: 40, fill: "#FF0000" },
            { id: "pin", type: "RECTANGLE", x: 90, y: -23, w: 10, h: 10, fill: "#00FF00", layoutPositioning: "ABSOLUTE" }
          ]
        }
      ]
    }]
  });
  const page = await importIntoMock(document);
  const patch = checkedPatch({ op: "unwrap", id: "row" });
  const coreResult = applyCorePatch(document, patch);
  const figmaResult = await applyFigmaPatch(patch, emptyPatchContext() as never);
  assert.deepEqual(await figmaState(page), await coreState(coreResult.document));
  const warn = /unwrap 'row': dropped wrapper/;
  assert.ok(coreResult.warnings.some((w) => warn.test(w) && /fills/.test(w) && /strokes/.test(w) && /effects/.test(w) && /clipsContent/.test(w)));
  assert.ok(figmaResult.warnings.some((w) => warn.test(w) && /fills/.test(w) && /strokes/.test(w) && /effects/.test(w) && /clipsContent/.test(w)));
  assert.deepEqual(coreResult.warnings.filter((w) => warn.test(w)), figmaResult.warnings.filter((w) => warn.test(w)));
  assert.equal(coreResult.document.nodes[0].children.find((n) => n.id === "stack")!.children.map((c) => c.id).join(","), "keep,icon,pin");
});

test("lockstep wrap NAVIGATE dest top-level → end-of-patch fails; unwrap SCROLL_TO canvas fails", async () => {
  // importIntoMock does not apply prototypes — seed via set.prototype (remapNavigateToRoot: false).
  const navDoc = normalize({
    canvases: [
      { id: "home", width: 200, height: 100, nodes: [{ id: "cta", type: "FRAME", w: 40, h: 20 }] },
      { id: "checkout", width: 200, height: 100, nodes: [] }
    ]
  });
  await importIntoMock(navDoc);
  await applyFigmaPatch(checkedPatch(setOp("cta", {
    prototype: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NAVIGATE", destination: "checkout" }] }]
  })), emptyPatchContext() as never);
  const seededNav = applyCorePatch(navDoc, checkedPatch(setOp("cta", {
    prototype: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NAVIGATE", destination: "checkout" }] }]
  }))).document;
  await assert.rejects(
    () => applyFigmaPatch(checkedPatch({ op: "wrap", ids: ["home", "checkout"], node: { id: "shell", type: "FRAME" } }), emptyPatchContext() as never),
    /top-level frame|NAVIGATE/
  );
  assert.equal(validatePatch(seededNav, { patch: { operations: [{ op: "wrap", ids: ["home", "checkout"], node: { id: "shell", type: "FRAME" } }] } }).valid, false);

  const scrollDoc = normalize({
    canvas: { id: "screen", width: 300, height: 200 },
    nodes: [
      { id: "btn", type: "FRAME", x: 0, y: 0, w: 40, h: 20 },
      { id: "panel", type: "FRAME", x: 0, y: 40, w: 100, h: 80 }
    ]
  });
  await importIntoMock(scrollDoc);
  await applyFigmaPatch(checkedPatch(setOp("btn", {
    prototype: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "SCROLL_TO", destination: "panel" }] }]
  })), emptyPatchContext() as never);
  const seededScroll = applyCorePatch(scrollDoc, checkedPatch(setOp("btn", {
    prototype: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "SCROLL_TO", destination: "panel" }] }]
  }))).document;
  await assert.rejects(
    () => applyFigmaPatch(checkedPatch({ op: "unwrap", id: "screen" }), emptyPatchContext() as never),
    /SCROLL_TO|same top-level canvas/
  );
  assert.equal(validatePatch(seededScroll, { patch: { operations: [{ op: "unwrap", id: "screen" }] } }).valid, false);
});

test("Figma wrap rollback: later failure restores children, no wrapper left", async () => {
  const document = normalize({
    canvas: { id: "screen", width: 200, height: 200 },
    nodes: [
      { id: "a", type: "RECTANGLE", x: 10, y: 10, w: 20, h: 20, fill: "#FF0000" },
      { id: "b", type: "RECTANGLE", x: 40, y: 10, w: 20, h: 20, fill: "#00FF00" }
    ]
  });
  const page = await importIntoMock(document);
  const before = await figmaState(page);
  await assert.rejects(
    () => applyFigmaPatch(checkedPatch(
      { op: "wrap", ids: ["a", "b"], node: { id: "row", type: "FRAME" } },
      { op: "set", id: "ghost", set: { name: "nope" } }
    ), emptyPatchContext() as never),
    /was not found/
  );
  assert.deepEqual(await figmaState(page), before, "wrap rolled back");
});

test("lockstep unwrap GROUP at non-zero (40,60): children keep parent-space coords", async () => {
  // Core stores absolute; Figma GROUP children live in the group's parent space.
  // Group at (40,60) with authored-relative children (0,0) and (40,40) → abs (40,60)/(80,100).
  // Unwrap must NOT add group.x/y again (that was the Figma bug).
  // Note: assertParity's import check cannot compare GROUP children (core relative vs Figma parent-space),
  // so we seed via importIntoMock, assert the mock precondition, then apply unwrap in both engines.
  const document = normalize({
    canvas: { id: "screen", width: 400, height: 400 },
    nodes: [{
      id: "holder", type: "FRAME", x: 0, y: 0, w: 400, h: 400,
      children: [{
        id: "g", type: "GROUP", x: 40, y: 60, w: 60, h: 60,
        children: [
          { id: "a", type: "RECTANGLE", x: 0, y: 0, w: 20, h: 20, fill: "#FF0000" },
          { id: "b", type: "RECTANGLE", x: 40, y: 40, w: 20, h: 20, fill: "#00FF00" }
        ]
      }]
    }]
  });
  const page = await importIntoMock(document);
  // Precondition: mock models GROUP children in parent space (same as real Figma).
  assert.deepEqual([mockById(page, "g").x, mockById(page, "g").y], [40, 60]);
  assert.deepEqual([mockById(page, "a").x, mockById(page, "a").y], [40, 60], "GROUP child a in holder space");
  assert.deepEqual([mockById(page, "b").x, mockById(page, "b").y], [80, 100], "GROUP child b in holder space");

  const patch = checkedPatch({ op: "unwrap", id: "g" });
  const coreResult = applyCorePatch(document, patch);
  await applyFigmaPatch(patch, emptyPatchContext() as never);

  const holder = coreResult.document.nodes[0].children.find((n) => n.id === "holder")!;
  assert.equal(holder.children.some((c) => c.id === "g"), false);
  assert.deepEqual(holder.children.map((c) => c.id).sort(), ["a", "b"]);
  assert.deepEqual(holder.children.find((c) => c.id === "a")!.properties.position, { x: 40, y: 60 });
  assert.deepEqual(holder.children.find((c) => c.id === "b")!.properties.position, { x: 80, y: 100 });
  assert.deepEqual([mockById(page, "a").x, mockById(page, "a").y], [40, 60]);
  assert.deepEqual([mockById(page, "b").x, mockById(page, "b").y], [80, 100]);
  // After unwrap under a FRAME, core parent-relative and Figma x/y agree.
  assert.deepEqual(await figmaState(page), await coreState(coreResult.document));
});

test("lockstep unwrap rejects rotated wrapper (same rule as wrap)", async () => {
  const document = normalize({
    canvas: { id: "screen", width: 200, height: 200 },
    nodes: [{
      id: "spin", type: "FRAME", x: 10, y: 10, w: 80, h: 80, rotation: 15,
      children: [{ id: "leaf", type: "RECTANGLE", x: 0, y: 0, w: 20, h: 20, fill: "#FF0000" }]
    }]
  });
  const page = await importIntoMock(document);
  assert.equal(mockById(page, "spin").rotation, 15);
  await assert.rejects(
    () => applyFigmaPatch(checkedPatch({ op: "unwrap", id: "spin" }), emptyPatchContext() as never),
    /unwrap does not support rotated/
  );
  assert.equal(validatePatch(document, { patch: { operations: [{ op: "unwrap", id: "spin" }] } }).valid, false);
});

