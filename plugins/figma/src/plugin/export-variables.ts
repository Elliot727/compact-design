/** Pure helpers + Figma-backed collector for exporting variables, bindings, and variableModes. */

export const COMPACT_VARIABLE_ID_KEY = "compactDesignId";

export function compactVariableExportId(name: string, pluginId?: string): string {
  return pluginId && pluginId.length > 0 ? pluginId : name;
}

/** Same collision rule as node export ids: preferred, then preferred-2, preferred-3, … */
export function uniqueVariableExportIds(preferredIds: string[]): string[] {
  const result: string[] = [];
  const used = new Set<string>();
  for (const preferredId of preferredIds) {
    let candidate = preferredId;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${preferredId}-${suffix++}`;
    result.push(candidate);
    used.add(candidate);
  }
  return result;
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

export function isVariableAlias(raw: unknown): raw is { type: "VARIABLE_ALIAS"; id: string } {
  return Boolean(raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { type?: string }).type === "VARIABLE_ALIAS" && typeof (raw as { id?: unknown }).id === "string");
}

export type VariableValueLookup = (variableId: string) => {
  modes: Array<{ modeId: string; name: string }>;
  valuesByMode: Record<string, unknown>;
} | undefined;

/** Follow VARIABLE_ALIAS chains (cycle-safe) until a concrete value or failure. */
export function resolveAliasedRawValue(
  raw: unknown,
  modeName: string,
  lookup: VariableValueLookup,
  stack: Set<string> = new Set()
): { value?: unknown; cycle?: boolean; missing?: boolean } {
  if (!isVariableAlias(raw)) return { value: raw };
  if (stack.has(raw.id)) return { cycle: true };
  stack.add(raw.id);
  const target = lookup(raw.id);
  if (!target) return { missing: true };
  const mode = target.modes.find((candidate) => candidate.name === modeName) || target.modes[0];
  if (!mode) return { missing: true };
  return resolveAliasedRawValue(target.valuesByMode[mode.modeId], mode.name, lookup, stack);
}

export function exportFigmaVariableValue(
  resolvedType: string,
  raw: unknown,
  modeName?: string,
  lookup?: VariableValueLookup
): { value?: unknown; skippedAlias?: boolean; cycle?: boolean; missing?: boolean } {
  let concrete = raw;
  if (isVariableAlias(raw)) {
    if (!lookup || modeName === undefined) return { skippedAlias: true };
    const resolved = resolveAliasedRawValue(raw, modeName, lookup);
    if (resolved.cycle) return { cycle: true };
    if (resolved.missing || resolved.value === undefined) return { missing: true };
    concrete = resolved.value;
  }
  if (resolvedType === "COLOR" && concrete && typeof concrete === "object" && "r" in (concrete as object)) {
    return { value: exportColorChannels(concrete as { r: number; g: number; b: number; a?: number }) };
  }
  return { value: concrete };
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

export type AssembledVariableItem = {
  figmaId: string;
  preferredId: string;
  name: string;
  type: string;
  valuesByMode: Record<string, unknown>;
};

export function assembleVariableGroups(
  collections: Array<{
    name: string;
    modes: Array<{ modeId: string; name: string }>;
    items: AssembledVariableItem[];
  }>,
  lookup: VariableValueLookup,
  onDrop?: (figmaId: string, preferredId: string, reason: string) => void
): { groups: ExportedVariableGroup[]; exportIdByFigmaId: Map<string, string> } {
  const preferred: Array<{ figmaId: string; preferredId: string; collectionIndex: number; itemIndex: number }> = [];
  const prepared = collections.map((collection, collectionIndex) => {
    const modeNames = collection.modes.map((mode) => mode.name);
    const resolvedItems: Array<{
      figmaId: string;
      preferredId: string;
      name: string;
      type: string;
      values: Record<string, unknown>;
    }> = [];
    for (const item of collection.items) {
      const values: Record<string, unknown> = {};
      let failed = false;
      let failReason = "";
      for (const mode of collection.modes) {
        const exported = exportFigmaVariableValue(item.type, item.valuesByMode[mode.modeId], mode.name, lookup);
        if (exported.cycle) {
          failed = true;
          failReason = `alias cycle in mode '${mode.name}'`;
          break;
        }
        if (exported.skippedAlias || exported.missing || exported.value === undefined) {
          failed = true;
          failReason = `unresolved value in mode '${mode.name}'`;
          break;
        }
        values[mode.name] = exported.value;
      }
      if (failed || Object.keys(values).length !== modeNames.length) {
        onDrop?.(item.figmaId, item.preferredId, failReason || "incomplete mode coverage");
        continue;
      }
      resolvedItems.push({ figmaId: item.figmaId, preferredId: item.preferredId, name: item.name, type: item.type, values });
    }
    return { name: collection.name, modes: modeNames, resolvedItems };
  });

  for (const [collectionIndex, collection] of prepared.entries()) {
    for (const [itemIndex, item] of collection.resolvedItems.entries()) {
      preferred.push({ figmaId: item.figmaId, preferredId: item.preferredId, collectionIndex, itemIndex });
    }
  }
  const uniqueIds = uniqueVariableExportIds(preferred.map((entry) => entry.preferredId));
  const exportIdByFigmaId = new Map<string, string>();
  preferred.forEach((entry, index) => exportIdByFigmaId.set(entry.figmaId, uniqueIds[index]));

  const groups: ExportedVariableGroup[] = [];
  for (const collection of prepared) {
    const items: ExportedVariableItem[] = collection.resolvedItems.map((item) => {
      const id = exportIdByFigmaId.get(item.figmaId)!;
      const entry: ExportedVariableItem = { id, name: item.name, type: item.type, values: item.values };
      if (collection.modes.length === 1) entry.value = item.values[collection.modes[0]];
      return entry;
    });
    if (items.length) groups.push({ name: collection.name, modes: collection.modes, items });
  }
  return { groups, exportIdByFigmaId };
}

/** Collects Figma variable references while compacting nodes, then builds the document `variables` array. */
export class VariableExportContext {
  readonly warnings: string[] = [];
  private readonly keyByFigmaId = new Map<string, string>();
  private readonly referencedVariableIds = new Set<string>();
  private readonly droppedVariableIds = new Set<string>();
  private readonly collections = new Map<string, VariableCollection>();
  private readonly variableCache = new Map<string, Variable>();
  private built = false;

  /** Phase 1: record a binding/reference without assigning an export id yet. */
  noteReference(figmaVariableId: string): void {
    this.referencedVariableIds.add(figmaVariableId);
  }

  async collectRefsFromNode(node: SceneNode): Promise<void> {
    if ("fills" in node) {
      const fills = node.fills;
      if (fills !== figma.mixed && fills.length) {
        const aliasId = paintColorAliasId(fills[0] as { type: string; boundVariables?: { color?: { id: string } } });
        if (aliasId) this.noteReference(aliasId);
      }
    }
    if ("strokes" in node && node.strokes.length) {
      const aliasId = paintColorAliasId(node.strokes[0] as { type: string; boundVariables?: { color?: { id: string } } });
      if (aliasId) this.noteReference(aliasId);
    }
    if ("boundVariables" in node && node.boundVariables) {
      for (const [field, alias] of Object.entries(node.boundVariables as Record<string, unknown>)) {
        if (["fills", "strokes", "effects", "layoutGrids", "componentProperties", "textRangeFills"].includes(field)) continue;
        if (Array.isArray(alias)) continue;
        if (alias && typeof alias === "object" && "id" in alias) this.noteReference(String((alias as { id: string }).id));
      }
    }
    if ("children" in node) {
      for (const child of node.children) {
        if ("x" in child) await this.collectRefsFromNode(child as SceneNode);
      }
    }
  }

  /** Phase 3: only returns keys for variables that survived alias resolve + id assignment. */
  resolveKey(figmaVariableId: string): string | undefined {
    if (this.keyByFigmaId.has(figmaVariableId)) return this.keyByFigmaId.get(figmaVariableId);
    if (this.droppedVariableIds.has(figmaVariableId)) return undefined;
    if (!this.built && this.referencedVariableIds.has(figmaVariableId)) return undefined;
    return undefined;
  }

  async bindingsForNode(node: SceneNode): Promise<Record<string, string> | undefined> {
    const bindings: Record<string, string> = {};
    if ("fills" in node) {
      const fills = node.fills;
      if (fills !== figma.mixed && fills.length) {
        const aliasId = paintColorAliasId(fills[0] as { type: string; boundVariables?: { color?: { id: string } } });
        if (aliasId) {
          const key = this.resolveKey(aliasId);
          if (key) bindings.fill = key;
        }
      }
    }
    if ("strokes" in node && node.strokes.length) {
      const aliasId = paintColorAliasId(node.strokes[0] as { type: string; boundVariables?: { color?: { id: string } } });
      if (aliasId) {
        const key = this.resolveKey(aliasId);
        if (key) bindings.stroke = key;
      }
    }
    if ("boundVariables" in node && node.boundVariables) {
      Object.assign(bindings, nodeFieldBindings(node.boundVariables as Record<string, unknown>, (id) => this.resolveKey(id)));
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

  private async loadVariable(variableId: string): Promise<Variable | undefined> {
    if (this.variableCache.has(variableId)) return this.variableCache.get(variableId);
    const variable = await figma.variables.getVariableByIdAsync(variableId);
    if (!variable) return undefined;
    this.variableCache.set(variableId, variable);
    if (!this.collections.has(variable.variableCollectionId)) {
      const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
      if (collection) this.collections.set(collection.id, collection);
    }
    return variable;
  }

  private async ensureAliasTargets(valuesByMode: Record<string, unknown>, stack: Set<string>): Promise<void> {
    for (const raw of Object.values(valuesByMode)) {
      if (!isVariableAlias(raw) || stack.has(raw.id)) continue;
      stack.add(raw.id);
      const target = await this.loadVariable(raw.id);
      if (!target) continue;
      await this.ensureAliasTargets(Object.fromEntries(Object.entries(target.valuesByMode)), stack);
    }
  }

  async buildVariablesArray(): Promise<ExportedVariableGroup[]> {
    if (!this.referencedVariableIds.size) {
      this.built = true;
      return [];
    }
    for (const variableId of [...this.referencedVariableIds]) {
      const variable = await this.loadVariable(variableId);
      if (!variable) {
        this.warnings.push(`Could not resolve variable binding '${variableId}'.`);
        this.droppedVariableIds.add(variableId);
        continue;
      }
      await this.ensureAliasTargets(Object.fromEntries(Object.entries(variable.valuesByMode)), new Set());
    }

    const byCollection = new Map<string, {
      name: string;
      modes: Array<{ modeId: string; name: string }>;
      items: AssembledVariableItem[];
    }>();

    for (const variableId of this.referencedVariableIds) {
      if (this.droppedVariableIds.has(variableId)) continue;
      const variable = this.variableCache.get(variableId) || await this.loadVariable(variableId);
      if (!variable) continue;
      const collection = this.collections.get(variable.variableCollectionId);
      if (!collection) {
        this.warnings.push(`Could not resolve collection for variable '${variable.name}'.`);
        this.droppedVariableIds.add(variableId);
        continue;
      }
      let group = byCollection.get(collection.id);
      if (!group) {
        group = { name: collection.name, modes: collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name })), items: [] };
        byCollection.set(collection.id, group);
      }
      const preferredId = compactVariableExportId(variable.name, variable.getPluginData(COMPACT_VARIABLE_ID_KEY) || undefined);
      const valuesByMode: Record<string, unknown> = {};
      for (const [modeId, raw] of Object.entries(variable.valuesByMode)) valuesByMode[modeId] = raw;
      group.items.push({ figmaId: variableId, preferredId, name: variable.name, type: variable.resolvedType, valuesByMode });
    }

    const lookup: VariableValueLookup = (variableId) => {
      const variable = this.variableCache.get(variableId);
      if (!variable) return undefined;
      const collection = this.collections.get(variable.variableCollectionId);
      if (!collection) return undefined;
      return {
        modes: collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name })),
        valuesByMode: Object.fromEntries(Object.entries(variable.valuesByMode))
      };
    };

    const { groups, exportIdByFigmaId } = assembleVariableGroups([...byCollection.values()], lookup, (figmaId, preferredId, reason) => {
      this.droppedVariableIds.add(figmaId);
      this.warnings.push(`Dropped variable '${preferredId}' (${reason}).`);
    });

    for (const [figmaId, exportId] of exportIdByFigmaId) this.keyByFigmaId.set(figmaId, exportId);
    this.built = true;
    return groups;
  }
}
