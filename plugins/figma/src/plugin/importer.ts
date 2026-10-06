import type { ImportMode, InternalDocument, InternalNode, JsonObject } from "@compact-design/core";
import { createNode } from "./nodes";
import { clearEffectWarnings, effectWarnings } from "./paints";
import { createResources } from "./resources";
import { clearFontWarnings, fontWarnings } from "./text";
import { buildReactions } from "./prototype";

interface PendingPrototype {
  source: InternalNode;
  item: JsonObject;
}

function triggerType(item: PendingPrototype["item"]): string {
  if (typeof item.trigger === "string") return item.trigger;
  if (item.trigger && typeof item.trigger === "object" && !Array.isArray(item.trigger) && "type" in item.trigger) {
    return String((item.trigger as JsonObject).type || "ON_CLICK");
  }
  return "ON_CLICK";
}

function prototypeRoot(node: SceneNode): SceneNode {
  let current = node;
  while (current.parent && current.parent.type !== "PAGE" && "type" in current.parent) current = current.parent as SceneNode;
  return current;
}

function indexExisting(): Map<string, SceneNode> {
  const result = new Map<string, SceneNode>();
  for (const node of figma.currentPage.findAll()) { const id = node.getPluginData("compactDesignId"); if (id) result.set(id, node); }
  return result;
}

export async function importDocument(document: InternalDocument, mode: ImportMode): Promise<{ roots: SceneNode[]; warnings: string[]; created: number; replaced: number }> {
  clearFontWarnings();
  clearEffectWarnings();
  const resources = await createResources(document);
  const context = {
    sourceNodes: new Map<string, SceneNode>(),
    componentPropertyKeys: new Map<string, Map<string, string>>(), componentPropertyTypes: new Map<string, Map<string, string>>(),
    resources,
    createdNodes: [] as SceneNode[]
  };
  const roots: SceneNode[] = [];
  const existing = indexExisting();
  let created = 0; let replaced = 0;
  const prototypeWarnings: string[] = [];
  const backups: SceneNode[] = [];
  try {
    for (const value of document.nodes) {
      const matched = existing.get(value.id);
      if (mode === "CREATE" && matched) throw new Error(`Canvas ID '${value.id}' already exists. Choose Update matching IDs or Replace matching canvases.`);
      let parent: BaseNode & ChildrenMixin = figma.currentPage; let index: number | null = null;
      if (matched && mode !== "CREATE") {
        parent = matched.parent && "appendChild" in matched.parent ? matched.parent as BaseNode & ChildrenMixin : figma.currentPage;
        index = "children" in parent ? parent.children.indexOf(matched) : null;
        const backup = matched.clone(); if (index !== null && "insertChild" in parent) parent.insertChild(index, backup); backups.push(backup);
        matched.remove(); replaced++;
      }
      const root = await createNode(value, parent, { x: 0, y: 0 }, context);
      if (index !== null && "insertChild" in parent) parent.insertChild(Math.max(0, index), root);
      roots.push(root); created++;
    }
    const pending = new Map<SceneNode, PendingPrototype[]>();
    for (const [sourceId, node] of context.sourceNodes) {
      const source = findNode(document.nodes, sourceId);
      if (!source?.properties.prototype || !("setReactionsAsync" in node)) continue;
      for (const item of source.properties.prototype) {
        const target = triggerType(item) === "AFTER_TIMEOUT" ? prototypeRoot(node) : node;
        const values = pending.get(target) || [];
        values.push({ source, item });
        pending.set(target, values);
      }
    }
    for (const [node, entries] of pending) {
      if (!("setReactionsAsync" in node)) continue;
      const reactions = await buildReactions(entries.map(({ item }) => item), context.sourceNodes, resources, node);
      try {
        await node.setReactionsAsync(reactions);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/multiple actions|current plan/i.test(message) || !reactions.some((reaction) => (reaction.actions?.length || 0) > 1)) {
          const sources = [...new Set(entries.map(({ source }) => `'${source.name || source.id}' (${source.id})`))].join(", ");
          throw new Error(`Could not create prototype reaction from ${sources}: ${message}`);
        }
        const reduced = reactions.map((reaction) => {
          const actions = reaction.actions || (reaction.action ? [reaction.action] : []);
          const primary = actions.find((action) => action.type === "NODE" || action.type === "BACK" || action.type === "CLOSE" || action.type === "URL") || actions[0];
          return { trigger: reaction.trigger, actions: primary ? [primary] : [] } as Reaction;
        });
        await node.setReactionsAsync(reduced);
        prototypeWarnings.push(`${entries.map(({ source }) => source.name || source.id).join(", ")}: this Figma plan allows one action per reaction; imported the primary action and omitted ${reactions.reduce((total, reaction) => total + Math.max(0, (reaction.actions?.length || 0) - 1), 0)} additional action(s).`);
      }
    }
    if (!roots.length) throw new Error("No canvases were imported.");
    for (const backup of backups) if (!backup.removed) backup.remove();
    return { roots, warnings: [...resources.warnings, ...fontWarnings, ...effectWarnings, ...prototypeWarnings], created, replaced };
  } catch (error) {
    for (const node of [...context.createdNodes].reverse()) if (!node.removed) node.remove();
    for (const style of resources.createdStyles) style.remove();
    for (const collection of resources.createdCollections) collection.remove();
    throw error;
  }
}

function findNode(nodes: InternalDocument["nodes"], id: string): InternalNode | null {
  for (const node of nodes) { if (node.id === id) return node; const found = findNode(node.children, id); if (found) return found; }
  return null;
}
