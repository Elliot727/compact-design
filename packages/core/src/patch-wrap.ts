import type { DesignProperties, InternalNode } from "./types";

/** Axis-aligned bounding box of nodes (core stores absolute positions). */
export function nodesBoundingBox(nodes: InternalNode[]): { x: number; y: number; width: number; height: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of nodes) {
    const { x, y } = node.properties.position;
    const { width, height } = node.properties.size;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  return { x: minX, y: minY, width, height };
}

/** True when the node (or any ancestor up to stopAt exclusive) has non-zero rotation. */
export function hasNonZeroRotation(node: InternalNode, ancestors: InternalNode[]): boolean {
  if (Math.abs(node.properties.rotation || 0) > 1e-9) return true;
  for (const ancestor of ancestors) {
    if (Math.abs(ancestor.properties.rotation || 0) > 1e-9) return true;
  }
  return false;
}

/** Properties lost when unwrapping a FRAME/GROUP (visual chrome on the wrapper). */
export function unwrapLostVisuals(props: DesignProperties): string[] {
  const lost: string[] = [];
  if ((props.styles?.fills?.length || 0) > 0) lost.push("fills");
  if ((props.styles?.strokes?.length || 0) > 0) lost.push("strokes");
  if ((props.styles?.effects?.length || 0) > 0) lost.push("effects");
  if (props.clipsContent === true) lost.push("clipsContent");
  return lost;
}

export function isAutoLayout(node: InternalNode | null | undefined): boolean {
  return Boolean(node?.properties.layout?.direction);
}

/** Whether a child keeps absolute positioning when promoted into an AL parent. */
export function keepsAbsoluteInAutoLayout(node: InternalNode): boolean {
  return node.properties.layoutPositioning === "ABSOLUTE";
}
