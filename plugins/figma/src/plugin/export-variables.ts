/** Pure helpers + Figma-backed collector for exporting variables, bindings, and variableModes. */

export const COMPACT_VARIABLE_ID_KEY = "compactDesignId";

export function compactVariableExportId(name: string, pluginId?: string): string {
  return pluginId && pluginId.length > 0 ? pluginId : name;
}

export function exportColorChannels(
  color: { r: number; g: number; b: number; a?: number },
  opacity = 1
): { r: number; g: number; b: number; a: number } {
  const channel = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255);
  const alpha = color.a !== undefined ? color.a * opacity : opacity;
  return {
    r: channel(color.r),
    g: channel(color.g),
    b: channel(color.b),
    a: Math.round(Math.max(0, Math.min(1, alpha)) * 1000) / 1000
  };
}

export function exportFigmaVariableValue(
  resolvedType: string,
  raw: unknown
): { value?: unknown; skippedAlias?: boolean } {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { type?: string }).type === "VARIABLE_ALIAS") {
    return { skippedAlias: true };
  }
  if (resolvedType === "COLOR" && raw && typeof raw === "object" && "r" in (raw as object)) {
    return { value: exportColorChannels(raw as { r: number; g: number; b: number; a?: number }) };
  }
  return { value: raw };
}

export function paintColorAliasId(
  paint: { type: string; boundVariables?: { color?: { id: string } } } | undefined
): string | undefined {
  if (!paint || paint.type !== "SOLID") return undefined;
  return paint.boundVariables?.color?.id;
}

export function nodeFieldBindings(
  boundVariables: Record<string, unknown> | undefined,
  resolveKey: (figmaVariableId: string) => string | undefined
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!boundVariables) return result;
  const skip = new Set(["fills", "strokes", "effects", "layoutGrids", "componentProperties", "textRangeFills"]);
  for (const [field, alias] of Object.entries(boundVariables)) {
    if (skip.has(field) || Array.isArray(alias)) continue;
    if (!alias || typeof alias !== "object" || !("id" in alias)) continue;
    const key = resolveKey(String((alias as { id: string }).id));
    if (key) result[field] = key;
  }
  const corners = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"] as const;
  const keys = corners.map((corner) => result[corner]).filter(Boolean);
  if (keys.length === 4 && keys.every((key) => key === keys[0])) {
    result.cornerRadius = keys[0]!;
    for (const corner of corners) delete result[corner];
  }
  return result;
}

export function buildExplicitVariableModes(
  explicit: Record<string, string>,
  resolveCollection: (collectionId: string) => { name: string; modes: Array<{ modeId: string; name: string }> } | undefined
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const [collectionId, modeId] of Object.entries(explicit)) {
    const collection = resolveCollection(collectionId);
    if (!collection) continue;
    const mode = collection.modes.find((candidate) => candidate.modeId === modeId);
    if (!mode) continue;
    result[collection.name] = mode.name;
  }
  return Object.keys(result).length ? result : undefined;
}

export type ExportedVariableItem = {
  id: string;
  name: string;
  type: string;
  values: Record<string, unknown>;
  value?: unknown;
};

export type ExportedVariableGroup = {
  name: string;
  modes: string[];
  items: ExportedVariableItem[];
};

export function assembleVariableGroups(
  collections: Array<{
    name: string;
    modes: Array<{ modeId: string; name: string }>;
    items: Array<{
      id: string;
      name: string;
      type: string;
      valuesByMode: Record<string, unknown>;
    }>;
  }>
): ExportedVariableGroup[] {
  const groups: ExportedVariableGroup[] = [];
  for (const collection of collections) {
    const modes = collection.modes.map((mode) => mode.name);
    const items: ExportedVariableItem[] = [];
    for (const item of collection.items) {
      const values: Record<string, unknown> = {};
      for (const mode of collection.modes) {
        const exported = exportFigmaVariableValue(item.type, item.valuesByMode[mode.modeId]);
        if (exported.value !== undefined) values[mode.name] = exported.value;
      }
      if (!Object.keys(values).length) continue;
      const entry: ExportedVariableItem = { id: item.id, name: item.name, type: item.type, values };
      if (modes.length === 1 && values[modes[0]] !== undefined) entry.value = values[modes[0]];
      items.push(entry);
    }
    if (items.length) groups.push({ name: collection.name, modes, items });
  }
  return groups;
}

/** Collects Figma variable references while compacting nodes, then builds the document `variables` array. */
export class VariableExportContext {
  readonly warnings: string[] = [];
  private readonly keyByFigmaId = new Map<string, string>();
  private readonly referencedVariableIds = new Set<string>();
  private readonly collections = new Map<string, VariableCollection>();

