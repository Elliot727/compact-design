import type { InternalNode } from "@compact-design/core";
import { applyAutoLayout, applyChildLayout, applyGeometry, applyGrids } from "./layout";
import { applyAppearance } from "./paints";
import { applyResources, type Resources } from "./resources";
import { applyText } from "./text";
import { clamp, finite } from "./value";

export interface ImportContext {
  sourceNodes: Map<string, SceneNode>;
  componentPropertyKeys: Map<string, Map<string, string>>;
  /** Authored property name (and generated key) → type, keyed by COMPONENT compact id. */
  componentPropertyTypes: Map<string, Map<string, string>>;
  resources: Resources;
  createdNodes: SceneNode[];
}

function createBasic(data: InternalNode, context: ImportContext): SceneNode {
  const p = data.properties;
  switch (data.type) {
    case "FRAME": return figma.createFrame(); case "COMPONENT": return figma.createComponent();
    case "RECTANGLE": return figma.createRectangle(); case "ELLIPSE": case "ARC": return figma.createEllipse();
    case "LINE": return figma.createLine(); case "POLYGON": return figma.createPolygon(); case "STAR": return figma.createStar();
    case "SECTION": return figma.createSection(); case "SLICE": return figma.createSlice(); case "VECTOR": return figma.createVector();
    case "TEXT": return figma.createText(); case "SVG": {
      if (!p.svg) throw new Error(`SVG '${data.id}' requires svg markup`);
      return figma.createNodeFromSvg(p.svg);
    }
    case "INSTANCE": {
      if (!p.componentId) throw new Error(`Instance '${data.id}' requires componentId`);
      const component = context.sourceNodes.get(p.componentId);
      if (!component || component.type !== "COMPONENT") throw new Error(`Instance '${data.id}' references missing component '${p.componentId}'`);
      return component.createInstance();
    }
    default: throw new Error(`Unsupported node type '${data.type}' at '${data.id}'`);
  }
}

async function createCompound(data: InternalNode, parent: BaseNode & ChildrenMixin, origin: { x: number; y: number }, context: ImportContext): Promise<SceneNode> {
  const children: SceneNode[] = [];
  for (const child of data.children) children.push(await createNode(child, parent, origin, context));
  if (!children.length) throw new Error(`${data.type} '${data.id}' requires children`);
  let node: SceneNode;
  if (data.type === "GROUP") node = figma.group(children, parent);
  else if (data.type === "COMPONENT_SET") {
    if (!children.every((child) => child.type === "COMPONENT")) throw new Error(`Component set '${data.id}' may contain only COMPONENT children`);
    node = figma.combineAsVariants(children as ComponentNode[], parent);
  }
  else {
    const operation = data.properties.operation || "UNION";
    node = operation === "SUBTRACT" ? figma.subtract(children, parent) : operation === "INTERSECT" ? figma.intersect(children, parent) : operation === "EXCLUDE" ? figma.exclude(children, parent) : figma.union(children, parent);
  }
  node.name = data.name; node.setPluginData("compactDesignId", data.id);
  node.x = finite(data.properties.position.x, 0) - origin.x; node.y = finite(data.properties.position.y, 0) - origin.y;
  context.createdNodes.push(node); await applyAppearance(node, data.properties, false); context.sourceNodes.set(data.id, node); return node;
}

