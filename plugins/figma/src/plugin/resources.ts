import { paints } from "./paints";
import { loadFont } from "./text";
import { clamp, color, finite } from "./value";
import type { DesignProperties, InternalDocument, InternalPatchDocument, JsonObject, PatchStyleDefinition, StyleDefinition, VariableCollectionDefinition, VariableDefinition } from "@compact-design/core";
import { applyResourceUpsert, matchStyle, matchVariable } from "@compact-design/core";
import { isVariableModeLimitError, variableModeLimitWarning } from "./mode-limit";

export interface Resources {
  paintStyles: Map<string, PaintStyle>;
  textStyles: Map<string, TextStyle>;
  variables: Map<string, Variable>;
  variableCollections: Map<string, VariableCollection>;
  createdStyles: BaseStyle[];
  createdCollections: VariableCollection[];
  warnings: string[];
  unavailableVariableModes: Map<string, Set<string>>;
}

export async function createResources(document: InternalDocument): Promise<Resources> {
  const resources: Resources = { paintStyles: new Map(), textStyles: new Map(), variables: new Map(), variableCollections: new Map(), createdStyles: [], createdCollections: [], warnings: [], unavailableVariableModes: new Map() };
  const existingPaint = new Map((await figma.getLocalPaintStylesAsync()).map((style) => [style.name, style]));
  const existingText = new Map((await figma.getLocalTextStylesAsync()).map((style) => [style.name, style]));
  for (const value of document.styles || []) {
    if (value.type === "PAINT") {
      const style = existingPaint.get(value.name) || figma.createPaintStyle(); if (!existingPaint.has(value.name)) resources.createdStyles.push(style); style.name = value.name; style.paints = await paints(value.paints || []);
      const paintId = value.id || value.name; style.setPluginData("compactDesignId", paintId);
      resources.paintStyles.set(paintId, style);
    } else if (value.type === "TEXT") {
      const style = existingText.get(value.name) || figma.createTextStyle(); if (!existingText.has(value.name)) resources.createdStyles.push(style); style.name = value.name; style.fontName = await loadFont(value.font);
      if (value.font && Number.isFinite(value.font.size)) style.fontSize = value.font.size;
      const textId = value.id || value.name; style.setPluginData("compactDesignId", textId);
      resources.textStyles.set(textId, style);
    }
  }
  const collections = new Map((await figma.variables.getLocalVariableCollectionsAsync()).map((collection) => [collection.name, collection]));
  const existingVariables = await figma.variables.getLocalVariablesAsync();
  for (const group of document.variables || []) {
    const collectionName = group.name || "Imported tokens";
    const collection = collections.get(collectionName) || figma.variables.createVariableCollection(collectionName);
    resources.variableCollections.set(collectionName, collection);
    resources.variableCollections.set(collection.id, collection);
    if (!collections.has(collectionName)) resources.createdCollections.push(collection);
    const requestedModes: string[] = Array.isArray(group.modes) && group.modes.length ? group.modes : [collection.modes[0].name];
    if (requestedModes[0] && collection.modes[0].name !== requestedModes[0]) collection.renameMode(collection.modes[0].modeId, requestedModes[0]);
    for (const [index, name] of requestedModes.slice(1).entries()) {
      if (collection.modes.some((candidate) => candidate.name === name)) continue;
      try { collection.addMode(name); }
      catch (error) {
        if (!isVariableModeLimitError(error)) throw error;
        const omitted = requestedModes.slice(index + 1).filter((modeName) => !collection.modes.some((candidate) => candidate.name === modeName));
        const unavailable = new Set(omitted);
        resources.unavailableVariableModes.set(collectionName, unavailable);
        resources.unavailableVariableModes.set(collection.id, unavailable);
        resources.warnings.push(variableModeLimitWarning(collectionName, collection.modes.map((mode) => mode.name), omitted));
        break;
      }
    }
    for (const value of group.items || []) {
      const variable = existingVariables.find((candidate) => candidate.variableCollectionId === collection.id && candidate.name === value.name && candidate.resolvedType === (value.type || "FLOAT")) || figma.variables.createVariable(value.name, collection, value.type || "FLOAT");
      for (const mode of collection.modes) {
        const raw = value.values?.[mode.name] ?? value.value;
        if (raw === undefined) continue;
        const rawObject = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonObject : {};
        const resolved = value.type === "COLOR" ? { ...color(raw), a: clamp(finite(rawObject.a, 1), 0, 1) } : raw;
        variable.setValueForMode(mode.modeId, resolved as VariableValue);
      }
      const compactId = value.id || value.name;
      variable.setPluginData("compactDesignId", compactId);
      resources.variables.set(compactId, variable);
    }
  }
  return resources;
}

