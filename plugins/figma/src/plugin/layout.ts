import { clamp, finite } from "./value";
import type { DesignLayout, DesignProperties, JsonObject } from "@compact-design/core";

const stretchChildren = new WeakSet<BaseNode>();

export function applyGeometry(node: SceneNode, props: DesignProperties, origin: { x: number; y: number }): void {
  if ("resize" in node) node.resize(Math.max(.01, finite(props.size?.width, 100)), Math.max(.01, finite(props.size?.height, 100)));
  node.x = finite(props.position?.x, 0) - origin.x;
  node.y = finite(props.position?.y, 0) - origin.y;
  if ("rotation" in node) node.rotation = finite(props.rotation, 0);
}

export function applyAutoLayout(node: FrameNode | ComponentNode, layout?: DesignLayout): void {
  if (!layout?.direction) return;
  node.layoutMode = layout.direction as FrameNode["layoutMode"];
  const sizing = (value: string | undefined) => value === "HUG" || value === "AUTO" ? "AUTO" : "FIXED";
  node.primaryAxisSizingMode = sizing(layout.primaryAxisSizingMode);
  node.counterAxisSizingMode = sizing(layout.counterAxisSizingMode);
  node.primaryAxisAlignItems = (layout.primaryAxisAlignItems || "MIN") as FrameNode["primaryAxisAlignItems"];
  const counterAlignment = layout.counterAxisAlignItems || "MIN";
  node.counterAxisAlignItems = (counterAlignment === "STRETCH" ? "MIN" : counterAlignment) as FrameNode["counterAxisAlignItems"];
  if (counterAlignment === "STRETCH") stretchChildren.add(node);
  node.itemSpacing = finite(layout.itemSpacing, 0);
  node.counterAxisSpacing = finite(layout.counterAxisSpacing, 0);
  node.layoutWrap = layout.wrap ? "WRAP" : "NO_WRAP";
  const p = layout.padding || {};
  node.paddingLeft = finite(p.left, 0); node.paddingTop = finite(p.top, 0); node.paddingRight = finite(p.right, 0); node.paddingBottom = finite(p.bottom, 0);
}

/**
 * Patch a layout. A frame without Auto Layout is enabled exactly like import
 * (unmentioned fields take the import defaults). A frame that already has
 * Auto Layout only receives the mentioned fields, so siblings are kept.
 */
export function applyLayoutPatch(node: FrameNode | ComponentNode, layout: DesignLayout): void {
  if (node.layoutMode === "NONE") {
    if (!layout.direction) throw new Error(`'${node.name}' has no Auto Layout; layout.direction is required to enable it`);
    applyAutoLayout(node, layout);
    return;
  }
  const sizing = (value: string) => value === "HUG" || value === "AUTO" ? "AUTO" : "FIXED";
  if (layout.direction) node.layoutMode = layout.direction as FrameNode["layoutMode"];
  if (layout.primaryAxisSizingMode !== undefined) node.primaryAxisSizingMode = sizing(layout.primaryAxisSizingMode);
  if (layout.counterAxisSizingMode !== undefined) node.counterAxisSizingMode = sizing(layout.counterAxisSizingMode);
  if (layout.primaryAxisAlignItems !== undefined) node.primaryAxisAlignItems = layout.primaryAxisAlignItems as FrameNode["primaryAxisAlignItems"];
  if (layout.counterAxisAlignItems !== undefined) {
    if (layout.counterAxisAlignItems === "STRETCH") throw new Error("layout.counterAxisAlignItems STRETCH cannot be patched yet");
    node.counterAxisAlignItems = layout.counterAxisAlignItems as FrameNode["counterAxisAlignItems"];
  }
  if (layout.itemSpacing !== undefined) node.itemSpacing = finite(layout.itemSpacing, 0);
  if (layout.counterAxisSpacing !== undefined) node.counterAxisSpacing = finite(layout.counterAxisSpacing, 0);
  if (layout.wrap !== undefined) node.layoutWrap = layout.wrap ? "WRAP" : "NO_WRAP";
  const p = layout.padding;
  if (p?.left !== undefined) node.paddingLeft = finite(p.left, 0);
  if (p?.top !== undefined) node.paddingTop = finite(p.top, 0);
  if (p?.right !== undefined) node.paddingRight = finite(p.right, 0);
  if (p?.bottom !== undefined) node.paddingBottom = finite(p.bottom, 0);
}

export function applyChildLayout(node: SceneNode, props: DesignProperties): void {
  if ("constraints" in node && props.constraints) node.constraints = props.constraints;
  const parent = node.parent;
  if (!parent || !("layoutMode" in parent) || parent.layoutMode === "NONE") return;
  const writable = node as unknown as Record<string, unknown>;
  for (const key of ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const) if (key in node && (Number.isFinite(props[key]) || props[key] === null)) writable[key] = props[key];
  if ("layoutAlign" in node && props.layoutAlign === undefined && stretchChildren.has(parent)) node.layoutAlign = "STRETCH";
  const canUseHug = node.type === "TEXT" || ("layoutMode" in node && node.layoutMode !== "NONE");
  for (const key of ["layoutAlign", "layoutGrow", "layoutPositioning", "layoutSizingHorizontal", "layoutSizingVertical"] as const) {
    if (!(key in node) || props[key] === undefined) continue;
    if ((key === "layoutSizingHorizontal" || key === "layoutSizingVertical") && props[key] === "HUG" && !canUseHug) continue;
    writable[key] = props[key];
  }
}

export function applyGrids(node: SceneNode, values: JsonObject[]): void {
  if (!("layoutGrids" in node) || !Array.isArray(values)) return;
  node.layoutGrids = values.map((grid) => {
    const sourceColor = grid.color && typeof grid.color === "object" && !Array.isArray(grid.color) ? grid.color as JsonObject : {};
    const color = { r: finite(sourceColor.r, 0) / 255, g: finite(sourceColor.g, 0) / 255, b: finite(sourceColor.b, 0) / 255, a: clamp(sourceColor.a ?? .1, 0, 1) };
    if (grid.pattern === "GRID") return { pattern: "GRID", sectionSize: Math.max(1, finite(grid.sectionSize, 8)), color, visible: grid.visible !== false } as GridLayoutGrid;
    const alignment = typeof grid.alignment === "string" ? grid.alignment as RowsColsLayoutGrid["alignment"] : "STRETCH";
    return { pattern: grid.pattern === "ROWS" ? "ROWS" : "COLUMNS", alignment, gutterSize: Math.max(0, finite(grid.gutterSize, 20)), count: Math.max(1, Math.round(finite(grid.count, 12))), offset: Math.max(0, finite(grid.offset, 0)), color, visible: grid.visible !== false, ...(alignment === "STRETCH" ? {} : { sectionSize: Math.max(1, finite(grid.sectionSize, 64)) }) } as RowsColsLayoutGrid;
  });
}
