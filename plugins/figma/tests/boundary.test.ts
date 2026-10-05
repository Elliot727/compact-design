import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isVariableModeLimitError, variableModeLimitWarning } from "../src/plugin/mode-limit";
import { compactLayoutGrids, compactStrokeAppearance, exportCanvasId, uniqueExportIds } from "../src/plugin/exporter";
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
