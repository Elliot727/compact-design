import type { ComponentPropertyPatchEntry, DesignProperties, InternalNode, VariableAlias } from "./types";

export type AxisRename = { from: string; to: string };
export type OptionRename = { axis: string; from: string; to: string };

/** Explicit variantAxes patch entry: array sets options (never renames); object renames explicitly. */
export type VariantAxisPatchEntry =
  | null
  | string[]
  | {
      rename?: string;
      options?: string[];
      renameOptions?: Record<string, string>;
    };

export type VariantAxesPatch = Record<string, VariantAxisPatchEntry>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(path: string, options: string[], errors: string[]): string[] | null {
  if (!options.length || options.some((option) => typeof option !== "string" || !option)) {
    errors.push(`${path}: must be a non-empty string array`);
    return null;
  }
  if (new Set(options).size !== options.length) {
    errors.push(`${path}: options must be unique`);
    return null;
  }
  return options;
}

/**
 * Apply a variantAxes shallow-merge with **explicit** renames only.
 * - `axis: string[]` — replace that axis's options. Never inferred as a rename.
 * - `axis: { rename?, options?, renameOptions? }` — explicit axis/option renames.
 * - `axis: null` — error (Figma cannot delete VARIANT properties).
 * Unmentioned axes are kept.
 */
export function detectVariantRenames(
  current: Record<string, string[]>,
  patch: VariantAxesPatch
): { axes: Record<string, string[]>; axisRenames: AxisRename[]; optionRenames: OptionRename[]; errors: string[] } {
  const errors: string[] = [];
  const axes: Record<string, string[]> = { ...current };
  const axisRenames: AxisRename[] = [];
  const optionRenames: OptionRename[] = [];

  for (const [axis, entry] of Object.entries(patch)) {
    const path = `variantAxes.${axis}`;
    if (entry === null) {
      errors.push(`${path}: deleting a variant axis is not supported (Figma cannot delete VARIANT properties)`);
      continue;
    }

    if (Array.isArray(entry)) {
      const options = uniqueStrings(path, entry, errors);
      if (!options) continue;
      if (!(axis in current) && !(axis in axes)) {
        // new axis
      } else if (!(axis in axes) && axisRenames.some((rename) => rename.to === axis)) {
        // renamed onto this key in an earlier entry — shouldn't happen for array form on fresh key
      }
      axes[axis] = options;
      continue;
    }

    if (!isPlainObject(entry)) {
      errors.push(`${path}: must be a string array, null, or { rename?, options?, renameOptions? }`);
      continue;
    }

    const renameTo = entry.rename;
    const renameOptionsRaw = entry.renameOptions;
    const optionsRaw = entry.options;

    if (renameTo !== undefined && (typeof renameTo !== "string" || !renameTo)) {
      errors.push(`${path}.rename: must be a non-empty string`);
      continue;
    }
    if (renameTo !== undefined && renameTo !== axis) {
      if (!(axis in current) && !(axis in axes)) {
        errors.push(`${path}: cannot rename unknown axis '${axis}'`);
      } else if (renameTo in axes && renameTo !== axis) {
        errors.push(`${path}.rename: axis '${renameTo}' already exists`);
      } else {
        axisRenames.push({ from: axis, to: renameTo });
        const prior = axes[axis] || current[axis] || [];
        delete axes[axis];
        axes[renameTo] = [...prior];
      }
    }

    const axisKey = typeof renameTo === "string" && renameTo ? renameTo : axis;
    const baseOptions = axes[axisKey] || current[axis] || [];

    const explicitOptionRenames: OptionRename[] = [];
    if (renameOptionsRaw !== undefined) {
      if (!isPlainObject(renameOptionsRaw)) {
        errors.push(`${path}.renameOptions: must be an object of old→new option names`);
      } else {
        for (const [from, to] of Object.entries(renameOptionsRaw)) {
          if (typeof to !== "string" || !to) {
            errors.push(`${path}.renameOptions.${from}: must be a non-empty string`);
            continue;
          }
          if (!baseOptions.includes(from)) {
            errors.push(`${path}.renameOptions.${from}: option '${from}' is not on axis '${axisKey}'`);
            continue;
          }
          explicitOptionRenames.push({ axis: axisKey, from, to });
        }
      }
    }

    let nextOptions = [...baseOptions];
    for (const { from, to } of explicitOptionRenames) {
      nextOptions = nextOptions.map((option) => (option === from ? to : option));
    }

    if (optionsRaw !== undefined) {
      if (!Array.isArray(optionsRaw)) {
        errors.push(`${path}.options: must be a string array`);
      } else {
        const options = uniqueStrings(`${path}.options`, optionsRaw as string[], errors);
        if (options) nextOptions = options;
      }
    } else if (explicitOptionRenames.length) {
      // dedupe while preserving order after renames
      nextOptions = [...new Set(nextOptions)];
    }

    if (!nextOptions.length) {
      errors.push(`${path}: options must be a non-empty string array`);
      continue;
    }
    if (new Set(nextOptions).size !== nextOptions.length) {
      errors.push(`${path}: options must be unique`);
      continue;
    }

    axes[axisKey] = nextOptions;
    optionRenames.push(...explicitOptionRenames);
  }

  return { axes, axisRenames, optionRenames, errors };
}

