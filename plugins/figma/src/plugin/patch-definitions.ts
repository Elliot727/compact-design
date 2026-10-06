import type { PatchSetValues, VariantAxesPatch, AxisRename, OptionRename } from "@compact-design/core";
import { detectVariantRenames } from "@compact-design/core";
import { componentPropertyMaps, resolveInstanceSwapTarget, type ImportContext } from "./nodes";

type ApplyCtx = {
  warnings: string[];
  context: ImportContext;
  set: Record<string, unknown>;
  /** COMPONENT_SETs that received variantAxes this patch; checked at end for uncarried options. */
  pendingVariantAxes?: Map<string, { node: ComponentSetNode; axes: Record<string, string[]> }>;
};

function authoredName(key: string): string {
  const hash = key.indexOf("#");
  return hash >= 0 ? key.slice(0, hash) : key;
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

/** Derive variant axes→options solely from COMPONENT child names (Figma source of truth). */
export function axesFromChildNames(set: ComponentSetNode): Record<string, string[]> {
  const axes: Record<string, string[]> = {};
  const order: string[] = [];
  for (const child of set.children) {
    if (child.type !== "COMPONENT") continue;
    const variant = parseVariantName(child.name);
    for (const [axis, option] of Object.entries(variant)) {
      if (!axes[axis]) {
        axes[axis] = [];
        order.push(axis);
      }
      if (!axes[axis].includes(option)) axes[axis].push(option);
    }
  }
  // Preserve axis order from first child encounter
  const ordered: Record<string, string[]> = {};
  for (const axis of order) ordered[axis] = axes[axis];
  return ordered;
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
  return formatVariantName(variant, axisOrder.length ? axisOrder : Object.keys(variant));
}

/** Apply name-keyed componentProperties upsert on a COMPONENT via add/edit/delete only. */
export async function applyComponentPropertiesFigma(node: SceneNode, values: PatchSetValues, ctx: ApplyCtx): Promise<void> {
  if (node.type !== "COMPONENT") throw new Error(`'componentProperties' is not supported on Figma ${node.type} node '${node.name}'`);
  if (values.componentProperties === undefined) return;
  if (values.componentProperties === null) {
    // Read keys from a copy; never mutate the returned definitions object.
    const definitions = node.componentPropertyDefinitions || {};
    for (const key of Object.keys(definitions)) {
      const def = definitions[key];
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

async function rewriteInstanceVariantOverrides(
  set: ComponentSetNode,
  axisRenames: AxisRename[],
  optionRenames: OptionRename[]
): Promise<void> {
  if (!axisRenames.length && !optionRenames.length) return;
  await figma.loadAllPagesAsync();
  const instances = figma.root.findAllWithCriteria({ types: ["INSTANCE"] });
  const childIds = new Set(set.children.filter((child) => child.type === "COMPONENT").map((child) => child.id));
  for (const instance of instances) {
    const main = await instance.getMainComponentAsync();
    if (!main || !childIds.has(main.id)) continue;
    // componentProperties returns a copy in real Figma — build updates and apply via setProperties only.
    const props = instance.componentProperties || {};
    const updates: Record<string, string | boolean> = {};
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
        changed = true;
      }
    }
    if (!changed) continue;
    // Axis rename via editComponentProperty on the set remaps keys in real Figma; setProperties
    // applies option value changes. Pass every remapped VARIANT value.
    instance.setProperties(updates);
  }
}

function childConflictsFromNames(
  set: ComponentSetNode,
  previousAxes: Record<string, string[]>,
  nextAxes: Record<string, string[]>,
  optionRenames: OptionRename[],
  axisRenames: AxisRename[]
): string[] {
  const errors: string[] = [];
  for (const child of set.children) {
    if (child.type !== "COMPONENT") continue;
    let variant = parseVariantName(child.name);
    for (const { from, to } of axisRenames) {
      if (from in variant) {
        variant = { ...variant, [to]: variant[from] };
        delete variant[from];
      }
    }
    for (const { axis, from, to } of optionRenames) {
      if (variant[axis] === from) variant[axis] = to;
    }
    for (const [axis, value] of Object.entries(variant)) {
      const options = nextAxes[axis];
      if (!options) {
        errors.push(`variantAxes: child '${child.name}' still uses axis '${axis}' which is not declared`);
        continue;
      }
      if (!options.includes(value)) {
        const priorAxis = axisRenames.find((rename) => rename.to === axis)?.from || axis;
        const priorOptions = previousAxes[priorAxis] || previousAxes[axis] || [];
        if (priorOptions.includes(value)) {
          errors.push(
            `variantAxes.${axis}: option '${value}' is used by a variant child but was removed without renameOptions (use renameOptions: { "${value}": "NewName" } or update the child's variant first)`
          );
        } else {
          errors.push(`variantAxes.${axis}: child has value '${value}' which is not declared`);
        }
      }
    }
  }
  return errors;
}

/** Apply variantAxes shallow-merge on a COMPONENT_SET. Options come only from child names. */
export async function applyVariantAxesFigma(node: SceneNode, values: PatchSetValues, ctx: ApplyCtx): Promise<void> {
  if (node.type !== "COMPONENT_SET") throw new Error(`'variantAxes' is not supported on Figma ${node.type} node '${node.name}'`);
  if (values.variantAxes === undefined) return;
  if (values.variantAxes === null) throw new Error("clearing all variant axes is not supported (Figma cannot delete VARIANT properties)");

  const current = axesFromChildNames(node);
  // Also include VARIANT property keys that exist but have no children yet (new empty axis edge case).
  const definitions = node.componentPropertyDefinitions || {};
  for (const [key, def] of Object.entries(definitions)) {
    if (def.type === "VARIANT" && !(authoredName(key) in current)) current[authoredName(key)] = [];
  }

  const detected = detectVariantRenames(current, values.variantAxes as VariantAxesPatch);
  if (detected.errors.length) throw new Error(detected.errors[0]);
  const conflicts = childConflictsFromNames(node, current, detected.axes, detected.optionRenames, detected.axisRenames);
  if (conflicts.length) throw new Error(conflicts[0]);

  // Axis renames via editComponentProperty (do not mutate definition copies).
  for (const { from, to } of detected.axisRenames) {
    const key = Object.keys(definitions).find((candidate) => authoredName(candidate) === from) || from;
    node.editComponentProperty(key, { name: to });
  }

  // Add new axes (not renames) — default value is the first declared option; children must carry it by end of patch.
  for (const [axis, options] of Object.entries(detected.axes)) {
    if (detected.axisRenames.some((rename) => rename.to === axis)) continue;
    if (axis in current) continue;
    node.addComponentProperty(axis, "VARIANT", options[0]);
  }

  // Rewrite child component names for explicit renames (Figma derives options from these names).
  const axisOrder = Object.keys(detected.axes);
  for (const child of node.children) {
    if (child.type !== "COMPONENT") continue;
    child.name = rewriteName(child.name, detected.axisRenames, detected.optionRenames, axisOrder);
  }

  await rewriteInstanceVariantOverrides(node, detected.axisRenames, detected.optionRenames);

  if (!ctx.pendingVariantAxes) ctx.pendingVariantAxes = new Map();
  const compactId = node.getPluginData("compactDesignId") || node.id;
  ctx.pendingVariantAxes.set(compactId, { node, axes: detected.axes });
}

/** Flush deferred uncarried-option checks after all patch ops (same-patch child variant can carry new options). */
export function assertPendingVariantAxesCarried(pending: Map<string, { node: ComponentSetNode; axes: Record<string, string[]> }> | undefined): void {
  if (!pending) return;
  for (const { node, axes } of pending.values()) {
    // Build a faux InternalNode-shaped check via child names
    const carried: Record<string, Set<string>> = {};
    for (const axis of Object.keys(axes)) carried[axis] = new Set();
    for (const child of node.children) {
      if (child.type !== "COMPONENT") continue;
      for (const [axis, value] of Object.entries(parseVariantName(child.name))) {
        if (carried[axis]) carried[axis].add(value);
      }
    }
    for (const [axis, options] of Object.entries(axes)) {
      for (const option of options) {
        if (!carried[axis]?.has(option)) {
          throw new Error(
            `variantAxes.${axis}: option '${option}' is not carried by any variant child (add or set a COMPONENT child's variant to '${option}', or use renameOptions)`
          );
        }
      }
    }
  }
}

/** Apply variant selection on a COMPONENT inside a set by rewriting its name. */
export async function applyVariantFigma(node: SceneNode, values: PatchSetValues, ctx: ApplyCtx): Promise<void> {
  if (node.type !== "COMPONENT") throw new Error(`'variant' is not supported on Figma ${node.type} node '${node.name}'`);
  if (values.variant === undefined) return;
  const parent = node.parent;
  if (!parent || parent.type !== "COMPONENT_SET") throw new Error("variant only applies to COMPONENT children of a COMPONENT_SET");
  if (values.variant === null) {
    throw new Error("variant: clearing variant on a COMPONENT inside a COMPONENT_SET is not supported (variant components require a selection)");
  }
  const variant = parseVariantName(node.name);
  const compactSetId = parent.getPluginData("compactDesignId") || parent.id;
  const pending = ctx.pendingVariantAxes?.get(compactSetId)?.axes;
  const axes: Record<string, string[]> = { ...(pending || axesFromChildNames(parent)) };
  const definitions = parent.componentPropertyDefinitions || {};
  for (const [key, def] of Object.entries(definitions)) {
    if (def.type === "VARIANT" && !(authoredName(key) in axes)) axes[authoredName(key)] = [];
  }
  for (const [axis, value] of Object.entries(values.variant)) {
    if (value === null) {
      throw new Error(`variant.${axis}: clearing an axis on a variant COMPONENT is not supported`);
    }
    if (!(axis in axes)) {
      throw new Error(`variant.${axis}: axis '${axis}' is not declared on the parent COMPONENT_SET`);
    }
    const options = axes[axis] || [];
    if (options.length && !options.includes(value)) {
      throw new Error(`variant.${axis}: value '${value}' is not declared in variantAxes`);
    }
    variant[axis] = value;
  }
  const axisOrder = Object.keys(axes).length ? Object.keys(axes) : Object.keys(variant);
  node.name = formatVariantName(variant, axisOrder);
}
