import { paints } from "./paints";
import { loadFont } from "./text";
import { clamp, color, finite } from "./value";
import type { DesignProperties, InternalDocument, JsonObject } from "@compact-design/core";
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
      resources.paintStyles.set(value.id || value.name, style);
    } else if (value.type === "TEXT") {
      const style = existingText.get(value.name) || figma.createTextStyle(); if (!existingText.has(value.name)) resources.createdStyles.push(style); style.name = value.name; style.fontName = await loadFont(value.font);
      if (value.font && Number.isFinite(value.font.size)) style.fontSize = value.font.size;
      resources.textStyles.set(value.id || value.name, style);
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

