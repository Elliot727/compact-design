import type { RepairIssue } from "./lint";
import type {
  DesignFont,
  JsonValue,
  PatchStyleDefinition,
  StyleDefinition,
  VariableCollectionDefinition,
  VariableDefinition
} from "./types";

function cloneValue<T>(value: T): T {
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)])) as T;
  return value;
}

function resourceIssue(code: string, path: string, message: string, suggestion: string): RepairIssue {
  return { severity: "ERROR", code, path, message, suggestion };
}

export interface ResourceUpsertInput {
  styles: StyleDefinition[];
  variables: VariableCollectionDefinition[];
}

export interface ResourceUpsertPatch {
  styles?: PatchStyleDefinition[];
  variables?: VariableCollectionDefinition[];
}

export interface ResourceUpsertResult {
  styles: StyleDefinition[];
  variables: VariableCollectionDefinition[];
  affectedKeys: string[];
  issues: RepairIssue[];
}

/**
 * Match a style: compact id first (exact id match), then by name.
 * Used by core and Figma so both engines agree.
 */
export function matchStyle(
  styles: StyleDefinition[],
  incoming: { id?: string; name: string }
): { index: number; style: StyleDefinition; by: "id" | "name" } | null {
  if (incoming.id) {
    const byId = styles.findIndex((style) => style.id === incoming.id);
    if (byId >= 0) return { index: byId, style: styles[byId], by: "id" };
  }
  const byName = styles.findIndex((style) => style.name === incoming.name);
  if (byName >= 0) return { index: byName, style: styles[byName], by: "name" };
  return null;
}

/**
 * Match a variable within a collection: compact id first, else name.
 * Type must agree; callers check type clashes separately.
 */
export function matchVariable(
  items: VariableDefinition[],
  incoming: { id?: string; name: string }
): { index: number; variable: VariableDefinition; by: "id" | "name" } | null {
  if (incoming.id) {
    const byId = items.findIndex((item) => item.id === incoming.id);
    if (byId >= 0) return { index: byId, variable: items[byId], by: "id" };
  }
  const byName = items.findIndex((item) => item.name === incoming.name);
  if (byName >= 0) return { index: byName, variable: items[byName], by: "name" };
  return null;
}

function modeList(collection: VariableCollectionDefinition): string[] {
  return Array.isArray(collection.modes) && collection.modes.length ? [...collection.modes] : ["Mode 1"];
}

function valuesMap(variable: VariableDefinition, modes: string[]): Record<string, JsonValue> {
  if (variable.values && typeof variable.values === "object") {
    return { ...(variable.values as Record<string, JsonValue>) };
  }
  if (variable.value !== undefined) {
    const first = modes[0] || "Mode 1";
    return { [first]: variable.value as JsonValue };
  }
  return {};
}

/**
 * Plan + apply a resource upsert into cloned document styles/variables.
 * Identity and conflict rules are shared with Figma (call this, or the match
 * helpers, from both engines). Modes are never renamed; missing modes are
 * appended. A values key naming an unknown mode is an error.
 */
