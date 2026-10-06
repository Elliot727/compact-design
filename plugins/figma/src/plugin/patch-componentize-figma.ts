/**
 * Figma-side helpers for patch `componentize`.
 * Mirrors packages/core/src/patch-componentize.ts structuralDiff / matchLayer
 * against live SceneNodes so both engines reject the same mismatches.
 */

import type { ComponentPropertyType } from "@compact-design/core";

export type ComponentizePropertyDecl = { type: ComponentPropertyType; layer: string };
export type ComponentizeProperties = Record<string, ComponentizePropertyDecl>;

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

function compactId(node: SceneNode): string {
  return node.getPluginData("compactDesignId") || "";
}

/** Child-index path from root to a descendant identified by compactDesignId (empty = root). */
export function sceneIndexPathTo(root: SceneNode, targetId: string): number[] | null {
  if (compactId(root) === targetId) return [];
  if (!("children" in root)) return null;
  const walk = (node: SceneNode & ChildrenMixin, path: number[]): number[] | null => {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const next = [...path, i];
      if (compactId(child) === targetId) return next;
      if ("children" in child) {
        const nested = walk(child as SceneNode & ChildrenMixin, next);
        if (nested) return nested;
      }
    }
    return null;
  };
  return walk(root as SceneNode & ChildrenMixin, []);
}

export function sceneNodeAtPath(root: SceneNode, path: number[]): SceneNode | null {
  let current: SceneNode = root;
  for (const index of path) {
    if (!("children" in current) || index < 0 || index >= current.children.length) return null;
    current = current.children[index];
  }
  return current;
}

/** Match a source layer into a copy by identical child-index path and type. */
export function sceneMatchLayer(sourceRoot: SceneNode, copyRoot: SceneNode, sourceLayerId: string): SceneNode | null {
  const path = sceneIndexPathTo(sourceRoot, sourceLayerId);
  if (path === null) return null;
  let sourceCursor: SceneNode = sourceRoot;
  let copyCursor: SceneNode = copyRoot;
  for (const index of path) {
    if (!("children" in sourceCursor) || !("children" in copyCursor)) return null;
    if (index >= sourceCursor.children.length || index >= copyCursor.children.length) return null;
    sourceCursor = sourceCursor.children[index];
    copyCursor = copyCursor.children[index];
    if (sourceCursor.type !== copyCursor.type) return null;
  }
  return copyCursor;
}

export function sceneFindDescendant(root: SceneNode, id: string): SceneNode | null {
  if (compactId(root) === id) return root;
  if (!("children" in root)) return null;
  for (const child of root.children) {
    const hit = sceneFindDescendant(child, id);
    if (hit) return hit;
  }
  return null;
}

export function sceneCollectIds(node: SceneNode, out: Set<string> = new Set()): Set<string> {
  const id = compactId(node);
  if (id) out.add(id);
  if ("children" in node) for (const child of node.children) sceneCollectIds(child, out);
  return out;
}

export function sceneSubtreeHasPropertyReferences(node: SceneNode): boolean {
  if ("componentPropertyReferences" in node && node.componentPropertyReferences) return true;
  if ("children" in node) return node.children.some((child) => sceneSubtreeHasPropertyReferences(child));
  return false;
}

export async function sceneReadPropertyValue(node: SceneNode, type: ComponentPropertyType): Promise<string | boolean | undefined> {
  if (type === "TEXT") {
    if (node.type !== "TEXT") return undefined;
    return node.characters ?? "";
  }
  if (type === "BOOLEAN") return node.visible !== false;
  if (type === "INSTANCE_SWAP") {
    if (node.type !== "INSTANCE") return undefined;
    const main = await node.getMainComponentAsync();
    return main ? compactId(main) || undefined : undefined;
  }
  return undefined;
}

function ignoredFieldForProperty(type: ComponentPropertyType): string {
  if (type === "TEXT") return "characters";
  if (type === "BOOLEAN") return "visible";
  return "mainComponent";
}

function sceneBoundVariables(node: SceneNode): unknown {
  if (!("boundVariables" in node) || !node.boundVariables) return {};
  return node.boundVariables;
}

function sceneStyleRefs(node: SceneNode): Record<string, string> {
  const refs: Record<string, string> = {};
  if ("fillStyleId" in node && typeof node.fillStyleId === "string" && node.fillStyleId) refs.fill = node.fillStyleId;
  if ("strokeStyleId" in node && typeof node.strokeStyleId === "string" && node.strokeStyleId) refs.stroke = node.strokeStyleId;
  if ("textStyleId" in node && typeof node.textStyleId === "string" && node.textStyleId) refs.text = node.textStyleId;
  return refs;
}

function sceneReactions(node: SceneNode): unknown {
  if (!("reactions" in node) || !Array.isArray((node as FrameNode).reactions)) return [];
  return (node as FrameNode).reactions;
}

function sceneFills(node: SceneNode): unknown {
  if (!("fills" in node)) return [];
  const fills = node.fills;
  if (fills === figma.mixed || !Array.isArray(fills)) return [];
  return fills;
}

function sceneStrokes(node: SceneNode): unknown {
  if (!("strokes" in node)) return [];
  return Array.isArray(node.strokes) ? node.strokes : [];
}

function sceneEffects(node: SceneNode): unknown {
  if (!("effects" in node)) return [];
  return Array.isArray(node.effects) ? node.effects : [];
}

/**
 * Strict structural diff on SceneNodes — same contract as core structuralDiff.
 * Always compares size (Gate: w/h must match), bindings, styleRefs, effects, prototype.
 * On the copy root only, name/x/y/layout-child props/variableModes/visible may differ.
 */
