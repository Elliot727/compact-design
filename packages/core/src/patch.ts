import type { InternalDocument, InternalNode, InternalPatchDocument, PatchOperation } from "./types";

export interface PatchResult { document: InternalDocument; affectedIds: string[]; }

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

export function applyDocumentPatch(document: InternalDocument, patch: InternalPatchDocument): PatchResult {
  const result: InternalDocument = { ...document, nodes: document.nodes.map(cloneNode), styles: cloneValue(document.styles), variables: cloneValue(document.variables) };
  const affectedIds: string[] = [];
  const index = new Map<string, { node: InternalNode; parent: InternalNode | null; siblings: InternalNode[] }>();
  const visit = (nodes: InternalNode[], parent: InternalNode | null): void => nodes.forEach((node) => { index.set(node.id, { node, parent, siblings: nodes }); visit(node.children, node); });
  visit(result.nodes, null);
  for (const [operationIndex, operation] of patch.patch.operations.entries()) {
    if (operation.op === "APPEND") {
      const target = operation.parent ? index.get(operation.parent) : undefined;
      if (!target || !operation.node) throw new Error(`patch.operations[${operationIndex}]: parent '${operation.parent || ""}' was not found.`);
      if (index.has(operation.node.id)) throw new Error(`patch.operations[${operationIndex}]: ID '${operation.node.id}' already exists.`);
      const appended = cloneNode(operation.node); target.node.children.push(appended); visit([appended], target.node); affectedIds.push(appended.id);
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
