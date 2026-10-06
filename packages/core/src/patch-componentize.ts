import type { ComponentPropertyType, DesignProperties, InternalNode } from "./types";

/** Declared componentize property: type + source-layer id. */
export type ComponentizePropertyDecl = { type: ComponentPropertyType; layer: string };
export type ComponentizeProperties = Record<string, ComponentizePropertyDecl>;

/** Child-index path from root to a descendant (empty = root). */
export function indexPathTo(root: InternalNode, targetId: string): number[] | null {
  if (root.id === targetId) return [];
  const walk = (node: InternalNode, path: number[]): number[] | null => {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const next = [...path, i];
      if (child.id === targetId) return next;
      const nested = walk(child, next);
      if (nested) return nested;
    }
    return null;
  };
  return walk(root, []);
}

export function nodeAtPath(root: InternalNode, path: number[]): InternalNode | null {
  let current: InternalNode = root;
  for (const index of path) {
    if (index < 0 || index >= current.children.length) return null;
    current = current.children[index];
  }
  return current;
}

/**
 * Match a source layer into a copy by identical child-index path and type at every level.
 */
export function matchLayer(sourceRoot: InternalNode, copyRoot: InternalNode, sourceLayerId: string): InternalNode | null {
  const path = indexPathTo(sourceRoot, sourceLayerId);
  if (path === null) return null;
  // Root types may differ after promote (FRAME→COMPONENT vs still-FRAME copy).
  let sourceCursor: InternalNode = sourceRoot;
  let copyCursor: InternalNode = copyRoot;
  for (const index of path) {
    if (index >= sourceCursor.children.length || index >= copyCursor.children.length) return null;
    sourceCursor = sourceCursor.children[index];
    copyCursor = copyCursor.children[index];
    if (sourceCursor.type !== copyCursor.type) return null;
  }
  return copyCursor;
}