export function sceneStructuralDiff(
  source: SceneNode,
  copy: SceneNode,
  ignore: { properties: ComponentizeProperties },
  path = "",
  /** Position of this node relative to the compared roots (FRAME parent-relative accumulated). */
  rel: { source: { x: number; y: number }; copy: { x: number; y: number } } = { source: { x: 0, y: 0 }, copy: { x: 0, y: 0 } }
): string | null {
  const isRoot = path === "";
  const label = (key: string) => (path ? `${path}.${key}` : key);

  if (source.type !== copy.type) return label("type");

  const ignored = new Set<string>();
  for (const decl of Object.values(ignore.properties)) {
    if (decl.layer === compactId(source)) ignored.add(ignoredFieldForProperty(decl.type));
  }

  // Gate: w/h must equal on every node including root.
  if (!eq({ width: source.width, height: source.height }, { width: copy.width, height: copy.height })) return label("size");

  if (!isRoot) {
    if (!eq(rel.source, rel.copy)) return label("position");
  }

  if ("rotation" in source && "rotation" in copy) {
    if (!eq((source as LayoutMixin).rotation || 0, (copy as LayoutMixin).rotation || 0)) return label("rotation");
  }

  if (!eq(sceneFills(source), sceneFills(copy))) return label("fill");
  if (!eq(sceneStrokes(source), sceneStrokes(copy))) return label("stroke");
  if (!eq(sceneEffects(source), sceneEffects(copy))) return label("effects");

  if (source.type === "TEXT" && copy.type === "TEXT") {
    if (!ignored.has("characters") && !eq(source.characters, copy.characters)) return label("text");
    if (!eq(source.fontName, copy.fontName)) return label("font");
    if (!eq(source.fontSize, copy.fontSize)) return label("font");
    if (!eq(source.lineHeight, copy.lineHeight)) return label("lineHeight");
    if (!eq(source.letterSpacing, copy.letterSpacing)) return label("letterSpacing");
    if (!eq(source.textAlignHorizontal, copy.textAlignHorizontal)) return label("align");
  }

  if (!ignored.has("visible") && !isRoot && !eq(source.visible !== false, copy.visible !== false)) return label("visible");

  if (source.type === "INSTANCE" && copy.type === "INSTANCE") {
    if (!ignored.has("mainComponent")) {
      const sMain = (source as InstanceNode & { mainComponentId?: string }).mainComponentId;
      const cMain = (copy as InstanceNode & { mainComponentId?: string }).mainComponentId;
      if (!eq(sMain, cMain)) return label("componentId");
    }
  }

  // Gate: bindings, styleRefs, prototype must match.
  if (!eq(sceneBoundVariables(source), sceneBoundVariables(copy))) return label("bindings");
  if (!eq(sceneStyleRefs(source), sceneStyleRefs(copy))) return label("styleRefs");
  if (!eq(sceneReactions(source), sceneReactions(copy))) return label("prototype");

  if (!isRoot && source.name !== copy.name) return label("name");

  if ("opacity" in source && "opacity" in copy && !eq(source.opacity, copy.opacity)) return label("opacity");
  if ("blendMode" in source && "blendMode" in copy && !eq(source.blendMode, copy.blendMode)) return label("blendMode");
  if ("cornerRadius" in source && "cornerRadius" in copy && !eq((source as RectangleNode).cornerRadius, (copy as RectangleNode).cornerRadius)) return label("cornerRadius");
  if ("clipsContent" in source && "clipsContent" in copy && !eq((source as FrameNode).clipsContent, (copy as FrameNode).clipsContent)) return label("clipsContent");

  const sourceKids = "children" in source ? source.children : [];
  const copyKids = "children" in copy ? copy.children : [];
  if (sourceKids.length !== copyKids.length) return label("children");
  for (let i = 0; i < sourceKids.length; i++) {
    const childS = sourceKids[i];
    const childC = copyKids[i];
    // Accumulate parent-relative coords to root-relative (mirrors core abs − rootOrigin).
    const nextRel = {
      source: { x: rel.source.x + childS.x, y: rel.source.y + childS.y },
      copy: { x: rel.copy.x + childC.x, y: rel.copy.y + childC.y }
    };
    const hit = sceneStructuralDiff(childS, childC, ignore, path ? `${path}.children[${i}]` : `children[${i}]`, nextRel);
    if (hit) return hit;
  }
  return null;
}

/** Rewrite reaction destinationIds from oldFigmaId → newFigmaId across the page (async). */
export async function remapFigmaIdReferences(oldFigmaId: string, newFigmaId: string, nodes: Map<string, SceneNode>): Promise<void> {
  if (oldFigmaId === newFigmaId) return;
  for (const scene of nodes.values()) {
    if (!("reactions" in scene) || !Array.isArray((scene as FrameNode).reactions)) continue;
    const reactions = (scene as FrameNode).reactions;
    let changed = false;
    const next = reactions.map((reaction) => {
      const actions = (reaction.actions || (reaction.action ? [reaction.action] : [])).map((action) => {
        if (!action || typeof action !== "object") return action;
        const dest = (action as { destinationId?: string | null }).destinationId;
        if (dest === oldFigmaId) {
          changed = true;
          return { ...action, destinationId: newFigmaId };
        }
        return action;
      });
      return { ...reaction, actions };
    });
    if (!changed) continue;
    if (!("setReactionsAsync" in scene) || typeof (scene as FrameNode).setReactionsAsync !== "function") {
      throw new Error("setReactionsAsync is required to rewrite prototype reactions under dynamic-page");
    }
    await (scene as FrameNode).setReactionsAsync(next);
  }
}
