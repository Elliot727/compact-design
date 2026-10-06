import type { InternalDocument, InternalNode, InternalPatchDocument, PatchOperation } from "./types";

export interface PatchResult { document: InternalDocument; affectedIds: string[]; }

const CONTAINER_TYPES = new Set(["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "SECTION", "BOOLEAN_OPERATION"]);

function cloneValue<T>(value: T): T {
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)])) as T;
  return value;
}

function cloneNode(node: InternalNode): InternalNode {
  return { ...node, properties: cloneValue(node.properties), children: node.children.map(cloneNode) };
}

function mergeSet(node: InternalNode, operation: PatchOperation): void {
  const set = operation.set || {};
  const normalized = operation.normalized;
  if (!normalized) throw new Error(`Patch SET '${operation.id}' was not normalized.`);
  if (typeof set.name === "string") node.name = set.name;
  const propertyKeys = Object.keys(set).filter((key) => !["id", "name", "type", "children"].includes(key));
  for (const key of propertyKeys) {
    if (key === "x") node.properties.position.x = normalized.position.x;
    else if (key === "y") node.properties.position.y = normalized.position.y;
    else if (key === "w") node.properties.size.width = normalized.size.width;
    else if (key === "h") node.properties.size.height = normalized.size.height;
    else if (key === "fill" || key === "fills") node.properties.styles.fills = cloneValue(normalized.styles.fills);
    else if (key === "stroke" || key === "strokes") node.properties.styles.strokes = cloneValue(normalized.styles.strokes);
    else if (key === "effects" || key === "shadow" || key === "elevation") node.properties.styles.effects = cloneValue(normalized.styles.effects);
    else Object.assign(node.properties, { [key === "align" ? "alignment" : key]: cloneValue(normalized[key as keyof typeof normalized]) });
  }
}

type NodeRef = { node: InternalNode; parent: InternalNode | null; siblings: InternalNode[] };

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, length));
}

function isDescendantOf(ancestor: InternalNode, candidate: InternalNode): boolean {
  for (const child of ancestor.children) {
    if (child === candidate || isDescendantOf(child, candidate)) return true;
  }
  return false;
}

function hasInstanceAncestor(node: InternalNode | null, index: Map<string, NodeRef>): boolean {
  let current = node;
  while (current) {
    if (current.type === "INSTANCE") return true;
    const ref = index.get(current.id);
    current = ref?.parent ?? null;
  }
  return false;
}

function assertContainerParent(parent: InternalNode, operationIndex: number, parentId: string, index: Map<string, NodeRef>): void {
  if (parent.type === "INSTANCE" || hasInstanceAncestor(parent, index)) {
    throw new Error(`patch.operations[${operationIndex}]: parent '${parentId}' is an INSTANCE (or inside one) and cannot accept structural edits.`);
  }
  if (!CONTAINER_TYPES.has(parent.type)) {
    throw new Error(`patch.operations[${operationIndex}]: parent '${parentId}' cannot contain children.`);
  }
}

export function applyDocumentPatch(document: InternalDocument, patch: InternalPatchDocument): PatchResult {
  const result: InternalDocument = { ...document, nodes: document.nodes.map(cloneNode), styles: cloneValue(document.styles), variables: cloneValue(document.variables) };
  const affectedIds: string[] = [];
  const index = new Map<string, NodeRef>();
  const visit = (nodes: InternalNode[], parent: InternalNode | null): void => nodes.forEach((node) => { index.set(node.id, { node, parent, siblings: nodes }); visit(node.children, node); });
  visit(result.nodes, null);
  for (const [operationIndex, operation] of patch.patch.operations.entries()) {
    if (operation.op === "APPEND" || operation.op === "INSERT") {
      const target = operation.parent ? index.get(operation.parent) : undefined;
      if (!target || !operation.node) throw new Error(`patch.operations[${operationIndex}]: parent '${operation.parent || ""}' was not found.`);
      if (operation.op === "INSERT") assertContainerParent(target.node, operationIndex, operation.parent || "", index);
      if (index.has(operation.node.id)) throw new Error(`patch.operations[${operationIndex}]: ID '${operation.node.id}' already exists.`);
      const child = cloneNode(operation.node);
      if (operation.op === "APPEND") {
        target.node.children.push(child);
      } else {
        const at = clampIndex(operation.index ?? 0, target.node.children.length);
        target.node.children.splice(at, 0, child);
      }
      visit([child], target.node);
      affectedIds.push(child.id);
      continue;
    }
    if (operation.op === "MOVE") {
      const moving = operation.id ? index.get(operation.id) : undefined;
      if (!moving) throw new Error(`patch.operations[${operationIndex}]: node '${operation.id || ""}' was not found.`);
      if (!moving.parent) throw new Error(`patch.operations[${operationIndex}]: cannot move the document root.`);
      const destination = operation.parent ? index.get(operation.parent) : undefined;
      if (!destination) throw new Error(`patch.operations[${operationIndex}]: parent '${operation.parent || ""}' was not found.`);
      assertContainerParent(destination.node, operationIndex, operation.parent || "", index);
      if (destination.node === moving.node || isDescendantOf(moving.node, destination.node)) {
        throw new Error(`patch.operations[${operationIndex}]: cannot move a node under itself or its descendants.`);
      }
      const fromIndex = moving.siblings.indexOf(moving.node);
      moving.siblings.splice(fromIndex, 1);
      // Same-parent moves: index is the final position after removal.
      const at = clampIndex(operation.index ?? 0, destination.node.children.length);
      destination.node.children.splice(at, 0, moving.node);
      index.set(moving.node.id, { node: moving.node, parent: destination.node, siblings: destination.node.children });
      visit(moving.node.children, moving.node);
      affectedIds.push(moving.node.id);
      continue;
    }
    const target = operation.id ? index.get(operation.id) : undefined;
    if (!target) throw new Error(`patch.operations[${operationIndex}]: node '${operation.id || ""}' was not found.`);
    if (operation.op === "REMOVE") {
      target.siblings.splice(target.siblings.indexOf(target.node), 1); index.delete(target.node.id); affectedIds.push(target.node.id);
    } else {
      mergeSet(target.node, operation); affectedIds.push(target.node.id);
    }
  }
  return { document: result, affectedIds };
}