export async function applyResources(node: SceneNode, props: DesignProperties, resources: Resources): Promise<void> {
  const refs = props.styleRefs || {};
  if (refs.fill && resources.paintStyles.has(refs.fill) && "setFillStyleIdAsync" in node) await node.setFillStyleIdAsync(resources.paintStyles.get(refs.fill)!.id);
  if (refs.stroke && resources.paintStyles.has(refs.stroke) && "setStrokeStyleIdAsync" in node) await node.setStrokeStyleIdAsync(resources.paintStyles.get(refs.stroke)!.id);
  if (refs.text && resources.textStyles.has(refs.text) && node.type === "TEXT") await node.setTextStyleIdAsync(resources.textStyles.get(refs.text)!.id);
  for (const [field, key] of Object.entries(props.bindings || {})) {
    const variable = resources.variables.get(String(key));
    if (!variable) throw new Error(`Unknown variable '${key}' on '${node.name}'`);
    if (field === "fill") {
      if (!("fills" in node) || node.fills === figma.mixed || !Array.isArray(node.fills) || !node.fills.length || node.fills[0].type !== "SOLID") {
        throw new Error(`fill binding requires a SOLID first paint on '${node.name}'`);
      }
      node.fills = [figma.variables.setBoundVariableForPaint(node.fills[0], "color", variable), ...node.fills.slice(1)];
    } else if (field === "stroke") {
      if (!("strokes" in node) || !Array.isArray(node.strokes) || !node.strokes.length || node.strokes[0].type !== "SOLID") {
        throw new Error(`stroke binding requires a SOLID first paint on '${node.name}'`);
      }
      node.strokes = [figma.variables.setBoundVariableForPaint(node.strokes[0], "color", variable), ...node.strokes.slice(1)];
    } else {
      node.setBoundVariable(field as VariableBindableNodeField, variable);
    }
  }
  for (const [collectionKey, modeKey] of Object.entries(props.variableModes || {})) {
    const collection = resources.variableCollections.get(collectionKey);
    if (!collection) throw new Error(`Unknown variable collection '${collectionKey}' on '${node.name}'`);
    const mode = collection.modes.find((candidate) => candidate.name === modeKey || candidate.modeId === modeKey);
    if (!mode && resources.unavailableVariableModes.get(collectionKey)?.has(modeKey)) continue;
    if (!mode) throw new Error(`Unknown mode '${String(modeKey)}' in collection '${collection.name}'`);
    node.setExplicitVariableModeForCollection(collection, mode.modeId);
  }
}

/** Resolve styles/variables already in the file (for patch apply). Keys by compactDesignId plugin data and by name. */
export async function loadExistingResources(): Promise<Resources> {
  const resources: Resources = { paintStyles: new Map(), textStyles: new Map(), variables: new Map(), variableCollections: new Map(), createdStyles: [], createdCollections: [], warnings: [], unavailableVariableModes: new Map() };
  for (const style of await figma.getLocalPaintStylesAsync()) {
    const compact = style.getPluginData?.("compactDesignId") || "";
    if (compact) resources.paintStyles.set(compact, style);
    resources.paintStyles.set(style.name, style);
  }
  for (const style of await figma.getLocalTextStylesAsync()) {
    const compact = style.getPluginData?.("compactDesignId") || "";
    if (compact) resources.textStyles.set(compact, style);
    resources.textStyles.set(style.name, style);
  }
  for (const collection of await figma.variables.getLocalVariableCollectionsAsync()) {
    resources.variableCollections.set(collection.name, collection);
    resources.variableCollections.set(collection.id, collection);
  }
  for (const variable of await figma.variables.getLocalVariablesAsync()) {
    const compact = variable.getPluginData("compactDesignId") || variable.name;
    resources.variables.set(compact, variable);
    resources.variables.set(variable.name, variable);
  }
  return resources;
}