/** After renames, ensure removed options are not still sitting on children without renameOptions. */
export function variantAxesChildConflicts(
  set: InternalNode,
  previousAxes: Record<string, string[]>,
  nextAxes: Record<string, string[]>,
  optionRenames: OptionRename[],
  axisRenames: AxisRename[]
): string[] {
  const errors: string[] = [];
  const renamedAway = new Set(optionRenames.map((rename) => `${rename.axis}\0${rename.from}`));
  const axisFrom = new Map(axisRenames.map((rename) => [rename.from, rename.to]));

  for (const child of set.children) {
    if (child.type !== "COMPONENT") continue;
    const variant = { ...(child.properties.variant || {}) };
    for (const [from, to] of axisFrom) {
      if (from in variant) {
        variant[to] = variant[from];
        delete variant[from];
      }
    }
    for (const { axis, from, to } of optionRenames) {
      if (variant[axis] === from) variant[axis] = to;
    }
    for (const [axis, value] of Object.entries(variant)) {
      const options = nextAxes[axis];
      if (!options) {
        errors.push(`variantAxes: child '${child.id}' still uses axis '${axis}' which is not declared`);
        continue;
      }
      if (!options.includes(value)) {
        const priorAxis = [...axisFrom.entries()].find(([, to]) => to === axis)?.[0] || axis;
        const priorOptions = previousAxes[priorAxis] || previousAxes[axis] || [];
        if (priorOptions.includes(value) || renamedAway.has(`${axis}\0${value}`)) {
          errors.push(
            `variantAxes.${axis}: option '${value}' is used by variant child '${child.id}' but was removed without renameOptions (use renameOptions: { "${value}": "NewName" } or update the child's variant first)`
          );
        } else {
          errors.push(`variantAxes.${axis}: child '${child.id}' has value '${value}' which is not declared`);
        }
      }
    }
  }
  return errors;
}

/** Every declared option must appear on at least one COMPONENT child (Figma derives options from names). */
export function variantAxesUncarriedOptions(set: InternalNode, axes: Record<string, string[]>): string[] {
  const errors: string[] = [];
  const carried: Record<string, Set<string>> = {};
  for (const axis of Object.keys(axes)) carried[axis] = new Set();
  for (const child of set.children) {
    if (child.type !== "COMPONENT") continue;
    for (const [axis, value] of Object.entries(child.properties.variant || {})) {
      if (carried[axis]) carried[axis].add(value);
    }
  }
  for (const [axis, options] of Object.entries(axes)) {
    for (const option of options) {
      if (!carried[axis]?.has(option)) {
        errors.push(
          `variantAxes.${axis}: option '${option}' is not carried by any variant child (add or set a COMPONENT child's variant to '${option}', or use renameOptions)`
        );
      }
    }
  }
  return errors;
}

export function applyVariantRenamesInForest(
  roots: InternalNode[],
  setId: string,
  axisRenames: AxisRename[],
  optionRenames: OptionRename[],
  axes: Record<string, string[]>,
  index?: Map<string, { node: InternalNode; parent: InternalNode | null }>
): void {
  const childIds = new Set<string>();
  const collectChildren = (node: InternalNode, inside: boolean): void => {
    const inSet = inside || (node.type === "COMPONENT_SET" && node.id === setId);
    if (node.type === "COMPONENT" && inSet && node.id !== setId) childIds.add(node.id);
    const childInside = node.type === "COMPONENT_SET" ? node.id === setId : inSet;
    for (const child of node.children) collectChildren(child, childInside);
  };
  for (const root of roots) collectChildren(root, false);

  const visit = (node: InternalNode, insideTargetSet: boolean): void => {
    const inSet = insideTargetSet || (node.type === "COMPONENT_SET" && node.id === setId);
    if (node.type === "COMPONENT" && inSet && node.id !== setId) {
      const variant = { ...(node.properties.variant || {}) };
      for (const { from, to } of axisRenames) {
        if (from in variant) {
          variant[to] = variant[from];
          delete variant[from];
        }
      }
      for (const { axis, from, to } of optionRenames) {
        if (variant[axis] === from) variant[axis] = to;
      }
      node.properties.variant = Object.keys(variant).length ? variant : undefined;
      if (Object.keys(axes).length) {
        node.name = Object.keys(axes).map((axis) => `${axis}=${variant[axis] ?? axes[axis][0]}`).join(", ");
      }
    }
    if (node.type === "INSTANCE" && node.properties.instanceProperties) {
      const mainId = node.properties.componentId;
      // Only rewrite instances whose main component is a child of the patched set.
      if (!mainId || !childIds.has(mainId)) {
        // fall through to children only
      } else {
        const next: Record<string, string | boolean | VariableAlias> = {};
        for (const [key, value] of Object.entries(node.properties.instanceProperties)) {
          let newKey = key;
          for (const { from, to } of axisRenames) if (key === from) newKey = to;
          let newValue: string | boolean | VariableAlias = value;
          if (typeof value === "string") {
            for (const { axis, from, to } of optionRenames) {
              if (newKey === axis && value === from) newValue = to;
            }
          }
          next[newKey] = newValue;
        }
        node.properties.instanceProperties = next;
      }
    }
    const childInside = node.type === "COMPONENT_SET" ? node.id === setId : inSet;
    for (const child of node.children) visit(child, childInside);
  };
  for (const root of roots) visit(root, false);
  void index;
}