export async function createNode(data: InternalNode, parent: BaseNode & ChildrenMixin, origin: { x: number; y: number }, context: ImportContext): Promise<SceneNode> {
  if (["GROUP", "BOOLEAN_OPERATION", "COMPONENT_SET"].includes(data.type)) return createCompound(data, parent, origin, context);
  const p = data.properties;
  const node = createBasic(data, context); parent.appendChild(node); context.createdNodes.push(node); node.name = data.name; node.setPluginData("compactDesignId", data.id);
  applyGeometry(node, p, origin); context.sourceNodes.set(data.id, node);
  if (node.type === "VECTOR") {
    node.vectorPaths = (p.vectorPaths || []).map((path: VectorPath) => ({
      ...path,
      // Figma's path parser requires whitespace separators; ordinary SVG also
      // permits commas, which LLMs and vector editors commonly emit.
      data: String(path.data || "").replace(/,/g, " ").replace(/\s+/g, " ").trim()
    }));
  }
  if (node.type === "POLYGON" && typeof p.pointCount === "number" && Number.isFinite(p.pointCount)) node.pointCount = Math.max(3, Math.round(p.pointCount));
  if (node.type === "STAR") { if (typeof p.pointCount === "number" && Number.isFinite(p.pointCount)) node.pointCount = Math.max(3, Math.round(p.pointCount)); if (typeof p.innerRadius === "number" && Number.isFinite(p.innerRadius)) node.innerRadius = clamp(p.innerRadius, 0, 1); }
  if (data.type === "ARC" && node.type === "ELLIPSE") node.arcData = { startingAngle: finite(p.startingAngle, 0), endingAngle: finite(p.endingAngle, Math.PI * 1.5), innerRadius: clamp(finite(p.innerRadiusRatio, 0), 0, 1) };
  if (node.type === "TEXT") await applyText(node, p);
  if (node.type === "COMPONENT") {
    const propertyKeys = new Map<string, string>();
    const propertyTypes = new Map<string, string>();
    for (const property of p.componentProperties || []) {
      const defaultValue = resolveInstanceSwapTarget(property.name, property.type, property.defaultValue, context);
      const generatedKey = node.addComponentProperty(property.name, property.type, defaultValue, property.options || {});
      propertyKeys.set(property.name, generatedKey);
      propertyKeys.set(generatedKey, generatedKey);
      propertyTypes.set(property.name, property.type);
      propertyTypes.set(generatedKey, property.type);
    }
    context.componentPropertyKeys.set(data.id, propertyKeys);
    context.componentPropertyTypes.set(data.id, propertyTypes);
  }
  if (node.type === "INSTANCE" && p.instanceProperties) {
    const propertyKeys = p.componentId ? context.componentPropertyKeys.get(p.componentId) : undefined;
    const propertyTypes = p.componentId ? context.componentPropertyTypes.get(p.componentId) : undefined;
    const overrides = Object.fromEntries(Object.entries(p.instanceProperties).map(([key, value]) => {
      const mappedKey = propertyKeys?.get(key) || key;
      const propType = propertyTypes?.get(key) || propertyTypes?.get(mappedKey);
      // Only INSTANCE_SWAP values are compact component ids; TEXT/BOOLEAN pass through unchanged
      // (a TEXT value may legitimately equal a node id).
      const mappedValue = propType === "INSTANCE_SWAP"
        ? resolveInstanceSwapTarget(key, "INSTANCE_SWAP", value, context)
        : value;
      return [mappedKey, mappedValue];
    })) as Record<string, string | boolean | VariableAlias>;
    node.setProperties(overrides);
  }
  await applyAppearance(node, p, node.type === "TEXT");
  if (node.type === "FRAME" || node.type === "COMPONENT") applyAutoLayout(node, p.layout);
  if ("overflowDirection" in node && p.overflowDirection) node.overflowDirection = p.overflowDirection;
  applyChildLayout(node, p); applyGrids(node, p.layoutGrids || []); await applyResources(node, p, context.resources);
  if (p.breakpoint) node.setPluginData("breakpoint", JSON.stringify(p.breakpoint));
  if (node.type === "FRAME" || node.type === "COMPONENT") {
    if (p.clipsContent === undefined) node.clipsContent = false;
    const childOrigin = { x: finite(p.position.x, 0), y: finite(p.position.y, 0) };
    for (const child of data.children) await createNode(child, node, childOrigin, context);
    if ("numberOfFixedChildren" in node && typeof p.numberOfFixedChildren === "number" && Number.isFinite(p.numberOfFixedChildren)) node.numberOfFixedChildren = Math.max(0, Math.min(node.children.length, Math.round(p.numberOfFixedChildren)));
  }
  // Second pass: bind child layers to component properties after children exist.
  // Figma appends #id suffixes to TEXT/BOOLEAN/INSTANCE_SWAP keys from addComponentProperty.
  if (node.type === "COMPONENT") {
    const propertyKeys = context.componentPropertyKeys.get(data.id);
    if (propertyKeys) {
      for (const childData of data.children) {
        const childScene = node.children.find((child) => child.getPluginData("compactDesignId") === childData.id);
        if (childScene) applyComponentPropertyReferencesTree(childData, childScene, propertyKeys);
      }
    }
  }
  return node;
}