/** Apply a shallow-merge patch for bindings / styleRefs / variableModes (null clears a field). */
export async function applyResourcePatch(
  node: SceneNode,
  patch: {
    bindings?: Record<string, string | null> | null;
    styleRefs?: Record<string, string | null> | null;
    variableModes?: Record<string, string | null> | null;
  },
  resources: Resources,
  warnings: string[]
): Promise<void> {
  const path = `node '${node.getPluginData("compactDesignId") || node.name}'`;
  if (patch.styleRefs !== undefined) {
    if (patch.styleRefs === null) {
      if ("setFillStyleIdAsync" in node && node.fillStyleId) { await node.setFillStyleIdAsync(""); warnings.push(`${path}: cleared styleRefs.fill`); }
      if ("setStrokeStyleIdAsync" in node && node.strokeStyleId) { await node.setStrokeStyleIdAsync(""); warnings.push(`${path}: cleared styleRefs.stroke`); }
      if (node.type === "TEXT" && node.textStyleId) { await node.setTextStyleIdAsync(""); warnings.push(`${path}: cleared styleRefs.text`); }
    } else {
      for (const [field, key] of Object.entries(patch.styleRefs)) {
        if (key === null) {
          if (field === "fill" && "setFillStyleIdAsync" in node) await node.setFillStyleIdAsync("");
          else if (field === "stroke" && "setStrokeStyleIdAsync" in node) await node.setStrokeStyleIdAsync("");
          else if (field === "text" && node.type === "TEXT") await node.setTextStyleIdAsync("");
          else continue;
          warnings.push(`${path}: cleared styleRefs.${field}`);
          continue;
        }
        if (field === "fill") {
          const style = resources.paintStyles.get(key);
          if (!style) throw new Error(`Unknown paint style '${key}' on '${node.name}'`);
          if (!("setFillStyleIdAsync" in node)) throw new Error(`'styleRefs.fill' is not supported on Figma ${node.type} node '${node.name}'`);
          await node.setFillStyleIdAsync(style.id);
        } else if (field === "stroke") {
          const style = resources.paintStyles.get(key);
          if (!style) throw new Error(`Unknown paint style '${key}' on '${node.name}'`);
          if (!("setStrokeStyleIdAsync" in node)) throw new Error(`'styleRefs.stroke' is not supported on Figma ${node.type} node '${node.name}'`);
          await node.setStrokeStyleIdAsync(style.id);
        } else if (field === "text") {
          const style = resources.textStyles.get(key);
          if (!style) throw new Error(`Unknown text style '${key}' on '${node.name}'`);
          if (node.type !== "TEXT") throw new Error(`'styleRefs.text' is not supported on Figma ${node.type} node '${node.name}'`);
          await node.setTextStyleIdAsync(style.id);
        }
      }
    }
  }
  if (patch.bindings !== undefined) {
    if (patch.bindings === null) {
      const current = ("boundVariables" in node && node.boundVariables) ? Object.keys(node.boundVariables) : [];
      for (const field of current) {
        node.setBoundVariable(field as VariableBindableNodeField, null);
        warnings.push(`${path}: cleared bindings.${field}`);
      }
      // Paint bindings live on the paint
      if ("fills" in node && Array.isArray(node.fills) && node.fills[0] && "boundVariables" in node.fills[0] && node.fills[0].boundVariables) {
        node.fills = node.fills.map((paint, index) => {
          if (index !== 0 || paint.type !== "SOLID") return paint;
          const next = { ...paint } as SolidPaint;
          delete (next as { boundVariables?: unknown }).boundVariables;
          return next;
        });
        warnings.push(`${path}: cleared bindings.fill`);
      }
      if ("strokes" in node && Array.isArray(node.strokes) && node.strokes[0] && "boundVariables" in node.strokes[0] && node.strokes[0].boundVariables) {
        node.strokes = node.strokes.map((paint, index) => {
          if (index !== 0 || paint.type !== "SOLID") return paint;
          const next = { ...paint } as SolidPaint;
          delete (next as { boundVariables?: unknown }).boundVariables;
          return next;
        });
        warnings.push(`${path}: cleared bindings.stroke`);
      }
    } else {
      for (const [field, key] of Object.entries(patch.bindings)) {
        if (key === null) {
          if (field === "fill" && "fills" in node && Array.isArray(node.fills) && node.fills.length && node.fills[0].type === "SOLID") {
            const paint = { ...node.fills[0] } as SolidPaint; delete (paint as { boundVariables?: unknown }).boundVariables;
            node.fills = [paint, ...node.fills.slice(1)];
          } else if (field === "stroke" && "strokes" in node && Array.isArray(node.strokes) && node.strokes.length && node.strokes[0].type === "SOLID") {
            const paint = { ...node.strokes[0] } as SolidPaint; delete (paint as { boundVariables?: unknown }).boundVariables;
            node.strokes = [paint, ...node.strokes.slice(1)];
          } else if ("setBoundVariable" in node) {
            node.setBoundVariable(field as VariableBindableNodeField, null);
          }
          warnings.push(`${path}: cleared bindings.${field}`);
          continue;
        }
        const variable = resources.variables.get(String(key));
        if (!variable) throw new Error(`Unknown variable '${key}' on '${node.name}'`);
        if (field === "fill") {
          if (!("fills" in node) || node.fills === figma.mixed || !Array.isArray(node.fills) || !node.fills.length || node.fills[0].type !== "SOLID") {
            throw new Error(`fill binding requires a SOLID first paint on '${node.name}'`);
          }
          node.fills = [figma.variables.setBoundVariableForPaint(node.fills[0], "color", variable), ...node.fills.slice(1)];
        } else if (field === "stroke") {
          if (!("strokes" in node) || !Array.isArray(node.strokes) || !node.strokes.length || node.strokes[0].type !== "SOLID") {
            throw new Error(`stroke binding requires a SOLID first paint on '${node.name}'`);
          }
          node.strokes = [figma.variables.setBoundVariableForPaint(node.strokes[0], "color", variable), ...node.strokes.slice(1)];
        } else {
          node.setBoundVariable(field as VariableBindableNodeField, variable);
        }
      }
    }
  }
  if (patch.variableModes !== undefined) {
    if (patch.variableModes === null) {
      // Clear all explicit modes we can see
      for (const collection of resources.variableCollections.values()) {
        if ("clearExplicitVariableModeForCollection" in node) {
          try { (node as SceneNode & { clearExplicitVariableModeForCollection(collection: VariableCollection): void }).clearExplicitVariableModeForCollection(collection); } catch { /* ignore */ }
        }
      }
    } else {
      for (const [collectionKey, modeKey] of Object.entries(patch.variableModes)) {
        const collection = resources.variableCollections.get(collectionKey);
        if (!collection) throw new Error(`Unknown variable collection '${collectionKey}' on '${node.name}'`);
        if (modeKey === null) {
          if ("clearExplicitVariableModeForCollection" in node) {
            (node as SceneNode & { clearExplicitVariableModeForCollection(collection: VariableCollection): void }).clearExplicitVariableModeForCollection(collection);
          }
          continue;
        }
        const mode = collection.modes.find((candidate) => candidate.name === modeKey || candidate.modeId === modeKey);
        if (!mode && resources.unavailableVariableModes.get(collectionKey)?.has(modeKey)) continue;
        if (!mode) throw new Error(`Unknown mode '${String(modeKey)}' in collection '${collection.name}'`);
        node.setExplicitVariableModeForCollection(collection, mode.modeId);
      }
    }
  }
}


