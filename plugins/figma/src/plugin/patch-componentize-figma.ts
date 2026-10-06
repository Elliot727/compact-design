/**
 * Figma-side helpers for patch `componentize`.
 * Structural equality uses exportSelection → normalize → core structuralDiff
 * (same COMPONENTIZE_DIFF_EXEMPT). No second scene property reader.
 */

import {
  normalize,
  structuralDiff,
  type ComponentPropertyType,
  type InternalDocument,
  type InternalNode
} from "@compact-design/core";
import { exportSelection } from "./exporter";

export type ComponentizePropertyDecl = { type: ComponentPropertyType; layer: string };
export type ComponentizeProperties = Record<string, ComponentizePropertyDecl>;

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

function findInternalById(document: InternalDocument, id: string): InternalNode | null {
  const walk = (nodes: InternalNode[]): InternalNode | null => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const hit = walk(node.children);
      if (hit) return hit;
    }
    return null;
  };
  return walk(document.nodes);
}

/**
 * Fields the exporter cannot round-trip for componentize diff. Carrying any of
 * these on the source or a copy makes componentize fail closed (difference
 * would otherwise be silently dropped when the copy becomes an instance).
 */
export function exportLossyComponentizeReason(node: SceneNode): string | null {
  const label = compactId(node) || node.name || node.type;
  if (node.type === "TEXT") {
    const text = node as TextNode & { rangeFonts?: unknown[] };
    if (text.fontName === figma.mixed) {
      return `node '${label}' has mixed/rich-text font runs that export cannot round-trip for componentize`;
    }
    if (Array.isArray(text.rangeFonts) && text.rangeFonts.length > 0) {
      return `node '${label}' has rich-text runs that export cannot round-trip for componentize`;
    }
  }
  if ("effectStyleId" in node && typeof (node as BlendMixin).effectStyleId === "string" && (node as BlendMixin).effectStyleId) {
    return `node '${label}' has effectStyleId (styleRefs.effect) that export cannot round-trip for componentize`;
  }
  if ("gridStyleId" in node && typeof (node as BaseFrameMixin).gridStyleId === "string" && (node as BaseFrameMixin).gridStyleId) {
    return `node '${label}' has gridStyleId (styleRefs.grid) that export cannot round-trip for componentize`;
  }
  if ("strokeWeight" in node && "strokeTopWeight" in node) {
    const geom = node as GeometryMixin & {
      strokeWeight: number | typeof figma.mixed;
      strokeTopWeight: number;
      strokeRightWeight: number;
      strokeBottomWeight: number;
      strokeLeftWeight: number;
    };
    if (geom.strokeWeight === figma.mixed) {
      return `node '${label}' has mixed per-side stroke weights that export cannot round-trip for componentize`;
    }
    if (typeof geom.strokeWeight === "number") {
      const sides = [geom.strokeTopWeight, geom.strokeRightWeight, geom.strokeBottomWeight, geom.strokeLeftWeight];
      if (sides.some((side) => typeof side === "number" && side !== geom.strokeWeight)) {
        return `node '${label}' has per-side stroke weights that export cannot round-trip for componentize`;
      }
    }
  }
  if ("children" in node) {
    for (const child of node.children) {
      if (!("x" in child)) continue;
      const hit = exportLossyComponentizeReason(child as SceneNode);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Root FRAME exported as a canvas drops most node props. Reject componentize
 * when a PAGE-level root carries anything beyond the canvas authoring surface.
 */
function canvasLossyRootReason(node: SceneNode): string | null {
  const label = compactId(node) || node.name || node.type;
  if ("opacity" in node && node.opacity !== 1) {
    return `top-level node '${label}' has opacity that canvas export drops; nest it under a FRAME before componentize`;
  }
  if ("effects" in node && Array.isArray(node.effects) && node.effects.length) {
    return `top-level node '${label}' has effects that canvas export drops; nest it under a FRAME before componentize`;
  }
  if ("strokes" in node && Array.isArray(node.strokes) && node.strokes.length) {
    return `top-level node '${label}' has strokes that canvas export drops; nest it under a FRAME before componentize`;
  }
  if ("rotation" in node && (node as LayoutMixin).rotation) {
    return `top-level node '${label}' has rotation that canvas export drops; nest it under a FRAME before componentize`;
  }
  if ("layoutMode" in node && (node as FrameNode).layoutMode !== "NONE") {
    return `top-level node '${label}' has Auto Layout that canvas export drops; nest it under a FRAME before componentize`;
  }
  if ("boundVariables" in node && node.boundVariables && Object.keys(node.boundVariables as object).length) {
    return `top-level node '${label}' has bindings that canvas export drops; nest it under a FRAME before componentize`;
  }
  return null;
}

/**
 * Export source + copy through the real exporter, normalize, and run core
 * structuralDiff so Figma cannot drift from core's fail-closed contract.
 */
export async function structuralDiffViaExport(
  source: SceneNode,
  copy: SceneNode,
  ignore: { properties: ComponentizeProperties }
): Promise<string | null> {
  const lossySource = exportLossyComponentizeReason(source);
  if (lossySource) throw new Error(lossySource);
  const lossyCopy = exportLossyComponentizeReason(copy);
  if (lossyCopy) throw new Error(lossyCopy);

  const parent = source.parent;
  const sharedParent =
    parent &&
    parent === copy.parent &&
    parent.type !== "PAGE" &&
    parent.type !== "DOCUMENT" &&
    "children" in parent
      ? (parent as SceneNode)
      : null;

  let sourceNode: InternalNode | null = null;
  let copyNode: InternalNode | null = null;

  if (sharedParent) {
    const { document: compact } = await exportSelection([sharedParent]);
    const doc = normalize(compact);
    sourceNode = findInternalById(doc, compactId(source));
    copyNode = findInternalById(doc, compactId(copy));
  } else {
    const rootLossy = canvasLossyRootReason(source) || canvasLossyRootReason(copy);
    if (rootLossy) throw new Error(rootLossy);
    const srcDoc = normalize((await exportSelection([source])).document);
    const copyDoc = normalize((await exportSelection([copy])).document);
    sourceNode = srcDoc.nodes[0] || null;
    copyNode = copyDoc.nodes[0] || null;
  }

  if (!sourceNode || !copyNode) {
    throw new Error("componentize export diff could not resolve source/copy compact nodes");
  }
  return structuralDiff(sourceNode, copyNode, ignore);
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
