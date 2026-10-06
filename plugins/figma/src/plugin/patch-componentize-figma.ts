/**
 * Figma-side helpers for patch `componentize`.
 * Mirrors packages/core/src/patch-componentize.ts — same COMPONENTIZE_DIFF_EXEMPT
 * fail-closed contract against live SceneNodes.
 */

import {
  COMPONENTIZE_DIFF_EXEMPT,
  type ComponentPropertyType
} from "@compact-design/core";

export type ComponentizePropertyDecl = { type: ComponentPropertyType; layer: string };
export type ComponentizeProperties = Record<string, ComponentizePropertyDecl>;

const ROOT_EXEMPT_PROPS: ReadonlySet<string> = new Set(
  COMPONENTIZE_DIFF_EXEMPT.filter((e) => e.rootOnly && e.key !== "name").map((e) => e.key as string)
);

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
  if (type === "TEXT") return "text";
  if (type === "BOOLEAN") return "visible";
  return "componentId";
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
 * Build a DesignProperties-shaped bag from a SceneNode for fail-closed diff.
 * Keys align with core InternalNode.properties so COMPONENTIZE_DIFF_EXEMPT matches.
 */
function scenePropertiesBag(node: SceneNode): Record<string, unknown> {
  const bag: Record<string, unknown> = {
    position: { x: node.x, y: node.y },
    size: { width: node.width, height: node.height },
    rotation: "rotation" in node ? ((node as LayoutMixin).rotation || 0) : 0,
    styles: {
      fills: sceneFills(node),
      strokes: sceneStrokes(node),
      effects: sceneEffects(node)
    },
    opacity: "opacity" in node ? node.opacity : 1,
    blendMode: "blendMode" in node ? node.blendMode : "PASS_THROUGH",
    visible: node.visible !== false,
    locked: "locked" in node ? node.locked : false,
    isMask: "isMask" in node ? node.isMask : false,
    bindings: ("boundVariables" in node && node.boundVariables) ? node.boundVariables : {},
    styleRefs: (() => {
      const refs: Record<string, string> = {};
      if ("fillStyleId" in node && typeof node.fillStyleId === "string" && node.fillStyleId) refs.fill = node.fillStyleId;
      if ("strokeStyleId" in node && typeof node.strokeStyleId === "string" && node.strokeStyleId) refs.stroke = node.strokeStyleId;
      if ("textStyleId" in node && typeof node.textStyleId === "string" && node.textStyleId) refs.text = node.textStyleId;
      return refs;
    })(),
    prototype: ("reactions" in node && Array.isArray((node as FrameNode).reactions)) ? (node as FrameNode).reactions : []
  };

  if ("cornerRadius" in node) bag.cornerRadius = (node as RectangleNode).cornerRadius;
  if ("clipsContent" in node) bag.clipsContent = (node as FrameNode).clipsContent;
  if ("strokeWeight" in node) bag.strokeWeight = (node as GeometryMixin).strokeWeight;
  if ("strokeAlign" in node) bag.strokeAlign = (node as GeometryMixin).strokeAlign;
  if ("strokeCap" in node && (node as GeometryMixin).strokeCap !== figma.mixed) bag.strokeCap = (node as GeometryMixin).strokeCap;
  if ("strokeJoin" in node && (node as GeometryMixin).strokeJoin !== figma.mixed) bag.strokeJoin = (node as GeometryMixin).strokeJoin;
  if ("dashPattern" in node) bag.dashPattern = (node as GeometryMixin).dashPattern;
  if ("constraints" in node) bag.constraints = (node as ConstraintMixin).constraints;
  if ("layoutAlign" in node) bag.layoutAlign = (node as FrameNode).layoutAlign;
  if ("layoutGrow" in node) bag.layoutGrow = (node as FrameNode).layoutGrow;
  if ("layoutPositioning" in node) bag.layoutPositioning = (node as FrameNode).layoutPositioning;
  if ("layoutSizingHorizontal" in node) bag.layoutSizingHorizontal = (node as FrameNode).layoutSizingHorizontal;
  if ("layoutSizingVertical" in node) bag.layoutSizingVertical = (node as FrameNode).layoutSizingVertical;
  if ("minWidth" in node) bag.minWidth = (node as FrameNode).minWidth;
  if ("maxWidth" in node) bag.maxWidth = (node as FrameNode).maxWidth;
  if ("minHeight" in node) bag.minHeight = (node as FrameNode).minHeight;
  if ("maxHeight" in node) bag.maxHeight = (node as FrameNode).maxHeight;
  if ("overflowDirection" in node) bag.overflowDirection = (node as FrameNode).overflowDirection;
  if ("layoutGrids" in node) bag.layoutGrids = (node as FrameNode).layoutGrids;
  if ("layoutMode" in node && (node as FrameNode).layoutMode !== "NONE") {
    const frame = node as FrameNode;
    bag.layout = {
      direction: frame.layoutMode,
      itemSpacing: frame.itemSpacing,
      counterAxisSpacing: frame.counterAxisSpacing,
      padding: { left: frame.paddingLeft, top: frame.paddingTop, right: frame.paddingRight, bottom: frame.paddingBottom },
      primaryAxisAlignItems: frame.primaryAxisAlignItems,
      counterAxisAlignItems: frame.counterAxisAlignItems,
      primaryAxisSizingMode: frame.primaryAxisSizingMode,
      counterAxisSizingMode: frame.counterAxisSizingMode,
      wrap: frame.layoutWrap === "WRAP"
    };
  }
  if ("explicitVariableModes" in node && node.explicitVariableModes && Object.keys(node.explicitVariableModes as object).length) {
    bag.variableModes = node.explicitVariableModes;
  }
  if (node.type === "INSTANCE") {
    bag.componentId = (node as InstanceNode & { mainComponentId?: string }).mainComponentId;
  }
  if (node.type === "TEXT") {
    const text = node as TextNode;
    bag.text = text.characters;
    bag.font = text.fontName === figma.mixed ? undefined : text.fontName;
    bag.fontSize = text.fontSize === figma.mixed ? undefined : text.fontSize;
    // Mirror DesignProperties: hang font size under font when possible — keep parallel scalar for diff stability.
    if (typeof text.fontSize === "number") {
      const fn = text.fontName === figma.mixed ? { family: "Inter", style: "Regular" } : text.fontName as FontName;
      bag.font = { family: fn.family, style: fn.style, size: text.fontSize };
    }
    bag.lineHeight = text.lineHeight === figma.mixed ? undefined : text.lineHeight;
    bag.letterSpacing = text.letterSpacing === figma.mixed ? undefined : text.letterSpacing;
    bag.alignment = text.textAlignHorizontal;
    bag.verticalAlignment = text.textAlignVertical;
    bag.textDecoration = text.textDecoration === figma.mixed ? undefined : text.textDecoration;
    bag.textCase = text.textCase === figma.mixed ? undefined : text.textCase;
    bag.paragraphSpacing = text.paragraphSpacing;
    bag.paragraphIndent = text.paragraphIndent;
    bag.listSpacing = text.listSpacing;
    bag.hangingPunctuation = text.hangingPunctuation;
    bag.hangingList = text.hangingList;
    bag.textAutoResize = text.textAutoResize;
    bag.textTruncation = text.textTruncation;
    bag.maxLines = text.maxLines;
  }
  return bag;
}