export type ResourceUndoEntry = { kind: "resource"; restore: () => Promise<void> };

function uniqueStyles(map: Map<string, PaintStyle | TextStyle>): Array<PaintStyle | TextStyle> {
  const seen = new Set<PaintStyle | TextStyle>();
  const out: Array<PaintStyle | TextStyle> = [];
  for (const style of map.values()) {
    if (seen.has(style)) continue;
    seen.add(style);
    out.push(style);
  }
  return out;
}

/** Build a core-shaped snapshot of current resources for shared conflict rules. */
function resourcesAsUpsertInput(resources: Resources): { styles: StyleDefinition[]; variables: VariableCollectionDefinition[] } {
  const styles: StyleDefinition[] = [];
  for (const style of uniqueStyles(resources.paintStyles as Map<string, PaintStyle | TextStyle>)) {
    const compact = style.getPluginData?.("compactDesignId") || undefined;
    styles.push({ id: compact || undefined, name: style.name, type: "PAINT", paints: [] });
  }
  for (const style of uniqueStyles(resources.textStyles as Map<string, PaintStyle | TextStyle>)) {
    const compact = style.getPluginData?.("compactDesignId") || undefined;
    const text = style as TextStyle;
    styles.push({
      id: compact || undefined,
      name: style.name,
      type: "TEXT",
      font: { family: text.fontName.family, style: text.fontName.style, size: text.fontSize }
    });
  }
  const variables: VariableCollectionDefinition[] = [];
  const seenCollections = new Set<VariableCollection>();
  for (const collection of resources.variableCollections.values()) {
    if (seenCollections.has(collection)) continue;
    seenCollections.add(collection);
    const items: VariableDefinition[] = [];
    for (const variable of resources.variables.values()) {
      if (variable.variableCollectionId !== collection.id) continue;
      if (items.some((item) => item.name === variable.name)) continue;
      const compact = variable.getPluginData("compactDesignId") || undefined;
      items.push({
        id: compact || undefined,
        name: variable.name,
        type: variable.resolvedType as VariableDefinition["type"],
        values: Object.fromEntries(collection.modes.map((mode) => [mode.name, true]))
      });
    }
    variables.push({ name: collection.name, modes: collection.modes.map((mode) => mode.name), items });
  }
  return { styles, variables };
}

