import { validationIssues, type RepairIssue } from "./lint";
import { patchSetTargetIssues, type PatchTargetContext } from "./patch-keys";
import type { DesignProperties, InternalDocument, InternalNode, InternalPatchDocument, JsonObject, PatchOperation, PatchSetValues } from "./types";
import { documentIssueOwners, validateDocument } from "./validate";

export interface PatchResult { document: InternalDocument; affectedIds: string[]; }

/** Thrown by applyPatch. `issues` carries every problem as structured repair output. */
export class PatchError extends Error {
  readonly issues: RepairIssue[];
  constructor(issues: RepairIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "PatchError";
    this.issues = issues;
  }
}

const CONTAINER_TYPES = new Set(["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "SECTION", "BOOLEAN_OPERATION"]);
const RUN_STYLE_KEYS = ["font", "fill", "letterSpacing", "textDecoration", "link"];

function cloneValue<T>(value: T): T {
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)])) as T;
  return value;
}

function cloneNode(node: InternalNode): InternalNode {
  return { ...node, properties: cloneValue(node.properties), children: node.children.map(cloneNode) };
}

type NodeRef = { node: InternalNode; parent: InternalNode | null; siblings: InternalNode[] };

function translate(node: InternalNode, dx: number, dy: number): void {
  if (!dx && !dy) return;
  node.properties.position = { x: node.properties.position.x + dx, y: node.properties.position.y + dy };
  for (const child of node.children) translate(child, dx, dy);
}

function origin(parent: InternalNode | null): { x: number; y: number } {
  return parent ? { x: parent.properties.position.x, y: parent.properties.position.y } : { x: 0, y: 0 };
}

const isObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Core's view of a target, mirrored by the Figma adapter's figmaPatchContext. */
export function corePatchContext(node: InternalNode, parent: InternalNode | null): PatchTargetContext {
  const props = node.properties;
  const runs = Array.isArray(props.runs) ? props.runs : [];
  return {
    type: node.type,
    parentType: parent ? parent.type : null,
    parentAutoLayout: Boolean(parent?.properties.layout?.direction),
    autoLayout: Boolean(props.layout?.direction),
    layoutPositioning: props.layoutPositioning,
    mixedText: node.type === "TEXT" && runs.some((run) => RUN_STYLE_KEYS.some((key) => run[key] !== undefined)),
    mixedFontName: node.type === "TEXT" && runs.some((run) => isObject(run.font) && (run.font.family !== undefined || run.font.style !== undefined)),
    textStyle: Boolean(props.styleRefs?.text),
    boundFields: Object.keys(props.bindings || {}),
    childCount: node.children.length
  };
}

function detach(props: DesignProperties, field: "fill" | "stroke"): void {
  for (const key of ["bindings", "styleRefs"] as const) {
    const map = props[key];
    if (!map || map[field] === undefined) continue;
    const next = { ...map }; delete next[field];
    if (Object.keys(next).length) props[key] = next; else delete props[key];
  }
}

function stripRuns(props: DesignProperties, keys: string[]): void {
  if (!Array.isArray(props.runs)) return;
  props.runs = props.runs.map((run) => {
    const next = { ...run };
    for (const key of keys) {
      if (key.startsWith("font.")) {
        if (isObject(next.font)) {
          const font = { ...next.font }; delete font[key.slice(5)];
          if (Object.keys(font).length) next.font = font; else delete next.font;
        }
      } else delete next[key];
    }
    return next;
  });
}

/**
 * Merge semantics (see PATCH_SET_SEMANTICS):
 * objects deep-merge (layout, layout.padding, font, constraints); arrays replace
 * (fills, strokes, effects, runs, grids, paths); everything else is a scalar.
 * x/y are parent-relative and move the whole subtree.
 */