export function readPropertyValue(node: InternalNode, type: ComponentPropertyType): string | boolean | undefined {
  if (type === "TEXT") return node.properties.text ?? "";
  if (type === "BOOLEAN") return node.properties.visible !== false;
  if (type === "INSTANCE_SWAP") return node.properties.componentId;
  return undefined;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function eq(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function ignoredFieldForProperty(type: ComponentPropertyType): string {
  if (type === "TEXT") return "text";
  if (type === "BOOLEAN") return "visible";
  return "componentId";
}

/**
 * Strict structural diff. Returns a relative path (e.g. `children[1].fill`) or null.
 * Always compares size (Gate: w/h must match), bindings, styleRefs, effects, prototype.
 * On the copy root only, name/x/y/constraints/layout-child props/variableModes/visible may differ.
 */
export function structuralDiff(
  source: InternalNode,
  copy: InternalNode,
  ignore: { properties: ComponentizeProperties },
  path = "",
  /** Absolute origins of each root — non-root positions are compared parent-relative via these. */
  origins?: { source: { x: number; y: number }; copy: { x: number; y: number } }
): string | null {
  const isRoot = path === "";
  const label = (key: string) => (path ? `${path}.${key}` : key);
  const sourceOrigin = origins?.source ?? source.properties.position;
  const copyOrigin = origins?.copy ?? copy.properties.position;
  const nextOrigins = { source: sourceOrigin, copy: copyOrigin };

  if (source.type !== copy.type) return label("type");

  const ignored = new Set<string>();
  for (const decl of Object.values(ignore.properties)) {
    if (decl.layer === source.id) ignored.add(ignoredFieldForProperty(decl.type));
  }

  const sp = source.properties;
  const cp = copy.properties;

  // Gate amendment: w/h must equal on every node including root.
  if (!eq(sp.size, cp.size)) return label("size");

  // Non-root: compare parent-relative (abs - rootOrigin). Root x/y may differ.
  if (!isRoot) {
    const sRel = { x: sp.position.x - sourceOrigin.x, y: sp.position.y - sourceOrigin.y };
    const cRel = { x: cp.position.x - copyOrigin.x, y: cp.position.y - copyOrigin.y };
    if (!eq(sRel, cRel)) return label("position");
  }
  if (!eq(sp.rotation || 0, cp.rotation || 0)) return label("rotation");

  if (!eq(sp.styles?.fills || [], cp.styles?.fills || [])) return label("fill");
  if (!eq(sp.styles?.strokes || [], cp.styles?.strokes || [])) return label("stroke");
  if (!eq(sp.styles?.effects || [], cp.styles?.effects || [])) return label("effects");

  if (!ignored.has("text") && !eq(sp.text, cp.text)) return label("text");
  if (!eq(sp.font, cp.font)) return label("font");
  if (!eq(sp.lineHeight, cp.lineHeight)) return label("lineHeight");
  if (!eq(sp.letterSpacing, cp.letterSpacing)) return label("letterSpacing");
  if (!eq(sp.alignment, cp.alignment)) return label("align");
  if (!eq(sp.runs, cp.runs)) return label("runs");
  if (!eq(sp.textDecoration, cp.textDecoration)) return label("textDecoration");
  if (!eq(sp.textCase, cp.textCase)) return label("textCase");
  if (!eq(sp.verticalAlignment, cp.verticalAlignment)) return label("verticalAlignment");
  if (!eq(sp.paragraphSpacing, cp.paragraphSpacing)) return label("paragraphSpacing");
  if (!eq(sp.paragraphIndent, cp.paragraphIndent)) return label("paragraphIndent");
  if (!eq(sp.listSpacing, cp.listSpacing)) return label("listSpacing");
  if (!eq(sp.textAutoResize, cp.textAutoResize)) return label("textAutoResize");
  if (!eq(sp.textTruncation, cp.textTruncation)) return label("textTruncation");
  if (!eq(sp.maxLines, cp.maxLines)) return label("maxLines");

  if (!ignored.has("visible") && !isRoot && !eq(sp.visible !== false, cp.visible !== false)) return label("visible");
  if (!ignored.has("componentId") && !eq(sp.componentId, cp.componentId)) return label("componentId");

  // Gate amendment: bindings, styleRefs, prototype must match.
  if (!eq(sp.bindings || {}, cp.bindings || {})) return label("bindings");
  if (!eq(sp.styleRefs || {}, cp.styleRefs || {})) return label("styleRefs");
  if (!eq(sp.prototype || [], cp.prototype || [])) return label("prototype");

  if (!isRoot && !eq(sp.variableModes || {}, cp.variableModes || {})) return label("variableModes");
  if (!isRoot && !eq(sp.layout, cp.layout)) return label("layout");
  if (!isRoot && !eq(sp.layoutAlign, cp.layoutAlign)) return label("layoutAlign");
  if (!isRoot && !eq(sp.layoutGrow, cp.layoutGrow)) return label("layoutGrow");
  if (!isRoot && !eq(sp.layoutPositioning, cp.layoutPositioning)) return label("layoutPositioning");
  if (!isRoot && !eq(sp.layoutSizingHorizontal, cp.layoutSizingHorizontal)) return label("layoutSizingHorizontal");
  if (!isRoot && !eq(sp.layoutSizingVertical, cp.layoutSizingVertical)) return label("layoutSizingVertical");
  if (!isRoot && !eq(sp.constraints, cp.constraints)) return label("constraints");
  if (!isRoot && source.name !== copy.name) return label("name");

  if (!eq(sp.opacity, cp.opacity)) return label("opacity");
  if (!eq(sp.blendMode, cp.blendMode)) return label("blendMode");
  if (!eq(sp.cornerRadius, cp.cornerRadius)) return label("cornerRadius");
  if (!eq(sp.cornerRadii, cp.cornerRadii)) return label("cornerRadii");
  if (!eq(sp.clipsContent, cp.clipsContent)) return label("clipsContent");
  if (!eq(sp.isMask, cp.isMask)) return label("isMask");
  if (!eq(sp.locked, cp.locked)) return label("locked");
  if (!eq(sp.strokeWeight, cp.strokeWeight)) return label("strokeWeight");
  if (!eq(sp.strokeAlign, cp.strokeAlign)) return label("strokeAlign");
  if (!eq(sp.strokeCap, cp.strokeCap)) return label("strokeCap");
  if (!eq(sp.strokeJoin, cp.strokeJoin)) return label("strokeJoin");
  if (!eq(sp.dashPattern, cp.dashPattern)) return label("dashPattern");
  if (!eq(sp.overflowDirection, cp.overflowDirection)) return label("overflowDirection");
  if (!eq(sp.layoutGrids, cp.layoutGrids)) return label("layoutGrids");
  if (!eq(sp.minWidth, cp.minWidth)) return label("minWidth");
  if (!eq(sp.maxWidth, cp.maxWidth)) return label("maxWidth");
  if (!eq(sp.minHeight, cp.minHeight)) return label("minHeight");
  if (!eq(sp.maxHeight, cp.maxHeight)) return label("maxHeight");
  if (!eq(sp.vectorPaths, cp.vectorPaths)) return label("vectorPaths");
  if (!eq(sp.svg, cp.svg)) return label("svg");
  if (!eq(sp.operation, cp.operation)) return label("operation");
  if (!eq(sp.instanceProperties, cp.instanceProperties)) return label("instanceProperties");

  if (source.children.length !== copy.children.length) return label("children");
  for (let i = 0; i < source.children.length; i++) {
    const hit = structuralDiff(source.children[i], copy.children[i], ignore, path ? `${path}.children[${i}]` : `children[${i}]`, nextOrigins);
    if (hit) return hit;
  }
  return null;
}

export function collectIds(node: InternalNode, out: Set<string> = new Set()): Set<string> {
  out.add(node.id);
  for (const child of node.children) collectIds(child, out);
  return out;
}

export function subtreeHasPropertyReferences(node: InternalNode): boolean {
  if (node.properties.componentPropertyReferences) return true;
  return node.children.some(subtreeHasPropertyReferences);
}

export function findDescendant(root: InternalNode, id: string): InternalNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const hit = findDescendant(child, id);
    if (hit) return hit;
  }
  return null;
}

/** Clone a node as an INSTANCE shell (no children), preserving root layout/geometry overrides. */
export function frameToInstanceShell(
  copy: InternalNode,
  componentId: string,
  instanceProperties: Record<string, string | boolean> | undefined
): InternalNode {
  const props: DesignProperties = {
    ...copy.properties,
    componentId,
    styles: {
      fills: [...(copy.properties.styles?.fills || [])],
      strokes: [...(copy.properties.styles?.strokes || [])],
      effects: [...(copy.properties.styles?.effects || [])]
    }
  };
  // Instance roots don't carry authored subtree chrome that belongs to the main.
  delete props.componentProperties;
  delete props.componentPropertyReferences;
  delete props.prototype;
  delete props.text;
  delete props.font;
  delete props.runs;
  if (instanceProperties && Object.keys(instanceProperties).length) props.instanceProperties = instanceProperties;
  else delete props.instanceProperties;
  return {
    id: copy.id,
    name: copy.name,
    type: "INSTANCE",
    properties: props,
    children: []
  };
}