/** Stamp compactDesignId, snapshotting the prior value (including absent) for rollback. */
function registerStyle(
  resources: Resources,
  style: PaintStyle | TextStyle,
  compactId: string,
  type: "PAINT" | "TEXT",
  undoLog: Array<ResourceUndoEntry | { kind: string }>,
  isNew: boolean
): void {
  const previous = style.getPluginData?.("compactDesignId") || "";
  if (previous !== compactId) {
    style.setPluginData("compactDesignId", compactId);
    if (!isNew) {
      undoLog.push({
        kind: "resource",
        restore: async () => { style.setPluginData("compactDesignId", previous); }
      });
    }
  }
  if (type === "PAINT") {
    resources.paintStyles.set(compactId, style as PaintStyle);
    resources.paintStyles.set(style.name, style as PaintStyle);
  } else {
    resources.textStyles.set(compactId, style as TextStyle);
    resources.textStyles.set(style.name, style as TextStyle);
  }
}

function registerVariable(
  resources: Resources,
  variable: Variable,
  compactId: string,
  collection: VariableCollection,
  undoLog: Array<ResourceUndoEntry | { kind: string }>,
  isNew: boolean
): void {
  const previous = variable.getPluginData("compactDesignId") || "";
  if (previous !== compactId) {
    variable.setPluginData("compactDesignId", compactId);
    if (!isNew) {
      undoLog.push({
        kind: "resource",
        restore: async () => { variable.setPluginData("compactDesignId", previous); }
      });
    }
  }
  resources.variables.set(compactId, variable);
  resources.variables.set(variable.name, variable);
  resources.variableCollections.set(collection.name, collection);
  resources.variableCollections.set(collection.id, collection);
}

