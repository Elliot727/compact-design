import type { InternalDocument, InternalNode } from "./types";

export interface DocumentIndex { nodes: ReadonlyMap<string, InternalNode>; components: ReadonlyMap<string, InternalNode>; }

export function indexDocument(document: InternalDocument): DocumentIndex {
  const nodes = new Map<string, InternalNode>();
  const components = new Map<string, InternalNode>();
  const visit = (node: InternalNode): void => {
    if (nodes.has(node.id)) throw new Error(`Duplicate Compact Design ID '${node.id}'.`);
    nodes.set(node.id, node);
    if (node.type === "COMPONENT") components.set(node.id, node);
    node.children.forEach(visit);
  };
  document.nodes.forEach(visit);
  return { nodes, components };
}