/** Map an INSTANCE_SWAP compact id to a Figma COMPONENT id, or throw a clear error. Non-swap values pass through. */
export function resolveInstanceSwapTarget(propertyName: string, propertyType: string, value: string | boolean | VariableAlias, context: ImportContext): string | boolean | VariableAlias {
  if (propertyType !== "INSTANCE_SWAP") return value;
  if (typeof value !== "string") return value;
  let target = context.sourceNodes.get(value);
  if (!target || target.type !== "COMPONENT") {
    // Patch path: look up by compactDesignId on the live page.
    const found = figma.currentPage.findAll((node) => node.getPluginData("compactDesignId") === value && node.type === "COMPONENT")[0];
    if (found && found.type === "COMPONENT") target = found;
  }
  if (!target || target.type !== "COMPONENT") {
    throw new Error(`component property '${propertyName}' references missing component '${value}'`);
  }
  return target.id;
}


/** Build authored-name → generated-key and type maps from a live COMPONENT. */
export function componentPropertyMaps(component: ComponentNode): { keys: Map<string, string>; types: Map<string, string> } {
  const keys = new Map<string, string>();
  const types = new Map<string, string>();
  const definitions = component.componentPropertyDefinitions || {};
  for (const [key, def] of Object.entries(definitions)) {
    const name = key.includes("#") ? key.slice(0, key.indexOf("#")) : key;
    keys.set(name, key);
    keys.set(key, key);
    types.set(name, def.type);
    types.set(key, def.type);
  }
  return { keys, types };
}

/** Map authored instanceProperty overrides to Figma generated keys + INSTANCE_SWAP ids. */
export function mapInstancePropertyOverrides(
  overrides: Record<string, string | boolean | VariableAlias | null>,
  propertyKeys: Map<string, string>,
  propertyTypes: Map<string, string>,
  context: ImportContext
): Record<string, string | boolean | VariableAlias> {
  const result: Record<string, string | boolean | VariableAlias> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) continue; // cleared entries are omitted; Figma has no per-key clear via setProperties alone
    const mappedKey = propertyKeys.get(key) || key;
    const propType = propertyTypes.get(key) || propertyTypes.get(mappedKey) || "";
    result[mappedKey] = resolveInstanceSwapTarget(key, propType, value, context) as string | boolean | VariableAlias;
  }
  return result;
}

/** Map authored componentPropertyReferences to generated keys (null fields omitted). */
export function mapComponentPropertyReferences(
  refs: { characters?: string | null; visible?: string | null; mainComponent?: string | null },
  propertyKeys: Map<string, string>
): { characters?: string; visible?: string; mainComponent?: string } {
  const mapped: { characters?: string; visible?: string; mainComponent?: string } = {};
  if (typeof refs.characters === "string") mapped.characters = propertyKeys.get(refs.characters) || refs.characters;
  if (typeof refs.visible === "string") mapped.visible = propertyKeys.get(refs.visible) || refs.visible;
  if (typeof refs.mainComponent === "string") mapped.mainComponent = propertyKeys.get(refs.mainComponent) || refs.mainComponent;
  return mapped;
}


/**
 * Assign componentPropertyReferences on a COMPONENT descendant tree.
 * Stops at nested COMPONENT (owns its own props) and INSTANCE (no authored sublayers).
 */
export function applyComponentPropertyReferencesTree(data: InternalNode, scene: SceneNode, propertyKeys: Map<string, string>): void {
  const refs = data.properties.componentPropertyReferences;
  if (refs && typeof refs === "object") {
    const mapped: { characters?: string; visible?: string; mainComponent?: string } = {};
    if (typeof refs.characters === "string") mapped.characters = propertyKeys.get(refs.characters) || refs.characters;
    if (typeof refs.visible === "string") mapped.visible = propertyKeys.get(refs.visible) || refs.visible;
    if (typeof refs.mainComponent === "string") mapped.mainComponent = propertyKeys.get(refs.mainComponent) || refs.mainComponent;
    if (Object.keys(mapped).length) scene.componentPropertyReferences = mapped;
  }
  if (data.type === "COMPONENT" || data.type === "INSTANCE") return;
  if (!("children" in scene) || !data.children.length) return;
  for (const childData of data.children) {
    const childScene = scene.children.find((child) => child.getPluginData("compactDesignId") === childData.id);
    if (childScene) applyComponentPropertyReferencesTree(childData, childScene, propertyKeys);
  }
}
