import type { ComponentPropertyType, DesignProperties, InternalNode } from "./types";

/** Declared componentize property: type + source-layer id. */
export type ComponentizePropertyDecl = { type: ComponentPropertyType; layer: string };
export type ComponentizeProperties = Record<string, ComponentizePropertyDecl>;

/**
 * Fail-closed structural diff exemptions for `componentize`.
 *
 * Every key on either node's `properties` (union) must deep-equal, minus this
 * set. `rootOnly` entries apply only when comparing the source/copy roots
 * (detached copies may sit elsewhere, use a different AL slot, or differ in
 * root visibility / variableModes). `name` is a node field with the same rule.
 *
 * Not listed here (handled outside the properties bag):
 * - `id` — copies keep their own ids
 * - `type` — always compared (must match)
 * - `children` — walked recursively by index
 *
 * `patchKeys` lists the corresponding PATCH_SET_KEYS so coverage tests can
 * skip the same exemptions.
 */
export const COMPONENTIZE_DIFF_EXEMPT = [
  { key: "name", rootOnly: true, patchKeys: ["name"] as const },
  { key: "position", rootOnly: true, patchKeys: ["x", "y"] as const },
  { key: "visible", rootOnly: true, patchKeys: ["visible"] as const },
  { key: "variableModes", rootOnly: true, patchKeys: ["variableModes"] as const },
  { key: "constraints", rootOnly: true, patchKeys: ["constraints"] as const },
  { key: "layoutAlign", rootOnly: true, patchKeys: ["layoutAlign"] as const },
  { key: "layoutGrow", rootOnly: true, patchKeys: ["layoutGrow"] as const },
  { key: "layoutPositioning", rootOnly: true, patchKeys: ["layoutPositioning"] as const },
  { key: "layoutSizingHorizontal", rootOnly: true, patchKeys: ["layoutSizingHorizontal"] as const },
  { key: "layoutSizingVertical", rootOnly: true, patchKeys: ["layoutSizingVertical"] as const }
] as const;

export type ComponentizeDiffExemptEntry = (typeof COMPONENTIZE_DIFF_EXEMPT)[number];

/** PATCH_SET_KEYS covered by COMPONENTIZE_DIFF_EXEMPT (for coverage tests). */
export const COMPONENTIZE_DIFF_EXEMPT_PATCH_KEYS: readonly string[] = COMPONENTIZE_DIFF_EXEMPT.flatMap((e) => [...e.patchKeys]);

const ROOT_EXEMPT_PROPS: ReadonlySet<string> = new Set(
  COMPONENTIZE_DIFF_EXEMPT.filter((e) => e.rootOnly && e.key !== "name").map((e) => e.key as string)
);

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

/** Error-path label for a DesignProperties key (PATCH_SET-aligned aliases). */
function reportKey(key: string): string {
  if (key === "alignment") return "align";
  return key;
}

/** Styles subkey → error path segment. */
function stylesReportKey(key: string): string {
  if (key === "fills") return "fill";
  if (key === "strokes") return "stroke";
  return key;
}

/**
 * Strict structural diff (fail-closed). Returns a relative path (e.g.
 * `children[1].hangingPunctuation`) or null.
 *
 * Compares the union of keys on both nodes' `properties` with deep equality,
 * minus {@link COMPONENTIZE_DIFF_EXEMPT}. Declared componentize property fields
 * (text / visible / componentId) are also skipped on the bound layer.
 * `styles` is expanded so fill/stroke/effects (and any future styles subkey)
 * are compared fail-closed. Size always compared (not exempt).
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
  if (!isRoot && source.name !== copy.name) return label("name");

  const ignored = new Set<string>();
  for (const decl of Object.values(ignore.properties)) {
    if (decl.layer === source.id) ignored.add(ignoredFieldForProperty(decl.type));
  }

  const sp = source.properties as DesignProperties & Record<string, unknown>;
  const cp = copy.properties as DesignProperties & Record<string, unknown>;
  const keys = new Set([...Object.keys(sp), ...Object.keys(cp)]);

  for (const key of [...keys].sort()) {
    if (ignored.has(key)) continue;
    if (isRoot && ROOT_EXEMPT_PROPS.has(key)) continue;

    if (key === "position") {
      // Non-root: parent-relative via root origins (root position is exempt).
      if (isRoot) continue;
      const sRel = { x: sp.position.x - sourceOrigin.x, y: sp.position.y - sourceOrigin.y };
      const cRel = { x: cp.position.x - copyOrigin.x, y: cp.position.y - copyOrigin.y };
      if (!eq(sRel, cRel)) return label("position");
      continue;
    }

    if (key === "styles") {
      const sStyles = (sp.styles || {}) as unknown as Record<string, unknown>;
      const cStyles = (cp.styles || {}) as unknown as Record<string, unknown>;
      const styleKeys = new Set([...Object.keys(sStyles), ...Object.keys(cStyles)]);
      for (const sk of [...styleKeys].sort()) {
        const left = sStyles[sk] ?? (sk === "fills" || sk === "strokes" || sk === "effects" ? [] : undefined);
        const right = cStyles[sk] ?? (sk === "fills" || sk === "strokes" || sk === "effects" ? [] : undefined);
        if (!eq(left, right)) return label(stylesReportKey(sk));
      }
      continue;
    }

    if (!eq(sp[key], cp[key])) return label(reportKey(key));
  }

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
