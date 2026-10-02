export interface ExportCandidate {
  figmaId: string;
  compactId: string;
  type: string;
  name: string;
  parentFigmaId: string | null;
  mainComponentFigmaId?: string | null;
}

export interface ExportRequest {
  scope?: "selection" | "page";
  id?: string;
  selectionIds?: string[];
}

export interface ExportPlan {
  rootIds: string[];
  warnings: string[];
}

export function planExport(nodes: readonly ExportCandidate[], request: ExportRequest = {}): ExportPlan {
  const byFigma = new Map(nodes.map((node) => [node.figmaId, node]));
  const childrenOf = new Map<string | null, ExportCandidate[]>();
  for (const node of nodes) {
    const siblings = childrenOf.get(node.parentFigmaId) ?? [];
    siblings.push(node);
    childrenOf.set(node.parentFigmaId, siblings);
  }

  const requestedId = request.id?.trim();
  let seeds: ExportCandidate[];
  if (requestedId) {
    const match = nodes.find((node) => node.compactId === requestedId) ?? nodes.find((node) => node.figmaId === requestedId);
    if (!match) throw new Error(`No layer with Compact Design id or Figma id '${requestedId}' is on the current page.`);
    seeds = [match];
  } else if (request.scope === "page") {
    seeds = childrenOf.get(null) ?? [];
    if (!seeds.length) throw new Error("The current page has no layers to export.");
  } else {
    seeds = (request.selectionIds ?? []).flatMap((figmaId) => {
      const node = byFigma.get(figmaId);
      return node ? [node] : [];
    });
    if (!seeds.length) throw new Error("Select at least one frame or layer to export.");
  }

  const included = new Set<string>();
  const includeTree = (rootId: string): string[] => {
    const added: string[] = [];
    const stack = [rootId];
    while (stack.length) {
      const current = stack.pop();
      if (!current || included.has(current)) continue;
      included.add(current);
      added.push(current);
      for (const child of childrenOf.get(current) ?? []) stack.push(child.figmaId);
    }
    return added;
  };

  const warnings: string[] = [];
  const componentRootIds: string[] = [];
  let queue = seeds.flatMap((seed) => includeTree(seed.figmaId));
  while (queue.length) {
    const figmaId = queue.shift();
    const node = figmaId ? byFigma.get(figmaId) : undefined;
    if (!node || node.type !== "INSTANCE" || !node.mainComponentFigmaId) continue;
    if (included.has(node.mainComponentFigmaId)) continue;
    const component = byFigma.get(node.mainComponentFigmaId);
    if (!component) {
      warnings.push(`Instance '${node.name}' was flattened to an editable frame because its main component is not on this page.`);
      continue;
    }
    const parent = component.parentFigmaId ? byFigma.get(component.parentFigmaId) : undefined;
    const rootId = parent?.type === "COMPONENT_SET" ? parent.figmaId : component.figmaId;
    if (included.has(rootId)) continue;
    componentRootIds.push(rootId);
    queue.push(...includeTree(rootId));
    warnings.push(`Included '${byFigma.get(rootId)?.name || rootId}' so instance '${node.name}' stays linked.`);
  }

  const rootIds: string[] = [];
  const seen = new Set<string>();
  for (const id of [...componentRootIds, ...seeds.map((seed) => seed.figmaId)]) {
    if (seen.has(id)) continue;
    seen.add(id);
    rootIds.push(id);
  }
  return { rootIds, warnings };
}
