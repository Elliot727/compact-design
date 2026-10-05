import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isVariableModeLimitError, variableModeLimitWarning } from "../src/plugin/mode-limit";
import { exportCanvasId, uniqueExportIds } from "../src/plugin/exporter";
import {
  assembleVariableGroups,
  buildExplicitVariableModes,
  compactVariableExportId,
  exportColorChannels,
  exportFigmaVariableValue,
  nodeFieldBindings,
  paintColorAliasId
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

test("export variable value skips aliases and keeps floats", () => {
  assert.deepEqual(exportFigmaVariableValue("FLOAT", 16), { value: 16 });
  assert.deepEqual(exportFigmaVariableValue("COLOR", { r: 1, g: 1, b: 1, a: 1 }), { value: { r: 255, g: 255, b: 255, a: 1 } });
  assert.deepEqual(exportFigmaVariableValue("COLOR", { type: "VARIABLE_ALIAS", id: "VariableID:1:2" }), { skippedAlias: true });
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
  const groups = assembleVariableGroups([{
    name: "Theme",
    modes: [{ modeId: "m-light", name: "Light" }, { modeId: "m-dark", name: "Dark" }],
    items: [{
      id: "surface",
      name: "colour/surface",
      type: "COLOR",
      valuesByMode: {
        "m-light": { r: 248 / 255, g: 245 / 255, b: 238 / 255, a: 1 },
        "m-dark": { r: 26 / 255, g: 27 / 255, b: 24 / 255, a: 1 }
      }
    }]
  }]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].modes, ["Light", "Dark"]);
  assert.equal(groups[0].items[0].id, "surface");
  assert.deepEqual(groups[0].items[0].values.Light, { r: 248, g: 245, b: 238, a: 1 });
  assert.deepEqual(groups[0].items[0].values.Dark, { r: 26, g: 27, b: 24, a: 1 });
});
