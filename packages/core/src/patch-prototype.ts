import type { InternalDocument, InternalNode, JsonObject } from "./types";

const DESTINATION_ACTIONS = new Set(["NAVIGATE", "SWAP", "OVERLAY", "SCROLL_TO", "CHANGE_TO"]);

function triggerType(reaction: JsonObject): string {
  const trigger = reaction.trigger;
  if (typeof trigger === "string") return trigger;
  if (trigger && typeof trigger === "object" && !Array.isArray(trigger) && typeof (trigger as JsonObject).type === "string") {
    return String((trigger as JsonObject).type);
  }
  return "";
}

function reactionActions(reaction: JsonObject): JsonObject[] {
  if (Array.isArray(reaction.actions)) {
    return reaction.actions.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  }
  if (reaction.action) return [{ ...reaction, type: reaction.action }];
  return [];
}

/** Walk every destination-bearing action in a prototype array. */
export function forEachPrototypeDestination(
  prototype: unknown,
  visit: (action: JsonObject, type: string, destination: string, actionPath: string) => void,
  basePath = "prototype"
): void {
  if (!Array.isArray(prototype)) return;
  prototype.forEach((reaction, index) => {
    if (!reaction || typeof reaction !== "object" || Array.isArray(reaction)) return;
    reactionActions(reaction as JsonObject).forEach((action, actionIndex) => {
      const type = String(action.type || "").toUpperCase();
      if (!DESTINATION_ACTIONS.has(type)) return;
      const destination = action.destination;
      if (typeof destination !== "string") return;
      visit(action, type, destination, `${basePath}[${index}].actions[${actionIndex}]`);
    });
  });
}

export function isAfterTimeoutReaction(reaction: JsonObject): boolean {
  return triggerType(reaction) === "AFTER_TIMEOUT";
}

/**
 * Eager destination checks for a prototype set value against the current id
 * index (including same-patch append/insert/duplicate ids).
 */
export function assertPrototypeSetDestinations(
  prototype: unknown,
  lookup: {
    has: (id: string) => boolean;
    typeOf?: (id: string) => string | undefined;
    /** Canvas root id for a node id (document.nodes root). */
    canvasOf?: (id: string) => string | undefined;
  },
  path: string,
  sourceId?: string
): string[] {
  const errors: string[] = [];
  if (!Array.isArray(prototype)) {
    errors.push(`${path}: prototype must be an array`);
    return errors;
  }
  forEachPrototypeDestination(prototype, (_action, type, destination, actionPath) => {
    if (!lookup.has(destination)) {
      errors.push(`${actionPath}.destination: Prototype destination '${destination}' was not found`);
      return;
    }
    if (type === "CHANGE_TO") {
      const destType = lookup.typeOf?.(destination);
      if (destType && destType !== "COMPONENT") {
        errors.push(`${actionPath}.destination: CHANGE_TO destination '${destination}' must be a component variant, received ${destType}`);
      }
    }
    if (type === "SCROLL_TO" && sourceId && lookup.canvasOf) {
      const sourceCanvas = lookup.canvasOf(sourceId);
      const destCanvas = lookup.canvasOf(destination);
      if (sourceCanvas && destCanvas && sourceCanvas !== destCanvas) {
        errors.push(`${actionPath}.destination: SCROLL_TO destination '${destination}' must be inside the same top-level canvas as its source`);
      }
    }
  }, path);
  return errors;
}

/** Top-level canvas id for a node (the document.nodes root containing it). */
export function canvasRootId(roots: InternalNode[], nodeId: string): string | undefined {
  const find = (nodes: InternalNode[], rootId: string): string | undefined => {
    for (const node of nodes) {
      if (node.id === nodeId) return rootId;
      const nested = find(node.children, rootId);
      if (nested) return nested;
    }
    return undefined;
  };
  for (const root of roots) {
    const hit = find([root], root.id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Document-wide prototype destination errors (missing / CHANGE_TO / SCROLL_TO).
 * Used by validateDocument so end-of-patch remove of a destination fails.
 */
export function prototypeDestinationErrors(document: InternalDocument): string[] {
  const types = new Map<string, string>();
  const collect = (node: InternalNode): void => {
    types.set(node.id, node.type);
    node.children.forEach(collect);
  };
  document.nodes.forEach(collect);
  const errors: string[] = [];
  const walk = (node: InternalNode, path: string): void => {
    if (node.properties.prototype) {
      const found = assertPrototypeSetDestinations(
        node.properties.prototype,
        {
          has: (id) => types.has(id),
          typeOf: (id) => types.get(id),
          canvasOf: (id) => canvasRootId(document.nodes, id)
        },
        `${path}.prototype`,
        node.id
      );
      errors.push(...found);
    }
    node.children.forEach((child, index) => walk(child, `${path}.children[${index}]`));
  };
  document.nodes.forEach((node, index) => walk(node, `nodes[${index}]`));
  return errors;
}