export function applyResourceUpsert(existing: ResourceUpsertInput, patch: ResourceUpsertPatch): ResourceUpsertResult {
  const styles = cloneValue(existing.styles);
  const variables = cloneValue(existing.variables);
  const affectedKeys: string[] = [];
  const issues: RepairIssue[] = [];

  // --- Collections + variables ---
  for (const [collectionIndex, group] of (patch.variables || []).entries()) {
    const collectionPath = `variables[${collectionIndex}]`;
    let collection = variables.find((candidate) => candidate.name === group.name);
    let createdCollection = false;
    if (!collection) {
      collection = { name: group.name, modes: [], items: [] };
      variables.push(collection);
      createdCollection = true;
    }

    const requested = Array.isArray(group.modes) && group.modes.length ? group.modes : [];
    // Existing collections keep mode 0 forever (append only). New collections take
    // the patch's modes list as-is (create is not a rename).
    let currentModes: string[];
    if (createdCollection) {
      currentModes = requested.length ? [...requested] : ["Mode 1"];
    } else {
      currentModes = modeList(collection);
      for (const name of requested) {
        if (currentModes.includes(name)) continue;
        const seedFrom = currentModes[0];
        for (const item of collection.items) {
          const map = valuesMap(item, currentModes);
          if (!(name in map) && seedFrom in map) map[name] = cloneValue(map[seedFrom]);
          item.values = map;
          delete item.value;
        }
        currentModes.push(name);
      }
    }
    collection.modes = currentModes;
    if (createdCollection || requested.length) affectedKeys.push(`collection:${group.name}`);

    for (const [variableIndex, incoming] of (group.items || []).entries()) {
      const itemPath = `${collectionPath}.items[${variableIndex}]`;
      const matched = matchVariable(collection.items, incoming);

      // Type clash: same name in collection, different type (even if id differs).
      const nameClash = collection.items.find((item) => item.name === incoming.name && item.type !== incoming.type);
      if (nameClash && (!matched || matched.variable !== nameClash)) {
        issues.push(resourceIssue(
          "PATCH_RESOURCE_CONFLICT",
          itemPath,
          `variable '${incoming.name}' already exists in collection '${group.name}' with type ${nameClash.type}`,
          "Use a different name, or omit the variable and bind to the existing one."
        ));
        continue;
      }
      if (matched && matched.variable.type !== incoming.type) {
        issues.push(resourceIssue(
          "PATCH_RESOURCE_CONFLICT",
          itemPath,
          `variable '${incoming.name}' already exists in collection '${group.name}' with type ${matched.variable.type}`,
          "Use a different name, or omit the variable and bind to the existing one."
        ));
        continue;
      }

      // Id matches but name differs — no rename in v1.
      if (matched && matched.by === "id" && matched.variable.name !== incoming.name) {
        issues.push(resourceIssue(
          "PATCH_RESOURCE_CONFLICT",
          itemPath,
          `variable id '${incoming.id}' is already bound to name '${matched.variable.name}' (cannot rename to '${incoming.name}')`,
          "Keep the existing name, or omit id to match by name."
        ));
        continue;
      }

      // values keys must name modes the collection has after the upsert.
      const writtenModes: string[] = [];
      if (incoming.values) {
        for (const mode of Object.keys(incoming.values)) {
          if (!currentModes.includes(mode)) {
            issues.push(resourceIssue(
              "PATCH_RESOURCE_INVALID",
              `${itemPath}.values.${mode}`,
              `mode '${mode}' is not declared on collection '${group.name}'`,
              "Add the mode under the collection's modes array, or use an existing mode name."
            ));
          } else {
            writtenModes.push(mode);
          }
        }
      } else if (incoming.value !== undefined) {
        writtenModes.push(currentModes[0]);
      }

      if (issues.some((issue) => issue.path.startsWith(itemPath))) continue;

      if (matched) {
        const target = matched.variable;
        const map = valuesMap(target, currentModes);
        if (incoming.values) {
          for (const mode of writtenModes) map[mode] = cloneValue((incoming.values as Record<string, JsonValue>)[mode]);
        } else if (incoming.value !== undefined) {
          map[currentModes[0]] = cloneValue(incoming.value as JsonValue);
        }
        target.values = map;
        delete target.value;
        if (incoming.id && !target.id) target.id = incoming.id;
        affectedKeys.push(`variable:${group.name}/${target.name}`);
      } else {
        // Create. values must cover every mode — validateDocument catches gaps as PATCH_RESULT_INVALID.
        const created: VariableDefinition = {
          id: incoming.id,
          name: incoming.name,
          type: incoming.type,
          values: {}
        };
        const map: Record<string, JsonValue> = {};
        if (incoming.values) {
          for (const mode of writtenModes) map[mode] = cloneValue((incoming.values as Record<string, JsonValue>)[mode]);
        } else if (incoming.value !== undefined) {
          map[currentModes[0]] = cloneValue(incoming.value as JsonValue);
        }
        created.values = map;
        collection.items.push(created);
        affectedKeys.push(`variable:${group.name}/${created.name}`);
      }
    }
  }

  // --- Styles ---
  for (const [styleIndex, incoming] of (patch.styles || []).entries()) {
    const path = `styles[${styleIndex}]`;
    const matched = matchStyle(styles, incoming);

    if (matched && matched.style.type !== incoming.type) {
      issues.push(resourceIssue(
        "PATCH_RESOURCE_CONFLICT",
        path,
        `style '${incoming.name}' already exists with type ${matched.style.type}`,
        "Use a different name or id, or omit the style."
      ));
      continue;
    }

    if (matched && matched.by === "id" && matched.style.name !== incoming.name) {
      issues.push(resourceIssue(
        "PATCH_RESOURCE_CONFLICT",
        path,
        `style id '${incoming.id}' is already bound to name '${matched.style.name}' (cannot rename to '${incoming.name}')`,
        "Keep the existing name, or omit id to match by name."
      ));
      continue;
    }

    if (matched) {
      const target = matched.style;
      if (incoming.type === "PAINT") {
        if (incoming.paints) target.paints = cloneValue(incoming.paints);
      } else {
        if (incoming.font) {
          target.font = { ...(target.font || { family: "Inter", style: "Regular", size: 16 }), ...incoming.font } as DesignFont;
        }
        if (incoming.lineHeight !== undefined) target.lineHeight = cloneValue(incoming.lineHeight);
        if (incoming.letterSpacing !== undefined) target.letterSpacing = cloneValue(incoming.letterSpacing);
        if (incoming.paragraphSpacing !== undefined) target.paragraphSpacing = incoming.paragraphSpacing;
      }
      if (incoming.id && !target.id) target.id = incoming.id;
      affectedKeys.push(`style:${target.name}`);
    } else {
      if (incoming.type === "TEXT") {
        const family = incoming.font?.family;
        const style = incoming.font?.style;
        if (!family || !style) {
          issues.push(resourceIssue(
            "PATCH_RESOURCE_INVALID",
            `${path}.font`,
            "creating a TEXT style requires font.family and font.style",
            "Provide font.family and font.style (size defaults to 16 if omitted)."
          ));
          continue;
        }
        const created: StyleDefinition = {
          id: incoming.id,
          name: incoming.name,
          type: "TEXT",
          font: {
            family,
            style,
            size: typeof incoming.font?.size === "number" ? incoming.font.size : 16
          },
          ...(incoming.lineHeight !== undefined ? { lineHeight: cloneValue(incoming.lineHeight) } : {}),
          ...(incoming.letterSpacing !== undefined ? { letterSpacing: cloneValue(incoming.letterSpacing) } : {}),
          ...(incoming.paragraphSpacing !== undefined ? { paragraphSpacing: incoming.paragraphSpacing } : {})
        };
        styles.push(created);
        affectedKeys.push(`style:${created.name}`);
      } else {
        const created: StyleDefinition = {
          id: incoming.id,
          name: incoming.name,
          type: "PAINT",
          paints: cloneValue(incoming.paints || [])
        };
        styles.push(created);
        affectedKeys.push(`style:${created.name}`);
      }
    }
  }

  return { styles, variables, affectedKeys, issues };
}