/**
 * Upsert patch variables/styles into the file before operations run.
 * Mode adds run first (recording plan-limit omissions), then shared
 * applyResourceUpsert plans conflicts/coverage, then values/styles write.
 * Snapshots every touched token including compactDesignId; restore callbacks
 * are pushed onto undoLog (replayed in reverse on failure).
 */
export async function upsertPatchResources(
  patch: InternalPatchDocument,
  resources: Resources,
  undoLog: Array<ResourceUndoEntry | { kind: string }>
): Promise<{ warnings: string[]; affectedKeys: string[] }> {
  const warnings: string[] = [...resources.warnings];
  if (!(patch.variables?.length || patch.styles?.length)) return { warnings, affectedKeys: [] };

  const unavailableModes = new Map<string, Set<string>>();

  // --- Phase 1: collections / modes (so the plan sees available modes only) ---
  for (const group of patch.variables || []) {
    const collectionName = group.name;
    let collection = resources.variableCollections.get(collectionName);
    if (!collection) {
      collection = figma.variables.createVariableCollection(collectionName);
      resources.createdCollections.push(collection);
      const created = collection;
      undoLog.push({
        kind: "resource",
        restore: async () => { try { created.remove(); } catch { /* already gone */ } }
      });
      const requested = Array.isArray(group.modes) && group.modes.length ? group.modes : [collection.modes[0].name];
      if (requested[0] && collection.modes[0].name !== requested[0]) {
        collection.renameMode(collection.modes[0].modeId, requested[0]);
      }
      for (const name of requested.slice(1)) {
        if (collection.modes.some((mode) => mode.name === name)) continue;
        try { collection.addMode(name); }
        catch (error) {
          if (!isVariableModeLimitError(error)) throw error;
          const omitted = requested.slice(requested.indexOf(name)).filter((modeName) => !collection!.modes.some((mode) => mode.name === modeName));
          const unavailable = new Set(omitted);
          unavailableModes.set(collectionName, unavailable);
          resources.unavailableVariableModes.set(collectionName, unavailable);
          resources.unavailableVariableModes.set(collection.id, unavailable);
          warnings.push(variableModeLimitWarning(collectionName, collection.modes.map((mode) => mode.name), omitted));
          break;
        }
      }
    } else {
      const requested = Array.isArray(group.modes) && group.modes.length ? group.modes : [];
      const addedModeIds: string[] = [];
      for (const name of requested) {
        if (collection.modes.some((mode) => mode.name === name)) continue;
        const beforeIds = new Set(collection.modes.map((mode) => mode.modeId));
        try { collection.addMode(name); }
        catch (error) {
          if (!isVariableModeLimitError(error)) throw error;
          const omitted = requested.slice(requested.indexOf(name)).filter((modeName) => !collection!.modes.some((mode) => mode.name === modeName));
          const unavailable = new Set(omitted);
          unavailableModes.set(collectionName, unavailable);
          resources.unavailableVariableModes.set(collectionName, unavailable);
          resources.unavailableVariableModes.set(collection.id, unavailable);
          warnings.push(variableModeLimitWarning(collectionName, collection.modes.map((mode) => mode.name), omitted));
          break;
        }
        const added = collection.modes.find((mode) => !beforeIds.has(mode.modeId));
        if (added) addedModeIds.push(added.modeId);
      }
      if (addedModeIds.length) {
        const target = collection;
        undoLog.push({
          kind: "resource",
          restore: async () => {
            for (const modeId of [...addedModeIds].reverse()) {
              try { target.removeMode(modeId); } catch { /* ignore */ }
            }
          }
        });
      }
    }
    resources.variableCollections.set(collectionName, collection);
    resources.variableCollections.set(collection.id, collection);
  }

  // --- Phase 2: shared plan (conflicts, id uniqueness, create coverage) ---
  const existing = resourcesAsUpsertInput(resources);
  const planned = applyResourceUpsert(
    existing,
    { styles: patch.styles, variables: patch.variables },
    { unavailableModes }
  );
  if (planned.issues.length) {
    const message = planned.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
    throw new Error(message);
  }

  // --- Phase 3: write variable values ---
  for (const group of patch.variables || []) {
    const collectionName = group.name;
    const collection = resources.variableCollections.get(collectionName)!;
    const existingInCollection = (await figma.variables.getLocalVariablesAsync()).filter((candidate) => candidate.variableCollectionId === collection.id);
    const itemsAsDefs: VariableDefinition[] = existingInCollection.map((variable) => ({
      id: variable.getPluginData("compactDesignId") || undefined,
      name: variable.name,
      type: variable.resolvedType as VariableDefinition["type"]
    }));

    for (const incoming of group.items || []) {
      const matched = matchVariable(itemsAsDefs, incoming);
      let variable: Variable | undefined;
      let isNew = false;
      if (matched) {
        variable = existingInCollection.find((candidate) =>
          (matched.by === "id" && (candidate.getPluginData("compactDesignId") === incoming.id || candidate.getPluginData("compactDesignId") === matched.variable.id))
          || (matched.by === "name" && candidate.name === incoming.name)
        ) || existingInCollection.find((candidate) => candidate.name === matched.variable.name);
      }

      if (variable) {
        const snapshot = { ...variable.valuesByMode };
        const target = variable;
        undoLog.push({
          kind: "resource",
          restore: async () => {
            for (const [modeId, value] of Object.entries(snapshot)) {
              try { target.setValueForMode(modeId, value as VariableValue); } catch { /* ignore */ }
            }
          }
        });
      } else {
        variable = figma.variables.createVariable(incoming.name, collection, incoming.type || "FLOAT");
        isNew = true;
        const created = variable;
        undoLog.push({
          kind: "resource",
          restore: async () => { try { created.remove(); } catch { /* ignore */ } }
        });
        itemsAsDefs.push({ id: incoming.id, name: incoming.name, type: incoming.type });
        existingInCollection.push(variable);
      }

      const unavailable = resources.unavailableVariableModes.get(collectionName) || resources.unavailableVariableModes.get(collection.id);
      for (const mode of collection.modes) {
        let raw: unknown;
        if (incoming.values) raw = incoming.values[mode.name];
        else if (incoming.value !== undefined && mode.modeId === collection.modes[0].modeId) raw = incoming.value;
        else continue;
        if (raw === undefined) continue;
        if (unavailable?.has(mode.name)) continue;
        const rawObject = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonObject : {};
        const resolved = incoming.type === "COLOR" ? { ...color(raw), a: clamp(finite(rawObject.a, 1), 0, 1) } : raw;
        variable.setValueForMode(mode.modeId, resolved as VariableValue);
      }
      const compactId = incoming.id || variable.getPluginData("compactDesignId") || incoming.name;
      registerVariable(resources, variable, compactId, collection, undoLog, isNew);
    }
  }

  // --- Phase 4: styles ---
  const paintList = uniqueStyles(resources.paintStyles as Map<string, PaintStyle | TextStyle>).map((style) => ({
    id: style.getPluginData?.("compactDesignId") || undefined,
    name: style.name,
    type: "PAINT" as const,
    paints: [] as StyleDefinition["paints"]
  }));
  const textList = uniqueStyles(resources.textStyles as Map<string, PaintStyle | TextStyle>).map((style) => {
    const textStyle = style as TextStyle;
    return {
      id: style.getPluginData?.("compactDesignId") || undefined,
      name: style.name,
      type: "TEXT" as const,
      font: { family: textStyle.fontName.family, style: textStyle.fontName.style, size: textStyle.fontSize }
    };
  });
  const styleDefs: StyleDefinition[] = [...paintList, ...textList];

  for (const incoming of (patch.styles || []) as PatchStyleDefinition[]) {
    const matched = matchStyle(styleDefs, incoming);
    if (incoming.type === "PAINT") {
      let style: PaintStyle | undefined;
      let isNew = false;
      if (matched) {
        style = (matched.by === "id"
          ? resources.paintStyles.get(incoming.id!)
          : resources.paintStyles.get(matched.style.name)) as PaintStyle | undefined;
        if (!style) style = [...resources.paintStyles.values()].find((candidate) => candidate.name === matched.style.name);
        if (style) {
          const snapshot = style.paints.map((paint) => ({ ...paint }));
          const target = style;
          undoLog.push({
            kind: "resource",
            restore: async () => { target.paints = snapshot as Paint[]; }
          });
          if (incoming.paints) style.paints = await paints(incoming.paints);
        }
      }
      if (!style) {
        style = figma.createPaintStyle();
        style.name = incoming.name;
        if (incoming.paints) style.paints = await paints(incoming.paints);
        resources.createdStyles.push(style);
        isNew = true;
        const created = style;
        undoLog.push({
          kind: "resource",
          restore: async () => { try { created.remove(); } catch { /* ignore */ } }
        });
        styleDefs.push({ id: incoming.id, name: incoming.name, type: "PAINT", paints: [] });
      }
      const compactId = incoming.id || style.getPluginData("compactDesignId") || incoming.name;
      registerStyle(resources, style, compactId, "PAINT", undoLog, isNew);
    } else {
      let style: TextStyle | undefined;
      let isNew = false;
      if (matched) {
        style = (matched.by === "id"
          ? resources.textStyles.get(incoming.id!)
          : resources.textStyles.get(matched.style.name)) as TextStyle | undefined;
        if (!style) style = [...resources.textStyles.values()].find((candidate) => candidate.name === matched.style.name);
        if (style) {
          const snapshot = {
            fontName: { ...style.fontName },
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            paragraphSpacing: style.paragraphSpacing
          };
          const target = style;
          undoLog.push({
            kind: "resource",
            restore: async () => {
              target.fontName = snapshot.fontName;
              target.fontSize = snapshot.fontSize;
              target.lineHeight = snapshot.lineHeight;
              target.letterSpacing = snapshot.letterSpacing;
              target.paragraphSpacing = snapshot.paragraphSpacing;
            }
          });
          if (incoming.font) {
            const family = incoming.font.family ?? style.fontName.family;
            const fontStyle = incoming.font.style ?? style.fontName.style;
            style.fontName = await loadFont({ family, style: fontStyle, size: incoming.font.size ?? style.fontSize });
            if (typeof incoming.font.size === "number") style.fontSize = incoming.font.size;
          }
          if (incoming.lineHeight !== undefined) {
            style.lineHeight = typeof incoming.lineHeight === "number"
              ? { unit: "PERCENT", value: incoming.lineHeight }
              : incoming.lineHeight.unit === "AUTO"
                ? { unit: "AUTO" }
                : { unit: incoming.lineHeight.unit, value: incoming.lineHeight.value || 0 };
          }
          if (incoming.letterSpacing !== undefined) {
            style.letterSpacing = { unit: incoming.letterSpacing.unit, value: incoming.letterSpacing.value };
          }
          if (incoming.paragraphSpacing !== undefined) style.paragraphSpacing = incoming.paragraphSpacing;
        }
      }
      if (!style) {
        const family = incoming.font?.family;
        const fontStyle = incoming.font?.style;
        if (!family || !fontStyle) throw new Error(`styles: creating a TEXT style requires font.family and font.style`);
        style = figma.createTextStyle();
        style.name = incoming.name;
        style.fontName = await loadFont({ family, style: fontStyle, size: incoming.font?.size ?? 16 });
        if (typeof incoming.font?.size === "number") style.fontSize = incoming.font.size;
        resources.createdStyles.push(style);
        isNew = true;
        const created = style;
        undoLog.push({
          kind: "resource",
          restore: async () => { try { created.remove(); } catch { /* ignore */ } }
        });
        styleDefs.push({ id: incoming.id, name: incoming.name, type: "TEXT", font: { family, style: fontStyle, size: incoming.font?.size ?? 16 } });
      }
      const compactId = incoming.id || style.getPluginData("compactDesignId") || incoming.name;
      registerStyle(resources, style, compactId, "TEXT", undoLog, isNew);
    }
  }

  resources.warnings = warnings;
  return { warnings, affectedKeys: planned.affectedKeys };
}
