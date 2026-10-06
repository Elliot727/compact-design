import type { ComponentPropertyPatchEntry, PatchSetValues } from "@compact-design/core";
import { detectVariantRenames, type AxisRename, type OptionRename } from "@compact-design/core";
import { componentPropertyMaps, resolveInstanceSwapTarget, type ImportContext } from "./nodes";

type ApplyCtx = { warnings: string[]; context: ImportContext; set: Record<string, unknown> };

function authoredName(key: string): string {
  const hash = key.indexOf("#");
  return hash >= 0 ? key.slice(0, hash) : key;
}

/** Apply name-keyed componentProperties upsert on a COMPONENT. */
export async function applyComponentPropertiesFigma(node: SceneNode, values: PatchSetValues, ctx: ApplyCtx): Promise<void> {
  if (node.type !== "COMPONENT") throw new Error(`'componentProperties' is not supported on Figma ${node.type} node '${node.name}'`);
  if (values.componentProperties === undefined) return;
  if (values.componentProperties === null) {
    for (const key of Object.keys(node.componentPropertyDefinitions || {})) {
      const def = node.componentPropertyDefinitions[key];
      if (def.type === "VARIANT" || def.type === "SLOT") continue;
      node.deleteComponentProperty(key);
    }
    return;
  }
  const { keys, types } = componentPropertyMaps(node);
  for (const [name, entry] of Object.entries(values.componentProperties)) {
    if (entry === null) {
      const key = keys.get(name);
      if (!key) continue;
      const def = node.componentPropertyDefinitions[key];
      if (def?.type === "VARIANT") throw new Error(`cannot delete VARIANT property '${name}'`);
      node.deleteComponentProperty(key);
      continue;
    }
    const existingKey = keys.get(name);
    if (!existingKey) {
      if (!entry.type) throw new Error(`component property '${name}': type is required when creating a property`);
      if (entry.defaultValue === undefined) throw new Error(`component property '${name}': defaultValue is required when creating a property`);
      const defaultValue = resolveInstanceSwapTarget(name, entry.type, entry.defaultValue, ctx.context);
      node.addComponentProperty(name, entry.type, defaultValue as string | boolean, entry.options || {});
      continue;
    }
    const existingType = types.get(name) || node.componentPropertyDefinitions[existingKey]?.type;
    if (entry.type !== undefined && entry.type !== existingType) {
      throw new Error(`component property '${name}': type is immutable after create (was ${existingType}, got ${entry.type})`);
    }
    const update: { name?: string; defaultValue?: string | boolean; preferredValues?: unknown[] } = {};
    if (entry.defaultValue !== undefined) {
      update.defaultValue = resolveInstanceSwapTarget(name, String(existingType), entry.defaultValue, ctx.context) as string | boolean;
    }
    if (entry.options?.preferredValues) update.preferredValues = entry.options.preferredValues;
    if (Object.keys(update).length) node.editComponentProperty(existingKey, update as never);
  }
}

function parseVariantName(name: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of name.split(",")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq > 0) result[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return result;
}

function formatVariantName(variant: Record<string, string>, axisOrder: string[]): string {
  return axisOrder.map((axis) => `${axis}=${variant[axis] ?? ""}`).join(", ");
}

function rewriteName(name: string, axisRenames: AxisRename[], optionRenames: OptionRename[], axisOrder: string[]): string {
  const variant = parseVariantName(name);
  for (const { from, to } of axisRenames) {
    if (from in variant) {
      variant[to] = variant[from];
      delete variant[from];
    }
  }
  for (const { axis, from, to } of optionRenames) {
    if (variant[axis] === from) variant[axis] = to;
  }
  return formatVariantName(variant, axisOrder);
}

async function rewriteInstanceVariantOverrides(
  axisRenames: AxisRename[],
  optionRenames: OptionRename[]
): Promise<void> {
  await figma.loadAllPagesAsync();
  const instances = figma.root.findAllWithCriteria({ types: ["INSTANCE"] });
  for (const instance of instances) {
    const props = instance.componentProperties || {};
    const updates: Record<string, string | boolean> = {};
    const staleKeys: string[] = [];
    let changed = false;
    for (const [key, value] of Object.entries(props)) {
      if (value.type !== "VARIANT") continue;
      let newKey = key;
      for (const { from, to } of axisRenames) if (key === from) newKey = to;
      let newValue = String(value.value);
      for (const { axis, from, to } of optionRenames) {
        if (newKey === axis && newValue === from) newValue = to;
      }
      if (newKey !== key || newValue !== value.value) {
        updates[newKey] = newValue;
        if (newKey !== key) staleKeys.push(key);
        changed = true;
      }
    }
    if (!changed) continue;
    // Figma remaps VARIANT keys on editComponentProperty; drop stale keys and write VARIANT typed values.
    for (const key of staleKeys) delete (props as Record<string, unknown>)[key];
    for (const [key, value] of Object.entries(updates)) {
      (props as Record<string, { type: string; value: string | boolean }>)[key] = { type: "VARIANT", value };
    }
    instance.setProperties(updates);
  }
}

