import type { ComponentPropertyPatchEntry, DesignProperties, InternalNode, VariableAlias } from "./types";

export type AxisRename = { from: string; to: string };
export type OptionRename = { axis: string; from: string; to: string };

/**
 * Shallow-merge variantAxes with rename detection.
 * - Unmentioned axes are kept.
 * - `axis: null` alone → error (Figma cannot delete VARIANT props).
 * - Exactly one `old: null` paired with exactly one new axis key → axis rename.
 * - Within an axis, exactly one removed option + one added option → option rename.
 */
export function detectVariantRenames(
  current: Record<string, string[]>,
  patch: Record<string, string[] | null>
): { axes: Record<string, string[]>; axisRenames: AxisRename[]; optionRenames: OptionRename[]; errors: string[] } {
  const errors: string[] = [];
  const nullAxes = Object.entries(patch).filter(([, value]) => value === null).map(([key]) => key);
  const provided: Record<string, string[]> = {};
  for (const [axis, options] of Object.entries(patch)) {
    if (options === null) continue;
    if (!Array.isArray(options) || !options.length || options.some((option) => typeof option !== "string" || !option)) {
      errors.push(`variantAxes.${axis}: must be a non-empty string array`);
      continue;
    }
    if (new Set(options).size !== options.length) errors.push(`variantAxes.${axis}: options must be unique`);
    provided[axis] = options;
  }

  const freshAxes = Object.keys(provided).filter((axis) => !(axis in current));
  const axisRenames: AxisRename[] = [];
  if (nullAxes.length === 1 && freshAxes.length === 1) {
    axisRenames.push({ from: nullAxes[0], to: freshAxes[0] });
  } else if (nullAxes.length > 0) {
    for (const axis of nullAxes) {
      errors.push(`variantAxes.${axis}: deleting a variant axis is not supported (Figma cannot delete VARIANT properties)`);
    }
  }

  const axes: Record<string, string[]> = { ...current };
  for (const { from } of axisRenames) delete axes[from];
  for (const [axis, options] of Object.entries(provided)) axes[axis] = options;

  const optionRenames: OptionRename[] = [];
  const compareOptionRename = (axisKey: string, oldOptions: string[], newOptions: string[]) => {
    const removed = oldOptions.filter((option) => !newOptions.includes(option));
    const added = newOptions.filter((option) => !oldOptions.includes(option));
    if (removed.length === 1 && added.length === 1) optionRenames.push({ axis: axisKey, from: removed[0], to: added[0] });
  };

  for (const [axis, options] of Object.entries(provided)) {
    const rename = axisRenames.find((entry) => entry.to === axis);
    const oldOptions = rename ? current[rename.from] || [] : current[axis];
    if (oldOptions) compareOptionRename(axis, oldOptions, options);
  }

  return { axes, axisRenames, optionRenames, errors };
}

export function applyVariantRenamesInForest(
  roots: InternalNode[],
  setId: string,
  axisRenames: AxisRename[],
  optionRenames: OptionRename[],
  axes: Record<string, string[]>
): void {
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
    // Stay inside the target set for its descendants; do not treat nested sets as the same set.
    const childInside = node.type === "COMPONENT_SET" ? node.id === setId : inSet;
    for (const child of node.children) visit(child, childInside);
  };
  for (const root of roots) visit(root, false);
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
  patch: Record<string, string | null>,
  path: string
): string[] {
  const errors: string[] = [];
  if (!parent || parent.type !== "COMPONENT_SET") {
    errors.push(`${path}.variant: only applies to COMPONENT children of a COMPONENT_SET`);
    return errors;
  }
  const axes = parent.properties.variantAxes || {};
  const variant = { ...(node.properties.variant || {}) };
  for (const [axis, value] of Object.entries(patch)) {
    if (value === null) {
      delete variant[axis];
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
