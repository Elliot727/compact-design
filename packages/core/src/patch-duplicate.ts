import type { InternalNode, JsonObject } from "./types";

/** Collect every id in a subtree (root first, depth-first). */
export function collectSubtreeIds(node: InternalNode): string[] {
  const ids = [node.id];
  for (const child of node.children) ids.push(...collectSubtreeIds(child));
  return ids;
}

export function subtreeContainsType(node: InternalNode, types: Set<string>): boolean {
  if (types.has(node.type)) return true;
  return node.children.some((child) => subtreeContainsType(child, types));
}

/**
 * Build the deterministic id map for a duplicate.
 * Default: `<sourceId><idSuffix>` for every id in the subtree.
 * `ids` overrides specific source→new mappings; every key must be in the subtree.
 */
export function buildDuplicateIdMap(
  source: InternalNode,
  idSuffix: string,
  ids: Record<string, string> | undefined,
  path: string
): { map: Map<string, string>; errors: string[] } {
  return buildDuplicateIdMapFromIds(collectSubtreeIds(source), idSuffix, ids, path);
}

/** Same as buildDuplicateIdMap but when only the id set is known (e.g. live Figma walk). */
export function buildDuplicateIdMapFromIds(
  subtreeIds: Iterable<string>,
  idSuffix: string,
  ids: Record<string, string> | undefined,
  path: string
): { map: Map<string, string>; errors: string[] } {
  const errors: string[] = [];
  if (typeof idSuffix !== "string" || !idSuffix) {
    errors.push(`${path}.idSuffix: must be a non-empty string`);
    return { map: new Map(), errors };
  }
  const subtree = new Set(subtreeIds);
  const map = new Map<string, string>();
  for (const id of subtree) map.set(id, `${id}${idSuffix}`);

  if (ids !== undefined) {
    if (!ids || typeof ids !== "object" || Array.isArray(ids)) {
      errors.push(`${path}.ids: must be an object of sourceId→newId`);
    } else {
      for (const [from, to] of Object.entries(ids)) {
        if (!subtree.has(from)) {
          errors.push(`${path}.ids.${from}: is not an id in the source subtree`);
          continue;
        }
        if (typeof to !== "string" || !to) {
          errors.push(`${path}.ids.${from}: new id must be a non-empty string`);
          continue;
        }
        map.set(from, to);
      }
    }
  }

  const seen = new Map<string, string>();
  for (const [from, to] of map) {
    const prior = seen.get(to);
    if (prior !== undefined) {
      errors.push(`${path}: duplicate maps both '${prior}' and '${from}' to '${to}'`);
    } else {
      seen.set(to, from);
    }
  }
  return { map, errors };
}

/** Deep-clone a node tree applying an id map (and re-pointing internal prototype destinations). */
export function cloneSubtreeWithIds(node: InternalNode, idMap: Map<string, string>): InternalNode {
  const mappedId = idMap.get(node.id) || node.id;
  const properties = cloneValue(node.properties);
  rewritePrototypeDestinations(properties as unknown as JsonObject, idMap);
  return {
    ...node,
    id: mappedId,
    properties,
    children: node.children.map((child) => cloneSubtreeWithIds(child, idMap))
  };
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as object).map(([key, item]) => [key, cloneValue(item)])) as T;
  }
  return value;
}

/** Re-point prototype destinations that land inside the duplicated subtree. */
export function rewritePrototypeDestinations(properties: JsonObject, idMap: Map<string, string>): void {
  const prototype = properties.prototype;
  if (!Array.isArray(prototype)) return;
  for (const reaction of prototype) {
    if (!reaction || typeof reaction !== "object" || Array.isArray(reaction)) continue;
    const actions = (reaction as { actions?: unknown }).actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      if (!action || typeof action !== "object" || Array.isArray(action)) continue;
      const dest = (action as { destination?: unknown }).destination;
      if (typeof dest === "string" && idMap.has(dest)) {
        (action as { destination: string }).destination = idMap.get(dest)!;
      }
    }
  }
}

/**
 * Replace only delimited whole ids in text (quoted `'id'` / `"id"`, or path
 * segments bounded by non-id characters). Longest source ids first so
 * `card-title` is not corrupted by a shorter `card` mapping.
 */
export function remapDelimitedIds(text: string, idMap: Map<string, string>): string {
  if (!text || idMap.size === 0) return text;
  const entries = [...idMap.entries()].sort((a, b) => b[0].length - a[0].length);
  let result = text;
  for (const [from, to] of entries) {
    // Quoted forms used in validation messages: 'id' or "id"
    result = result.split(`'${from}'`).join(`'${to}'`);
    result = result.split(`"${from}"`).join(`"${to}"`);
  }
  return result;
}

/**
 * Remap issue identity keys through a source→copy id map so duplicated
 * pre-existing issues on the copy are exempt (with multiplicity).
 * Owner is remapped exactly (`node:${id}`); path/message only via delimited ids.
 */
export function remapIssueKeyThroughDuplicate(key: string, idMap: Map<string, string>): string | null {
  // key format: `${code}|${owner}|${rest}|${message}`
  // owner is `node:${id}`, `variable:...`, or `document`
  const parts = key.split("|");
  if (parts.length < 4) return null;
  const [code, owner, rest, ...messageParts] = parts;
  const message = messageParts.join("|");
  let nextOwner = owner;
  let changed = false;

  if (owner.startsWith("node:")) {
    const id = owner.slice("node:".length);
    const mapped = idMap.get(id);
    if (mapped) {
      nextOwner = `node:${mapped}`;
      changed = true;
    }
  }

  const nextRest = remapDelimitedIds(rest, idMap);
  const nextMessage = remapDelimitedIds(message, idMap);
  if (nextRest !== rest || nextMessage !== message) changed = true;

  return changed ? `${code}|${nextOwner}|${nextRest}|${nextMessage}` : null;
}