/** Apply variantAxes shallow-merge on a COMPONENT_SET. */
export async function applyVariantAxesFigma(node: SceneNode, values: PatchSetValues, _ctx: ApplyCtx): Promise<void> {
  if (node.type !== "COMPONENT_SET") throw new Error(`'variantAxes' is not supported on Figma ${node.type} node '${node.name}'`);
  if (values.variantAxes === undefined) return;
  if (values.variantAxes === null) throw new Error("clearing all variant axes is not supported (Figma cannot delete VARIANT properties)");

  const definitions = node.componentPropertyDefinitions || {};
  const current: Record<string, string[]> = {};
  for (const [key, def] of Object.entries(definitions)) {
    if (def.type === "VARIANT") current[authoredName(key)] = [...(def.variantOptions || [])];
  }
  const detected = detectVariantRenames(current, values.variantAxes as Record<string, string[] | null>);
  if (detected.errors.length) throw new Error(detected.errors[0]);

  // Axis renames via editComponentProperty
  for (const { from, to } of detected.axisRenames) {
    const key = Object.keys(definitions).find((candidate) => authoredName(candidate) === from) || from;
    node.editComponentProperty(key, { name: to });
  }

  // Add new axes (not renames)
  for (const [axis, options] of Object.entries(detected.axes)) {
    if (detected.axisRenames.some((rename) => rename.to === axis)) continue;
    if (axis in current) continue;
    const defaultOption = options[0];
    node.addComponentProperty(axis, "VARIANT", defaultOption);
  }

  // Sync variantOptions on existing axes (Figma derives them from child names; keep definitions current).
  const defs = node.componentPropertyDefinitions;
  for (const [axis, options] of Object.entries(detected.axes)) {
    const key = Object.keys(defs).find((candidate) => authoredName(candidate) === axis) || axis;
    if (defs[key] && defs[key].type === "VARIANT") {
      (defs[key] as { variantOptions?: string[] }).variantOptions = [...options];
    }
  }

  // Rewrite child component names for option/axis renames and new option lists
  const axisOrder = Object.keys(detected.axes);
  for (const child of node.children) {
    if (child.type !== "COMPONENT") continue;
    child.name = rewriteName(child.name, detected.axisRenames, detected.optionRenames, axisOrder);
  }

  await rewriteInstanceVariantOverrides(detected.axisRenames, detected.optionRenames);
}

/** Apply variant selection on a COMPONENT inside a set by rewriting its name. */
export async function applyVariantFigma(node: SceneNode, values: PatchSetValues, _ctx: ApplyCtx): Promise<void> {
  if (node.type !== "COMPONENT") throw new Error(`'variant' is not supported on Figma ${node.type} node '${node.name}'`);
  if (values.variant === undefined) return;
  const parent = node.parent;
  if (!parent || parent.type !== "COMPONENT_SET") throw new Error("variant only applies to COMPONENT children of a COMPONENT_SET");
  if (values.variant === null) return;
  const variant = parseVariantName(node.name);
  const definitions = parent.componentPropertyDefinitions || {};
  const axes: Record<string, string[]> = {};
  for (const [key, def] of Object.entries(definitions)) {
    if (def.type === "VARIANT") axes[authoredName(key)] = [...(def.variantOptions || [])];
  }
  for (const [axis, value] of Object.entries(values.variant)) {
    if (value === null) {
      delete variant[axis];
      continue;
    }
    if (!axes[axis]) throw new Error(`variant.${axis}: axis '${axis}' is not declared on the parent COMPONENT_SET`);
    if (!axes[axis].includes(value)) throw new Error(`variant.${axis}: value '${value}' is not declared in variantAxes`);
    variant[axis] = value;
  }
  node.name = formatVariantName(variant, Object.keys(axes));
}