function mergeSet(ref: NodeRef, values: PatchSetValues): void {
  const { node, parent } = ref;
  const props = node.properties;
  if (values.name !== undefined) node.name = values.name;
  if (values.position) {
    const base = origin(parent);
    const x = values.position.x !== undefined ? base.x + values.position.x : props.position.x;
    const y = values.position.y !== undefined ? base.y + values.position.y : props.position.y;
    translate(node, x - props.position.x, y - props.position.y);
  }
  if (values.size) props.size = { width: values.size.width ?? props.size.width, height: values.size.height ?? props.size.height };
  const styleKeys: string[] = [];
  if (values.styles?.fills) {
    props.styles.fills = cloneValue(values.styles.fills);
    // Figma replaces bound / style-linked paints when fills are assigned; mirror that.
    detach(props, "fill");
    styleKeys.push("fill");
  }
  if (values.styles?.strokes) {
    props.styles.strokes = cloneValue(values.styles.strokes);
    detach(props, "stroke");
  }
  if (values.styles?.effects) props.styles.effects = cloneValue(values.styles.effects);
  if (values.layout) {
    const current = props.layout || {};
    const padding = values.layout.padding ? { ...(current.padding || {}), ...values.layout.padding } : current.padding;
    props.layout = { ...current, ...cloneValue(values.layout), ...(padding ? { padding } : {}) };
  }
  if (values.constraints) props.constraints = { horizontal: "MIN", vertical: "MIN", ...(props.constraints || {}), ...values.constraints } as DesignProperties["constraints"];
  if (node.type === "TEXT") {
    // Node-level typography applies to the whole text (Figma semantics), so
    // range overrides of the same attribute on existing runs are cleared.
    if (values.font) {
      stripRuns(props, Object.keys(values.font).map((key) => `font.${key}`));
      props.font = { ...(props.font || {}), ...values.font } as DesignProperties["font"];
    }
    if (values.letterSpacing !== undefined) styleKeys.push("letterSpacing");
    if (values.textDecoration !== undefined) styleKeys.push("textDecoration");
    stripRuns(props, styleKeys);
    if (values.runs !== undefined) {
      props.runs = cloneValue(values.runs);
      props.text = values.text !== undefined ? values.text : values.runs.map((run) => typeof run.text === "string" ? run.text : "").join("");
    } else if (values.text !== undefined) {
      props.text = values.text;
      delete props.runs;
    }
  }
  const handled = new Set(["name", "position", "size", "styles", "layout", "constraints", "font", "runs", "text"]);
  for (const [key, value] of Object.entries(values)) {
    if (handled.has(key)) continue;
    Object.assign(props, { [key]: cloneValue(value) });
  }
}

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

function assertNotInsideInstance(parent: InternalNode | null, operationIndex: number, id: string, index: Map<string, NodeRef>): void {
  if (parent && hasInstanceAncestor(parent, index)) {
    throw new Error(`patch.operations[${operationIndex}]: node '${id}' is inside an INSTANCE and cannot be moved.`);
  }
}

function patchIssue(code: string, path: string, message: string, suggestion: string): RepairIssue {
  return { severity: "ERROR", code, path, message, suggestion };
}

function applyOperation(operation: PatchOperation, operationIndex: number, index: Map<string, NodeRef>, visit: (nodes: InternalNode[], parent: InternalNode | null) => void, affectedIds: string[]): void {
  if (operation.op === "APPEND" || operation.op === "INSERT") {
    const target = operation.parent ? index.get(operation.parent) : undefined;
    if (!target || !operation.node) throw new Error(`patch.operations[${operationIndex}]: parent '${operation.parent || ""}' was not found.`);
    assertContainerParent(target.node, operationIndex, operation.parent || "", index);
    if (index.has(operation.node.id)) throw new Error(`patch.operations[${operationIndex}]: ID '${operation.node.id}' already exists.`);
    const child = cloneNode(operation.node);
    // Authored node coordinates are parent-relative; core stores absolute.
    const base = origin(target.node);
    translate(child, base.x, base.y);
    if (operation.op === "APPEND") {
      target.node.children.push(child);
    } else {
      const at = clampIndex(operation.index ?? 0, target.node.children.length);
      target.node.children.splice(at, 0, child);
    }
    visit([child], target.node);
    affectedIds.push(child.id);
    return;
  }
  if (operation.op === "MOVE") {
    const moving = operation.id ? index.get(operation.id) : undefined;
    if (!moving) throw new Error(`patch.operations[${operationIndex}]: node '${operation.id || ""}' was not found.`);
    if (!moving.parent) throw new Error(`patch.operations[${operationIndex}]: cannot move the document root.`);
    assertNotInsideInstance(moving.parent, operationIndex, operation.id || "", index);
    const destination = operation.parent ? index.get(operation.parent) : undefined;
    if (!destination) throw new Error(`patch.operations[${operationIndex}]: parent '${operation.parent || ""}' was not found.`);
    assertContainerParent(destination.node, operationIndex, operation.parent || "", index);
    if (destination.node === moving.node || isDescendantOf(moving.node, destination.node)) {
      throw new Error(`patch.operations[${operationIndex}]: cannot move a node under itself or its descendants.`);
    }
    // A move keeps the node's parent-relative x/y (as Figma's insertChild does).
    const from = origin(moving.parent);
    const to = origin(destination.node);
    translate(moving.node, to.x - from.x, to.y - from.y);
    const fromIndex = moving.siblings.indexOf(moving.node);
    moving.siblings.splice(fromIndex, 1);
    // Same-parent moves: index is the final position after removal.
    const at = clampIndex(operation.index ?? 0, destination.node.children.length);
    destination.node.children.splice(at, 0, moving.node);
    index.set(moving.node.id, { node: moving.node, parent: destination.node, siblings: destination.node.children });
    visit(moving.node.children, moving.node);
    affectedIds.push(moving.node.id);
    return;
  }
  const target = operation.id ? index.get(operation.id) : undefined;
  if (!target) throw new Error(`patch.operations[${operationIndex}]: node '${operation.id || ""}' was not found.`);
  if (operation.op === "REMOVE") {
    const removeAll = (node: InternalNode): void => { index.delete(node.id); node.children.forEach(removeAll); };
    target.siblings.splice(target.siblings.indexOf(target.node), 1); removeAll(target.node); affectedIds.push(target.node.id);
    return;
  }
  const set = operation.set || {};
  const values = operation.normalized;
  if (!values) throw new Error(`patch.operations[${operationIndex}]: SET '${operation.id}' was not normalized.`);
  const issues = patchSetTargetIssues(set, corePatchContext(target.node, target.parent));
  if (issues.length) {
    throw new PatchError(issues.map((message) => {
      const split = message.indexOf(":");
      return patchIssue("PATCH_SET_INVALID", `patch.operations[${operationIndex}].set.${message.slice(0, split)}`, message.slice(split + 1).trim(), "Use a key that applies to this node, or see the patch rules in DESIGN-LANGUAGE.md.");
    }));
  }
  mergeSet(target, values);
  affectedIds.push(target.node.id);
}