export function applyComponentPropertiesPatch(
  props: DesignProperties,
  patch: Record<string, ComponentPropertyPatchEntry | null> | null,
  path: string
): string[] {
  const errors: string[] = [];
  if (patch === null) {
    delete props.componentProperties;
    return errors;
  }
  const list = [...(props.componentProperties || [])];
  const indexByName = () => {
    const map = new Map<string, number>();
    list.forEach((property, index) => map.set(property.name, index));
    return map;
  };
  let byName = indexByName();
  for (const [name, entry] of Object.entries(patch)) {
    if (entry === null) {
      const index = byName.get(name);
      if (index === undefined) continue;
      list.splice(index, 1);
      byName = indexByName();
      continue;
    }
    const existingIndex = byName.get(name);
    if (existingIndex === undefined) {
      if (!entry.type) {
        errors.push(`${path}.componentProperties.${name}: type is required when creating a property`);
        continue;
      }
      if (entry.defaultValue === undefined) {
        errors.push(`${path}.componentProperties.${name}: defaultValue is required when creating a property`);
        continue;
      }
      list.push({
        name,
        type: entry.type,
        defaultValue: entry.defaultValue,
        ...(entry.options ? { options: entry.options } : {})
      });
      byName = indexByName();
      continue;
    }
    const existing = list[existingIndex];
    if (entry.type !== undefined && entry.type !== existing.type) {
      errors.push(`${path}.componentProperties.${name}: type is immutable after create (was ${existing.type}, got ${entry.type})`);
      continue;
    }
    list[existingIndex] = {
      ...existing,
      ...(entry.defaultValue !== undefined ? { defaultValue: entry.defaultValue } : {}),
      ...(entry.options !== undefined ? { options: entry.options } : {})
    };
  }
  if (list.length) props.componentProperties = list;
  else delete props.componentProperties;
  return errors;
}

export function applyVariantPatchOnComponent(
  node: InternalNode,
  parent: InternalNode | null,
  patch: Record<string, string | null> | null,
  path: string
): string[] {
  const errors: string[] = [];
  if (!parent || parent.type !== "COMPONENT_SET") {
    errors.push(`${path}.variant: only applies to COMPONENT children of a COMPONENT_SET`);
    return errors;
  }
  if (patch === null) {
    errors.push(`${path}.variant: clearing variant on a COMPONENT inside a COMPONENT_SET is not supported (variant components require a selection)`);
    return errors;
  }
  const axes = parent.properties.variantAxes || {};
  const variant = { ...(node.properties.variant || {}) };
  for (const [axis, value] of Object.entries(patch)) {
    if (value === null) {
      errors.push(`${path}.variant.${axis}: clearing an axis on a variant COMPONENT is not supported`);
      continue;
    }
    if (!axes[axis]) {
      errors.push(`${path}.variant.${axis}: axis '${axis}' is not declared on the parent COMPONENT_SET`);
      continue;
    }
    if (!axes[axis].includes(value)) {
      errors.push(`${path}.variant.${axis}: value '${value}' is not declared in variantAxes`);
      continue;
    }
    variant[axis] = value;
  }
  node.properties.variant = Object.keys(variant).length ? variant : undefined;
  if (Object.keys(axes).length) {
    node.name = Object.keys(axes).map((axis) => `${axis}=${variant[axis] ?? axes[axis][0]}`).join(", ");
  }
  return errors;
}

export function rewriteVariantChildNames(set: InternalNode): void {
  const axes = set.properties.variantAxes || {};
  for (const child of set.children) {
    if (child.type !== "COMPONENT") continue;
    const selected = child.properties.variant || {};
    child.name = Object.keys(axes).map((axis) => `${axis}=${selected[axis] ?? axes[axis][0]}`).join(", ");
  }
}