  async resolveKey(figmaVariableId: string): Promise<string | undefined> {
    if (this.keyByFigmaId.has(figmaVariableId)) return this.keyByFigmaId.get(figmaVariableId);
    const variable = await figma.variables.getVariableByIdAsync(figmaVariableId);
    if (!variable) {
      this.warnings.push(`Could not resolve variable binding '${figmaVariableId}'.`);
      return undefined;
    }
    const key = compactVariableExportId(variable.name, variable.getPluginData(COMPACT_VARIABLE_ID_KEY) || undefined);
    this.keyByFigmaId.set(figmaVariableId, key);
    this.referencedVariableIds.add(figmaVariableId);
    return key;
  }

  async bindingsForNode(node: SceneNode): Promise<Record<string, string> | undefined> {
    const bindings: Record<string, string> = {};
    if ("fills" in node) {
      const fills = node.fills;
      if (fills !== figma.mixed && fills.length) {
        const aliasId = paintColorAliasId(fills[0] as { type: string; boundVariables?: { color?: { id: string } } });
        if (aliasId) {
          const key = await this.resolveKey(aliasId);
          if (key) bindings.fill = key;
        }
      }
    }
    if ("strokes" in node && node.strokes.length) {
      const aliasId = paintColorAliasId(node.strokes[0] as { type: string; boundVariables?: { color?: { id: string } } });
      if (aliasId) {
        const key = await this.resolveKey(aliasId);
        if (key) bindings.stroke = key;
      }
    }
    if ("boundVariables" in node && node.boundVariables) {
      const pending: string[] = [];
      for (const [field, alias] of Object.entries(node.boundVariables as Record<string, unknown>)) {
        if (["fills", "strokes", "effects", "layoutGrids", "componentProperties", "textRangeFills"].includes(field)) continue;
        if (Array.isArray(alias)) continue;
        if (alias && typeof alias === "object" && "id" in alias) pending.push(String((alias as { id: string }).id));
      }
      for (const id of pending) await this.resolveKey(id);
      Object.assign(bindings, nodeFieldBindings(node.boundVariables as Record<string, unknown>, (id) => this.keyByFigmaId.get(id)));
    }
    return Object.keys(bindings).length ? bindings : undefined;
  }

  async variableModesForNode(node: SceneNode): Promise<Record<string, string> | undefined> {
    if (!("explicitVariableModes" in node)) return undefined;
    const explicit = node.explicitVariableModes;
    if (!explicit || !Object.keys(explicit).length) return undefined;
    for (const collectionId of Object.keys(explicit)) {
      if (this.collections.has(collectionId)) continue;
      const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
      if (collection) this.collections.set(collectionId, collection);
      else this.warnings.push(`Could not resolve variable collection '${collectionId}' for explicit mode.`);
    }
    return buildExplicitVariableModes(explicit, (id) => {
      const collection = this.collections.get(id);
      return collection ? { name: collection.name, modes: collection.modes } : undefined;
    });
  }

  async buildVariablesArray(): Promise<ExportedVariableGroup[]> {
    if (!this.referencedVariableIds.size) return [];
    const byCollection = new Map<string, {
      name: string;
      modes: Array<{ modeId: string; name: string }>;
      items: Array<{ id: string; name: string; type: string; valuesByMode: Record<string, unknown> }>;
    }>();
    for (const variableId of this.referencedVariableIds) {
      const variable = await figma.variables.getVariableByIdAsync(variableId);
      if (!variable) continue;
      if (!this.collections.has(variable.variableCollectionId)) {
        const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
        if (collection) this.collections.set(collection.id, collection);
      }
      const collection = this.collections.get(variable.variableCollectionId);
      if (!collection) {
        this.warnings.push(`Could not resolve collection for variable '${variable.name}'.`);
        continue;
      }
      let group = byCollection.get(collection.id);
      if (!group) {
        group = { name: collection.name, modes: collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name })), items: [] };
        byCollection.set(collection.id, group);
      }
      const id = this.keyByFigmaId.get(variableId) || compactVariableExportId(variable.name, variable.getPluginData(COMPACT_VARIABLE_ID_KEY) || undefined);
      const valuesByMode: Record<string, unknown> = {};
      for (const [modeId, raw] of Object.entries(variable.valuesByMode)) valuesByMode[modeId] = raw;
      for (const mode of collection.modes) {
        const exported = exportFigmaVariableValue(variable.resolvedType, valuesByMode[mode.modeId]);
        if (exported.skippedAlias) {
          this.warnings.push(`Skipped alias value for '${variable.name}' in mode '${mode.name}'.`);
        }
      }
      group.items.push({ id, name: variable.name, type: variable.resolvedType, valuesByMode });
    }
    return assembleVariableGroups([...byCollection.values()]);
  }
}