/**
 * Apply a normalized patch to a canonical document. The input is never
 * mutated. Throws PatchError (with structured issues) when an operation is
 * rejected or when the patched document fails validateDocument.
 */
export function applyDocumentPatch(document: InternalDocument, patch: InternalPatchDocument): PatchResult {
  const result: InternalDocument = { ...document, nodes: document.nodes.map(cloneNode), styles: cloneValue(document.styles), variables: cloneValue(document.variables) };
  const affectedIds: string[] = [];
  const index = new Map<string, NodeRef>();
  const visit = (nodes: InternalNode[], parent: InternalNode | null): void => nodes.forEach((node) => { index.set(node.id, { node, parent, siblings: nodes }); visit(node.children, node); });
  visit(result.nodes, null);
  for (const [operationIndex, operation] of patch.patch.operations.entries()) {
    try {
      applyOperation(operation, operationIndex, index, visit, affectedIds);
    } catch (error) {
      if (error instanceof PatchError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const split = message.indexOf(": ");
      throw new PatchError([patchIssue("PATCH_OPERATION", split > 0 ? message.slice(0, split) : `patch.operations[${operationIndex}]`, split > 0 ? message.slice(split + 2) : message, "Target nodes that exist and containers that can accept children.")]);
    }
  }
  const introduced = newDocumentIssues(document, result);
  if (introduced.length) throw new PatchError(introduced);
  return { document: result, affectedIds };
}

/**
 * Issues present in `after` but not in `before`. Issues already in the input
 * document never block a patch, even on nodes the patch touches; only issues
 * the patch introduces (directly or through a move/insert/remove) are
 * reported. Identity is code + owner (node id / variable / document) + the
 * property path inside the owner + message, never an array index, and the
 * comparison is a multiset so a second copy of an existing issue counts as new.
 */
export function newDocumentIssues(before: InternalDocument, after: InternalDocument): RepairIssue[] {
  const keyed = (document: InternalDocument) => {
    const owners = documentIssueOwners(document);
    return validationIssues(validateDocument(document, Infinity)).map((issue) => {
      const owner = owners(issue.path);
      return { issue, owner, key: `${issue.code}|${owner.owner}|${owner.rest}|${issue.message}` };
    });
  };
  const existing = new Map<string, number>();
  for (const { key } of keyed(before)) existing.set(key, (existing.get(key) || 0) + 1);
  const introduced: RepairIssue[] = [];
  for (const { issue, owner, key } of keyed(after)) {
    const count = existing.get(key) || 0;
    if (count > 0) { existing.set(key, count - 1); continue; }
    const where = owner.nodeId !== undefined ? ` (node '${owner.nodeId}')` : "";
    introduced.push({ ...issue, code: "PATCH_RESULT_INVALID", message: `after patch${where}: ${issue.message}`, suggestion: "This issue is introduced by the patch; issues already in the input document are not reported." });
  }
  return introduced;
}
