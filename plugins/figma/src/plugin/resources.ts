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
      resources.variables.set(value.id || value.name, variable);
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
    if (field === "fill" && "fills" in node && node.fills !== figma.mixed && node.fills.length && node.fills[0].type === "SOLID") node.fills = [figma.variables.setBoundVariableForPaint(node.fills[0], "color", variable), ...node.fills.slice(1)];
    else if (field === "stroke" && "strokes" in node && node.strokes.length && node.strokes[0].type === "SOLID") node.strokes = [figma.variables.setBoundVariableForPaint(node.strokes[0], "color", variable), ...node.strokes.slice(1)];
    else node.setBoundVariable(field as VariableBindableNodeField, variable);
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
