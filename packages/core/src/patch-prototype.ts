import type { InternalDocument, InternalNode, JsonObject } from "./types";

const DESTINATION_ACTIONS = new Set(["NAVIGATE", "SWAP", "OVERLAY", "SCROLL_TO", "CHANGE_TO"]);
const TOP_LEVEL_NAV_ACTIONS = new Set(["NAVIGATE", "SWAP", "OVERLAY"]);

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

/** True when `nodeId` is a document.nodes root (top-level canvas frame). */
export function isTopLevelNodeId(roots: InternalNode[], nodeId: string): boolean {
  return roots.some((root) => root.id === nodeId);
}

export type PrototypeLookup = {
  has: (id: string) => boolean;
  typeOf?: (id: string) => string | undefined;
  /** Canvas root id for a node id (document.nodes root). */
  canvasOf?: (id: string) => string | undefined;
  /** Whether an id is a top-level canvas frame. */
  isTopLevel?: (id: string) => boolean;
};

/**
 * Shared destination checks (missing / CHANGE_TO / SCROLL_TO).
 * Used by validateDocument. Does not require NAVIGATE destinations to be top-level
 * (import stays lenient).
 */
export function assertPrototypeSetDestinations(
  prototype: unknown,
  lookup: PrototypeLookup,
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

/**
 * Strict rules for patch `set.prototype` only: NAVIGATE/SWAP/OVERLAY destinations
 * must be top-level frames; AFTER_TIMEOUT only on a top-level target.
 */
export function assertPrototypePatchRules(
  prototype: unknown,
  lookup: PrototypeLookup,
  path: string,
  sourceId: string | undefined,
  sourceIsTopLevel: boolean
): string[] {
  const errors = assertPrototypeSetDestinations(prototype, lookup, path, sourceId);
  if (!Array.isArray(prototype)) return errors;

  if (!sourceIsTopLevel) {
    prototype.forEach((reaction, index) => {
      if (!reaction || typeof reaction !== "object" || Array.isArray(reaction)) return;
      if (isAfterTimeoutReaction(reaction as JsonObject)) {
        errors.push(`${path}[${index}].trigger: AFTER_TIMEOUT in set.prototype requires a top-level target node`);
      }
    });
  }

  forEachPrototypeDestination(prototype, (_action, type, destination, actionPath) => {
    if (!TOP_LEVEL_NAV_ACTIONS.has(type)) return;
    if (!lookup.has(destination)) return; // already reported
    if (lookup.isTopLevel && !lookup.isTopLevel(destination)) {
      errors.push(`${actionPath}.destination: ${type} destination must be a top-level frame; use '${lookup.canvasOf?.(destination) || destination}'`);
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

function documentLookup(document: InternalDocument): PrototypeLookup {
  const types = new Map<string, string>();
  const collect = (node: InternalNode): void => {
    types.set(node.id, node.type);
    node.children.forEach(collect);
  };
  document.nodes.forEach(collect);
  return {
    has: (id) => types.has(id),
    typeOf: (id) => types.get(id),
    canvasOf: (id) => canvasRootId(document.nodes, id),
    isTopLevel: (id) => isTopLevelNodeId(document.nodes, id)
  };
}

/**
 * Document-wide prototype destination errors (missing / CHANGE_TO / SCROLL_TO).
 * Used by validateDocument so end-of-patch remove of a destination fails.
 * Import-lenient: nested NAVIGATE destinations are allowed here.
 */
export function prototypeDestinationErrors(document: InternalDocument): string[] {
  const lookup = documentLookup(document);
  const errors: string[] = [];
  const walk = (node: InternalNode, path: string): void => {
    if (node.properties.prototype) {
      errors.push(...assertPrototypeSetDestinations(node.properties.prototype, lookup, `${path}.prototype`, node.id));
    }
    node.children.forEach((child, index) => walk(child, `${path}.children[${index}]`));
  };
  document.nodes.forEach((node, index) => walk(node, `nodes[${index}]`));
  return errors;
}

/**
 * Strict patch rules across the whole document (top-level NAVIGATE dest +
 * AFTER_TIMEOUT only on top-level hosts). Used at end of patch with multiset
 * exemption against the pre-patch document.
 */
export function prototypePatchStrictErrors(document: InternalDocument): string[] {
  const lookup = documentLookup(document);
  const errors: string[] = [];
  const walk = (node: InternalNode, path: string): void => {
    if (node.properties.prototype) {
      errors.push(...assertPrototypePatchRules(
        node.properties.prototype,
        lookup,
        `${path}.prototype`,
        node.id,
        isTopLevelNodeId(document.nodes, node.id)
      ));
    }
    node.children.forEach((child, index) => walk(child, `${path}.children[${index}]`));
  };
  document.nodes.forEach((node, index) => walk(node, `nodes[${index}]`));
  return errors;
}