function reportKey(key: string): string {
  if (key === "alignment") return "align";
  return key;
}

function stylesReportKey(key: string): string {
  if (key === "fills") return "fill";
  if (key === "strokes") return "stroke";
  return key;
}

/**
 * Strict structural diff on SceneNodes — fail-closed, same exempt set as core.
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
  if (!isRoot && source.name !== copy.name) return label("name");

  const ignored = new Set<string>();
  for (const decl of Object.values(ignore.properties)) {
    if (decl.layer === compactId(source)) ignored.add(ignoredFieldForProperty(decl.type));
  }

  const sp = scenePropertiesBag(source);
  const cp = scenePropertiesBag(copy);
  // Root-relative position for non-root (mirrors core abs − rootOrigin).
  if (!isRoot) {
    sp.position = { x: rel.source.x, y: rel.source.y };
    cp.position = { x: rel.copy.x, y: rel.copy.y };
  }

  const keys = new Set([...Object.keys(sp), ...Object.keys(cp)]);
  for (const key of [...keys].sort()) {
    if (ignored.has(key)) continue;
    if (isRoot && ROOT_EXEMPT_PROPS.has(key)) continue;

    if (key === "position") {
      if (isRoot) continue;
      if (!eq(sp.position, cp.position)) return label("position");
      continue;
    }

    if (key === "styles") {
      const sStyles = (sp.styles || {}) as Record<string, unknown>;
      const cStyles = (cp.styles || {}) as Record<string, unknown>;
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

  const sourceKids = "children" in source ? source.children : [];
  const copyKids = "children" in copy ? copy.children : [];
  if (sourceKids.length !== copyKids.length) return label("children");
  for (let i = 0; i < sourceKids.length; i++) {
    const childS = sourceKids[i];
    const childC = copyKids[i];
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
