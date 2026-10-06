import { validationIssues, type RepairIssue } from "./lint";
import { patchSetBindingFields, patchSetTargetIssues, type PatchTargetContext } from "./patch-keys";
import type { DesignProperties, InternalDocument, InternalNode, InternalPatchDocument, JsonObject, PatchOperation, PatchSetValues } from "./types";
import { applyComponentPropertiesPatch, applyVariantPatchOnComponent, applyVariantRenamesInForest, detectVariantRenames, rewriteVariantChildNames, variantAxesChildConflicts, type VariantAxesPatch } from "./patch-definitions";
import { buildDuplicateIdMap, cloneSubtreeWithIds, remapIssueKeyThroughDuplicate, subtreeContainsType } from "./patch-duplicate";
import { assertPrototypePatchRules, canvasRootId, forEachPrototypeDestination, isTopLevelNodeId, prototypePatchStrictErrors } from "./patch-prototype";
import { documentIssueOwners, validateDocument } from "./validate";
import { applyResourceUpsert } from "./patch-resources";
import { hasNonZeroRotation, nodesBoundingBox, unwrapLostVisuals } from "./patch-wrap";
import {
  collectIds, findDescendant, frameToInstanceShell, matchLayer, readPropertyValue,
  structuralDiff, subtreeHasPropertyReferences, type ComponentizeProperties
} from "./patch-componentize";

export interface PatchResult { document: InternalDocument; affectedIds: string[]; warnings: string[]; }

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

function detachField(props: DesignProperties, mapKey: "bindings" | "styleRefs", field: string): boolean {
  const map = props[mapKey];
  if (!map || map[field] === undefined) return false;
  const next = { ...map }; delete next[field];
  if (Object.keys(next).length) props[mapKey] = next; else delete props[mapKey];
  return true;
}

function detach(props: DesignProperties, field: "fill" | "stroke"): string[] {
  const warnings: string[] = [];
  if (detachField(props, "bindings", field)) warnings.push(`detached bindings.${field}`);
  if (detachField(props, "styleRefs", field)) warnings.push(`detached styleRefs.${field}`);
  return warnings;
}

/** Shallow-merge an object map; `null` field clears; whole-value `null` clears the map. */
function mergeObjectMap<T extends Record<string, unknown>>(
  current: T | undefined,
  patch: T | null | undefined,
  assign: (next: T | undefined) => void
): void {
  if (patch === undefined) return;
  if (patch === null) { assign(undefined); return; }
  const next: Record<string, unknown> = { ...(current || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  assign(Object.keys(next).length ? next as T : undefined);
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
function mergeSet(ref: NodeRef, values: PatchSetValues, set: JsonObject, warnings: string[]): void {
  const { node, parent } = ref;
  const props = node.properties;
  const path = `node '${node.id}'`;
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
    for (const message of detach(props, "fill")) warnings.push(`${path}: ${message} because fill was set`);
    styleKeys.push("fill");
  }
  if (values.styles?.strokes) {
    props.styles.strokes = cloneValue(values.styles.strokes);
    for (const message of detach(props, "stroke")) warnings.push(`${path}: ${message} because stroke was set`);
  }
  if (values.styles?.effects) props.styles.effects = cloneValue(values.styles.effects);
  if (values.layout) {
    const current = props.layout || {};
    const padding = values.layout.padding ? { ...(current.padding || {}), ...values.layout.padding } : current.padding;
    props.layout = { ...current, ...cloneValue(values.layout), ...(padding ? { padding } : {}) };
  }
  if (values.constraints) props.constraints = { horizontal: "MIN", vertical: "MIN", ...(props.constraints || {}), ...values.constraints } as DesignProperties["constraints"];
  if (node.type === "TEXT") {
    if (values.font || setTouchesTextStyle(set)) {
      if (props.styleRefs?.text) {
        detachField(props, "styleRefs", "text");
        warnings.push(`${path}: detached styleRefs.text because typography was set`);
      }
    }
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
  // Detach non-paint bindings overwritten by scalar/layout/font fields (with warning).
  const overwritten = patchSetBindingFields(set).filter((field) => props.bindings && props.bindings[field] !== undefined);
  for (const field of [...new Set(overwritten)]) {
    detachField(props, "bindings", field);
    warnings.push(`${path}: detached bindings.${field} because the set overwrites it`);
  }
  mergeObjectMap(props.bindings as Record<string, unknown> | undefined, values.bindings as Record<string, unknown> | null | undefined, (next) => {
    if (next) props.bindings = next as DesignProperties["bindings"]; else delete props.bindings;
  });
  mergeObjectMap(props.styleRefs as Record<string, unknown> | undefined, values.styleRefs as Record<string, unknown> | null | undefined, (next) => {
    if (next) props.styleRefs = next as DesignProperties["styleRefs"]; else delete props.styleRefs;
  });
  mergeObjectMap(props.variableModes as Record<string, unknown> | undefined, values.variableModes as Record<string, unknown> | null | undefined, (next) => {
    if (next) props.variableModes = next as DesignProperties["variableModes"]; else delete props.variableModes;
  });
  mergeObjectMap(props.instanceProperties as Record<string, unknown> | undefined, values.instanceProperties as Record<string, unknown> | null | undefined, (next) => {
    if (next) props.instanceProperties = next as DesignProperties["instanceProperties"]; else delete props.instanceProperties;
  });
  mergeObjectMap(props.componentPropertyReferences as Record<string, unknown> | undefined, values.componentPropertyReferences as Record<string, unknown> | null | undefined, (next) => {
    if (next) props.componentPropertyReferences = next as DesignProperties["componentPropertyReferences"]; else delete props.componentPropertyReferences;
  });
  const handled = new Set(["name", "position", "size", "styles", "layout", "constraints", "font", "runs", "text", "bindings", "styleRefs", "variableModes", "instanceProperties", "componentPropertyReferences", "componentProperties", "variantAxes", "variant"]);
  for (const [key, value] of Object.entries(values)) {
    if (handled.has(key)) continue;
    Object.assign(props, { [key]: cloneValue(value) });
  }
}

function setTouchesTextStyle(set: JsonObject): boolean {
  return ["lineHeight", "letterSpacing", "paragraphSpacing", "paragraphIndent", "listSpacing", "textCase", "textDecoration", "hangingPunctuation", "hangingList"].some((key) => key in set);
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

function applyOperation(operation: PatchOperation, operationIndex: number, index: Map<string, NodeRef>, visit: (nodes: InternalNode[], parent: InternalNode | null) => void, affectedIds: string[], warnings: string[], roots: InternalNode[], duplicateMaps: Array<Map<string, string>>): void {
  if (operation.op === "APPEND" || operation.op === "INSERT") {
    const target = operation.parent ? index.get(operation.parent) : undefined;
    if (!target || !operation.node) throw new Error(`patch.operations[${operationIndex}]: parent '${operation.parent || ""}' was not found.`);
    assertContainerParent(target.node, operationIndex, operation.parent || "", index);
    if (index.has(operation.node.id)) throw new Error(`patch.operations[${operationIndex}]: ID '${operation.node.id}' already exists.`);
    const child = cloneNode(operation.node);
    // Authored node coordinates are parent-relative; core stores absolute.
    const base = origin(target.node);
    translate(child, base.x, base.y);
    if (target.node.type === "COMPONENT_SET" && child.type === "COMPONENT") {
      const axes = target.node.properties.variantAxes || {};
      const selected = child.properties.variant || {};
      if (Object.keys(axes).length) {
        child.name = Object.keys(axes).map((axis) => `${axis}=${selected[axis] ?? axes[axis][0]}`).join(", ");
      } else if (Object.keys(selected).length) {
        child.name = Object.entries(selected).map(([axis, value]) => `${axis}=${value}`).join(", ");
      }
    }
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

  if (operation.op === "DUPLICATE") {
    const sourceRef = operation.id ? index.get(operation.id) : undefined;
    if (!sourceRef) throw new Error(`patch.operations[${operationIndex}]: node '${operation.id || ""}' was not found.`);
    assertNotInsideInstance(sourceRef.parent, operationIndex, operation.id || "", index);
    if (subtreeContainsType(sourceRef.node, new Set(["COMPONENT", "COMPONENT_SET"]))) {
      throw new Error(`patch.operations[${operationIndex}]: cannot duplicate a COMPONENT or COMPONENT_SET (or a subtree that contains one)`);
    }
    const path = `patch.operations[${operationIndex}]`;
    const { map, errors } = buildDuplicateIdMap(sourceRef.node, operation.idSuffix || "", operation.ids, path);
    if (errors.length) throw new Error(errors[0]);
    // Collisions with existing document ids
    for (const [, newId] of map) {
      if (index.has(newId)) throw new Error(`${path}: new id '${newId}' already exists`);
    }
    let destParent: InternalNode | null;
    let destSiblings: InternalNode[];
    if (operation.parent !== undefined) {
      const dest = index.get(operation.parent);
      if (!dest) throw new Error(`${path}: parent '${operation.parent}' was not found.`);
      assertContainerParent(dest.node, operationIndex, operation.parent, index);
      destParent = dest.node;
      destSiblings = dest.node.children;
    } else if (sourceRef.parent) {
      destParent = sourceRef.parent;
      destSiblings = sourceRef.siblings;
      // Parent could be INSTANCE? Source is not inside INSTANCE (asserted), so parent is fine.
    } else {
      // Top-level screen: duplicate among document roots
      destParent = null;
      destSiblings = roots;
    }
    if (destParent) assertContainerParent(destParent, operationIndex, destParent.id, index);
    const copy = cloneSubtreeWithIds(sourceRef.node, map);
    // Keep parent-relative x/y (same as move / Figma clone+insertChild): core stores
    // absolute coords, so translate by the origin delta when the parent changes.
    const fromOrigin = origin(sourceRef.parent);
    const toOrigin = origin(destParent);
    translate(copy, toOrigin.x - fromOrigin.x, toOrigin.y - fromOrigin.y);
    let at: number;
    if (operation.index !== undefined) {
      at = clampIndex(operation.index, destSiblings.length);
    } else if (destParent === sourceRef.parent || (destParent === null && sourceRef.parent === null)) {
      const sourceIndex = sourceRef.siblings.indexOf(sourceRef.node);
      at = clampIndex(sourceIndex + 1, destSiblings.length);
    } else {
      at = destSiblings.length;
    }
    destSiblings.splice(at, 0, copy);
    visit([copy], destParent);
    duplicateMaps.push(map);
    affectedIds.push(copy.id);
    return;
  }
  if (operation.op === "WRAP") {
    const wrapIds = operation.wrapIds || [];
    if (!wrapIds.length) throw new Error(`patch.operations[${operationIndex}].ids must be a non-empty array.`);
    if (!operation.node) throw new Error(`patch.operations[${operationIndex}].node is required.`);
    if (operation.node.type !== "FRAME") throw new Error(`patch.operations[${operationIndex}].node.type must be FRAME.`);
    if (index.has(operation.node.id)) throw new Error(`patch.operations[${operationIndex}]: ID '${operation.node.id}' already exists.`);
    if (wrapIds.includes(operation.node.id)) throw new Error(`patch.operations[${operationIndex}]: cannot wrap a node into itself.`);

    const refs = wrapIds.map((id) => {
      const ref = index.get(id);
      if (!ref) throw new Error(`patch.operations[${operationIndex}]: node '${id}' was not found.`);
      return ref;
    });
    const parent = refs[0].parent; // null when wrapping top-level canvases
    for (const ref of refs) {
      if (ref.parent !== parent) throw new Error(`patch.operations[${operationIndex}]: all ids must share the same parent.`);
      if (ref.siblings !== refs[0].siblings) throw new Error(`patch.operations[${operationIndex}]: all ids must share the same parent.`);
    }
    if (parent) {
      assertNotInsideInstance(parent, operationIndex, wrapIds[0], index);
      assertContainerParent(parent, operationIndex, parent.id, index);
    }

    // Ancestors of the shared parent (inclusive) for rotation check
    const ancestors: InternalNode[] = [];
    let walk: InternalNode | null = parent;
    while (walk) {
      ancestors.push(walk);
      const parentRef = index.get(walk.id);
      walk = parentRef?.parent ?? null;
      if (ancestors.length > 1000) break;
    }
    for (const ref of refs) {
      if (hasNonZeroRotation(ref.node, ancestors)) {
        throw new Error(`patch.operations[${operationIndex}]: wrap does not support rotated nodes or parents (node '${ref.node.id}' or an ancestor has non-zero rotation).`);
      }
    }

    const ordered = refs.map((ref) => ref.node);
    const bbox = nodesBoundingBox(ordered);
    const wrapper = cloneNode(operation.node);
    wrapper.children = [];
    // Absolute position = bbox origin; size = authored or bbox
    const authoredW = Number.isFinite(wrapper.properties.size.width) && wrapper.properties.size.width > 0;
    const authoredH = Number.isFinite(wrapper.properties.size.height) && wrapper.properties.size.height > 0;
    wrapper.properties.position = { x: bbox.x, y: bbox.y };
    wrapper.properties.size = {
      width: authoredW ? wrapper.properties.size.width : bbox.width,
      height: authoredH ? wrapper.properties.size.height : bbox.height
    };

    // Sibling list is either the parent's children or the document roots.
    const siblings = refs[0].siblings;
    const firstIndex = siblings.indexOf(refs[0].node);
    const removeSet = new Set(ordered);
    const remaining = siblings.filter((child) => !removeSet.has(child));
    // Mutate the live sibling array in place (parent.children or document.nodes).
    siblings.length = 0;
    siblings.push(...remaining);
    const at = clampIndex(operation.index !== undefined ? operation.index : firstIndex, remaining.length);
    siblings.splice(at, 0, wrapper);
    if (parent) parent.children = siblings;

    // Reparent: absolute-preserving (no translate). Children keep absolute coords.
    for (const child of ordered) {
      wrapper.children.push(child);
    }
    // Index wrapper against the real sibling list (document.nodes or parent.children),
    // not a temporary array — visit([wrapper], …) would bind the wrong siblings ref.
    index.set(wrapper.id, { node: wrapper, parent, siblings });
    for (const child of ordered) {
      index.set(child.id, { node: child, parent: wrapper, siblings: wrapper.children });
      visit(child.children, child);
    }
    affectedIds.push(wrapper.id, ...wrapIds);
    return;
  }

  if (operation.op === "UNWRAP") {
    const target = operation.id ? index.get(operation.id) : undefined;
    if (!target) throw new Error(`patch.operations[${operationIndex}]: node '${operation.id || ""}' was not found.`);
    const wrapper = target.node;
    if (wrapper.type === "COMPONENT" || wrapper.type === "COMPONENT_SET" || wrapper.type === "INSTANCE" || wrapper.type === "BOOLEAN_OPERATION") {
      throw new Error(`patch.operations[${operationIndex}]: cannot unwrap ${wrapper.type}.`);
    }
    if (wrapper.type !== "FRAME" && wrapper.type !== "GROUP") {
      throw new Error(`patch.operations[${operationIndex}]: unwrap only accepts FRAME or GROUP (received ${wrapper.type}).`);
    }
    // Top-level unwrap is allowed (promotes children to document roots) so end-of-patch
    // SCROLL_TO canvas checks can fire when siblings become separate canvases.
    if (target.parent) {
      assertNotInsideInstance(target.parent, operationIndex, operation.id || "", index);
    }
    {
      const ancestors: InternalNode[] = [];
      let walk: InternalNode | null = target.parent;
      while (walk) {
        ancestors.push(walk);
        walk = index.get(walk.id)?.parent ?? null;
        if (ancestors.length > 1000) break;
      }
      if (hasNonZeroRotation(wrapper, ancestors)) {
        throw new Error(`patch.operations[${operationIndex}]: unwrap does not support rotated nodes or parents (node '${wrapper.id}' or an ancestor has non-zero rotation).`);
      }
    }

    // Eager: fail if anything outside the wrapper still targets it via prototype
    const wrapperId = wrapper.id;
    const childIds = new Set<string>();
    const collect = (node: InternalNode) => { childIds.add(node.id); node.children.forEach(collect); };
    collect(wrapper);
    for (const [id, ref] of index) {
      if (id === wrapperId || childIds.has(id)) continue;
      const proto = ref.node.properties.prototype;
      if (!Array.isArray(proto)) continue;
      forEachPrototypeDestination(proto, (_action, _type, destination, actionPath) => {
        if (destination === wrapperId) {
          throw new Error(`patch.operations[${operationIndex}]: cannot unwrap '${wrapperId}' while ${actionPath} still targets it`);
        }
      });
    }

    const lost = unwrapLostVisuals(wrapper.properties);
    if (lost.length) {
      warnings.push(`unwrap '${wrapperId}': dropped wrapper ${lost.join(", ")}`);
    }

    const grandparent = target.parent; // null when unwrapping a top-level frame
    const siblings = target.siblings; // parent.children or document.nodes
    const at = siblings.indexOf(wrapper);
    const children = [...wrapper.children];
    siblings.splice(at, 1);
    index.delete(wrapperId);
    // Promote children at wrapper's slot (absolute-preserving: no translate).
    // If grandparent is Auto Layout, flow children become AL items at this slot;
    // ABSOLUTE-positioned children keep their absolute canvas positions.
    // Top-level unwrap: children become new document roots (separate canvases).
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      siblings.splice(at + i, 0, child);
      index.set(child.id, { node: child, parent: grandparent, siblings });
      visit(child.children, child);
      affectedIds.push(child.id);
    }
    if (grandparent) grandparent.children = siblings;
    wrapper.children = [];
    affectedIds.push(wrapperId);
    return;
  }


  if (operation.op === "COMPONENTIZE") {
    const sourceRef = operation.id ? index.get(operation.id) : undefined;
    if (!sourceRef) throw new Error(`patch.operations[${operationIndex}]: node '${operation.id || ""}' was not found.`);
    const source = sourceRef.node;
    if (source.type !== "FRAME") {
      throw new Error(`patch.operations[${operationIndex}]: componentize only accepts FRAME (received ${source.type}).`);
    }
    if (sourceRef.parent) assertNotInsideInstance(sourceRef.parent, operationIndex, source.id, index);
    // Reject source inside COMPONENT / COMPONENT_SET (hasInstanceAncestor covers INSTANCE).
    {
      let walk: InternalNode | null = sourceRef.parent;
      while (walk) {
        if (walk.type === "COMPONENT" || walk.type === "COMPONENT_SET" || walk.type === "INSTANCE") {
          throw new Error(`patch.operations[${operationIndex}]: cannot componentize a node inside a ${walk.type}.`);
        }
        walk = index.get(walk.id)?.parent ?? null;
      }
    }
    if (subtreeContainsType(source, new Set(["COMPONENT", "COMPONENT_SET"]))) {
      throw new Error(`patch.operations[${operationIndex}]: cannot componentize a subtree that contains a COMPONENT or COMPONENT_SET.`);
    }
    if (subtreeHasPropertyReferences(source)) {
      throw new Error(`patch.operations[${operationIndex}]: source already has componentPropertyReferences.`);
    }
    // Rotation on source or ancestors
    {
      const ancestors: InternalNode[] = [];
      let walk: InternalNode | null = sourceRef.parent;
      while (walk) { ancestors.push(walk); walk = index.get(walk.id)?.parent ?? null; if (ancestors.length > 1000) break; }
      if (hasNonZeroRotation(source, ancestors)) {
        throw new Error(`patch.operations[${operationIndex}]: componentize does not support rotated nodes or parents (node '${source.id}' or an ancestor has non-zero rotation).`);
      }
    }

    const propsDecl: ComponentizeProperties = operation.componentizeProperties || {};
    const instanceIds = operation.componentizeInstances || [];

    // Validate properties
    const usedLayers = new Map<string, string>(); // layerId+field → prop name
    for (const [name, decl] of Object.entries(propsDecl)) {
      const layer = findDescendant(source, decl.layer);
      if (!layer || layer.id === source.id) {
        throw new Error(`patch.operations[${operationIndex}]: property '${name}' layer '${decl.layer}' must be a descendant of '${source.id}'.`);
      }
      if (decl.type === "TEXT" && layer.type !== "TEXT") {
        throw new Error(`patch.operations[${operationIndex}]: property '${name}' is TEXT but layer '${decl.layer}' is ${layer.type}.`);
      }
      if (decl.type === "INSTANCE_SWAP" && layer.type !== "INSTANCE") {
        throw new Error(`patch.operations[${operationIndex}]: property '${name}' is INSTANCE_SWAP but layer '${decl.layer}' is ${layer.type}.`);
      }
      const field = decl.type === "TEXT" ? "characters" : decl.type === "BOOLEAN" ? "visible" : "mainComponent";
      const key = `${decl.layer}::${field}`;
      if (usedLayers.has(key)) {
        throw new Error(`patch.operations[${operationIndex}]: properties '${usedLayers.get(key)}' and '${name}' both bind ${field} on layer '${decl.layer}'.`);
      }
      usedLayers.set(key, name);
    }

    // Validate instances
    const instanceSet = new Set(instanceIds);
    if (instanceSet.size !== instanceIds.length) {
      throw new Error(`patch.operations[${operationIndex}]: instances must not contain duplicates.`);
    }
    for (const instId of instanceIds) {
      if (instId === source.id) throw new Error(`patch.operations[${operationIndex}]: instance '${instId}' must not be the source.`);
      const instRef = index.get(instId);
      if (!instRef) throw new Error(`patch.operations[${operationIndex}]: instance '${instId}' was not found.`);
      if (instRef.node.type !== "FRAME") {
        throw new Error(`patch.operations[${operationIndex}]: instance '${instId}' must be a FRAME (received ${instRef.node.type}).`);
      }
      if (instRef.parent) assertNotInsideInstance(instRef.parent, operationIndex, instId, index);
      if (isDescendantOf(source, instRef.node) || isDescendantOf(instRef.node, source)) {
        throw new Error(`patch.operations[${operationIndex}]: instance '${instId}' must not be an ancestor or descendant of the source.`);
      }
      for (const otherId of instanceIds) {
        if (otherId === instId) continue;
        const other = index.get(otherId);
        if (other && (isDescendantOf(instRef.node, other.node) || isDescendantOf(other.node, instRef.node))) {
          throw new Error(`patch.operations[${operationIndex}]: instances '${instId}' and '${otherId}' must not be ancestors/descendants of each other.`);
        }
      }
      // Rotation on instance
      {
        const ancestors: InternalNode[] = [];
        let walk: InternalNode | null = instRef.parent;
        while (walk) { ancestors.push(walk); walk = index.get(walk.id)?.parent ?? null; if (ancestors.length > 1000) break; }
        if (hasNonZeroRotation(instRef.node, ancestors)) {
          throw new Error(`patch.operations[${operationIndex}]: componentize does not support rotated nodes or parents (node '${instId}' or an ancestor has non-zero rotation).`);
        }
      }
      // Strict diff (includes size / bindings / styleRefs / effects / prototype)
      const diff = structuralDiff(source, instRef.node, { properties: propsDecl });
      if (diff) {
        throw new Error(`patch.operations[${operationIndex}]: componentize '${source.id}': instance '${instId}' differs at ${diff}; declare a property or edit first`);
      }
    }

    // Eager: outside references to copy inner ids (root survives)
    for (const instId of instanceIds) {
      const instRef = index.get(instId)!;
      const innerIds = collectIds(instRef.node);
      innerIds.delete(instId); // root keeps its id
      for (const [id, ref] of index) {
        if (innerIds.has(id) || id === instId) continue;
        // Skip nodes inside this copy
        if (collectIds(instRef.node).has(id)) continue;
        const proto = ref.node.properties.prototype;
        if (Array.isArray(proto)) {
          forEachPrototypeDestination(proto, (_a, _t, destination, actionPath) => {
            if (innerIds.has(destination)) {
              throw new Error(`patch.operations[${operationIndex}]: cannot componentize while ${actionPath} targets inner layer '${destination}' of instance '${instId}' (inner ids disappear)`);
            }
          });
        }
        // INSTANCE_SWAP defaults / instanceProperties pointing at COMPONENT inside the copy
        const def = ref.node.properties.componentProperties;
        if (Array.isArray(def)) {
          for (const prop of def) {
            if (prop.type === "INSTANCE_SWAP" && typeof prop.defaultValue === "string" && innerIds.has(prop.defaultValue)) {
              throw new Error(`patch.operations[${operationIndex}]: cannot componentize while componentProperties on '${id}' reference inner layer '${prop.defaultValue}' of instance '${instId}'`);
            }
          }
        }
        const ip = ref.node.properties.instanceProperties;
        if (ip) {
          for (const [k, v] of Object.entries(ip)) {
            if (typeof v === "string" && innerIds.has(v)) {
              throw new Error(`patch.operations[${operationIndex}]: cannot componentize while instanceProperties.${k} on '${id}' references inner layer '${v}' of instance '${instId}'`);
            }
          }
        }
      }
    }

    // Promote source FRAME → COMPONENT
    source.type = "COMPONENT";
    const componentProperties: NonNullable<InternalNode["properties"]["componentProperties"]> = [];
    for (const [name, decl] of Object.entries(propsDecl)) {
      const layer = findDescendant(source, decl.layer)!;
      const defaultValue = readPropertyValue(layer, decl.type);
      if (defaultValue === undefined) {
        throw new Error(`patch.operations[${operationIndex}]: property '${name}' could not read a default from layer '${decl.layer}'.`);
      }
      componentProperties.push({ name, type: decl.type, defaultValue });
      // Wire componentPropertyReferences on the layer
      const refs = { ...(layer.properties.componentPropertyReferences || {}) };
      if (decl.type === "TEXT") refs.characters = name;
      else if (decl.type === "BOOLEAN") refs.visible = name;
      else refs.mainComponent = name;
      layer.properties.componentPropertyReferences = refs;
      affectedIds.push(layer.id);
    }
    if (componentProperties.length) source.properties.componentProperties = componentProperties;
    index.set(source.id, { node: source, parent: sourceRef.parent, siblings: sourceRef.siblings });
    visit(source.children, source);
    affectedIds.push(source.id);

    // Replace copies with INSTANCE shells
    for (const instId of instanceIds) {
      const instRef = index.get(instId)!;
      const copy = instRef.node;
      // Build instanceProperties only where values differ from defaults
      const overrides: Record<string, string | boolean> = {};
      for (const [name, decl] of Object.entries(propsDecl)) {
        const copyLayer = matchLayer(source, copy, decl.layer);
        if (!copyLayer) {
          throw new Error(`patch.operations[${operationIndex}]: instance '${instId}' has no layer matching '${decl.layer}'.`);
        }
        const copyValue = readPropertyValue(copyLayer, decl.type);
        const defaultValue = readPropertyValue(findDescendant(source, decl.layer)!, decl.type);
        if (copyValue !== undefined && defaultValue !== undefined && copyValue !== defaultValue) {
          overrides[name] = copyValue;
        }
      }
      const shell = frameToInstanceShell(copy, source.id, Object.keys(overrides).length ? overrides : undefined);
      const at = instRef.siblings.indexOf(copy);
      // Remove copy subtree from index
      const removeAll = (node: InternalNode): void => { index.delete(node.id); node.children.forEach(removeAll); };
      removeAll(copy);
      instRef.siblings.splice(at, 1, shell);
      index.set(shell.id, { node: shell, parent: instRef.parent, siblings: instRef.siblings });
      if (instRef.parent) instRef.parent.children = instRef.siblings;
      affectedIds.push(shell.id);
    }
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
  if (values.prototype !== undefined) {
    const protoErrors = assertPrototypePatchRules(
      values.prototype,
      {
        has: (id) => index.has(id),
        typeOf: (id) => index.get(id)?.node.type,
        canvasOf: (id) => canvasRootId(roots, id),
        isTopLevel: (id) => isTopLevelNodeId(roots, id)
      },
      `patch.operations[${operationIndex}].set.prototype`,
      target.node.id,
      isTopLevelNodeId(roots, target.node.id)
    );
    if (protoErrors.length) {
      throw new PatchError(protoErrors.map((message) => {
        const split = message.indexOf(": ");
        return patchIssue("PATCH_OPERATION", split > 0 ? message.slice(0, split) : `patch.operations[${operationIndex}].set.prototype`, split > 0 ? message.slice(split + 2) : message, "Use a top-level frame destination; AFTER_TIMEOUT only on a top-level node.");
      }));
    }
  }
  mergeSet(target, values, set, warnings);
  const defErrors: string[] = [];
  if (values.componentProperties !== undefined) {
    defErrors.push(...applyComponentPropertiesPatch(target.node.properties, values.componentProperties, `patch.operations[${operationIndex}].set`));
  }
  if (values.variant !== undefined) {
    defErrors.push(...applyVariantPatchOnComponent(target.node, target.parent, values.variant, `patch.operations[${operationIndex}].set`));
  }
  if (values.variantAxes !== undefined) {
    if (target.node.type !== "COMPONENT_SET") {
      defErrors.push(`patch.operations[${operationIndex}].set.variantAxes: only applies to COMPONENT_SET`);
    } else if (values.variantAxes === null) {
      defErrors.push(`patch.operations[${operationIndex}].set.variantAxes: clearing all axes is not supported (Figma cannot delete VARIANT properties)`);
    } else {
      const current = target.node.properties.variantAxes || {};
      const detected = detectVariantRenames(current, values.variantAxes as VariantAxesPatch);
      const axisErrors = [
        ...detected.errors,
        ...(!detected.errors.length
          ? variantAxesChildConflicts(target.node, current, detected.axes, detected.optionRenames, detected.axisRenames)
          : [])
      ].map((message) => `patch.operations[${operationIndex}].set.${message}`);
      defErrors.push(...axisErrors);
      if (!axisErrors.length) {
        target.node.properties.variantAxes = detected.axes;
        applyVariantRenamesInForest(roots, target.node.id, detected.axisRenames, detected.optionRenames, detected.axes);
        rewriteVariantChildNames(target.node);
        // Uncarried options are checked in validateDocument so a later op in the same
        // patch can set a child's variant to carry a newly declared option.
      }
    }
  }
  if (defErrors.length) {
    throw new PatchError(defErrors.map((message) => {
      const split = message.indexOf(": ");
      return patchIssue("PATCH_SET_INVALID", split > 0 ? message.slice(0, split) : `patch.operations[${operationIndex}].set`, split > 0 ? message.slice(split + 2) : message, "See component/variant patch rules in DESIGN-LANGUAGE.md.");
    }));
  }
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
  const warnings: string[] = [];
  const duplicateMaps: Array<Map<string, string>> = [];
  // Upsert variables/styles before operations so later set/insert/duplicate can bind.
  if ((patch.variables && patch.variables.length) || (patch.styles && patch.styles.length)) {
    const upserted = applyResourceUpsert(
      { styles: result.styles, variables: result.variables },
      { styles: patch.styles, variables: patch.variables }
    );
    if (upserted.issues.length) throw new PatchError(upserted.issues);
    result.styles = upserted.styles;
    result.variables = upserted.variables;
    for (const key of upserted.affectedKeys) affectedIds.push(key);
  }
  const index = new Map<string, NodeRef>();
  const visit = (nodes: InternalNode[], parent: InternalNode | null): void => nodes.forEach((node) => { index.set(node.id, { node, parent, siblings: nodes }); visit(node.children, node); });
  visit(result.nodes, null);
  for (const [operationIndex, operation] of patch.patch.operations.entries()) {
    try {
      applyOperation(operation, operationIndex, index, visit, affectedIds, warnings, result.nodes, duplicateMaps);
    } catch (error) {
      if (error instanceof PatchError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const split = message.indexOf(": ");
      throw new PatchError([patchIssue("PATCH_OPERATION", split > 0 ? message.slice(0, split) : `patch.operations[${operationIndex}]`, split > 0 ? message.slice(split + 2) : message, "Target nodes that exist and containers that can accept children.")]);
    }
  }
  const introduced = newDocumentIssues(document, result, duplicateMaps);
  // Strict set.prototype rules (top-level NAVIGATE dest, AFTER_TIMEOUT host) — exempt
  // pre-existing (and duplicate copies of them via duplicateMaps), keyed like newDocumentIssues.
  const strictKeyed = (doc: InternalDocument) => {
    const owners = documentIssueOwners(doc);
    return prototypePatchStrictErrors(doc).map((message) => {
      const split = message.indexOf(": ");
      const path = split > 0 ? message.slice(0, split) : "$";
      const body = split > 0 ? message.slice(split + 2) : message;
      const owner = owners(path);
      return { path, body, key: `STRICT|${owner.owner}|${owner.rest}|${body}` };
    });
  };
  const strictExisting = new Map<string, number>();
  const beforeStrict = strictKeyed(document);
  for (const { key } of beforeStrict) strictExisting.set(key, (strictExisting.get(key) || 0) + 1);
  for (const idMap of duplicateMaps) {
    for (const { key } of beforeStrict) {
      const remapped = remapIssueKeyThroughDuplicate(key, idMap);
      if (remapped) strictExisting.set(remapped, (strictExisting.get(remapped) || 0) + 1);
    }
  }
  for (const { path, body, key } of strictKeyed(result)) {
    const count = strictExisting.get(key) || 0;
    if (count > 0) { strictExisting.set(key, count - 1); continue; }
    introduced.push(patchIssue("PATCH_RESULT_INVALID", path, `after patch: ${body}`, "NAVIGATE/SWAP/OVERLAY destinations must be top-level frames; AFTER_TIMEOUT only on top-level nodes."));
  }
  if (introduced.length) throw new PatchError(introduced);
  return { document: result, affectedIds, warnings };
}

/**
 * Issues present in `after` but not in `before`. Issues already in the input
 * document never block a patch, even on nodes the patch touches; only issues
 * the patch introduces (directly or through a move/insert/remove) are
 * reported. Identity is code + owner (node id / variable / document) + the
 * property path inside the owner + message, never an array index, and the
 * comparison is a multiset so a second copy of an existing issue counts as new.
 */
export function newDocumentIssues(before: InternalDocument, after: InternalDocument, duplicateMaps: Array<Map<string, string>> = []): RepairIssue[] {
  const keyed = (document: InternalDocument) => {
    const owners = documentIssueOwners(document);
    return validationIssues(validateDocument(document, Infinity)).map((issue) => {
      const owner = owners(issue.path);
      return { issue, owner, key: `${issue.code}|${owner.owner}|${owner.rest}|${issue.message}` };
    });
  };
  const existing = new Map<string, number>();
  const beforeKeyed = keyed(before);
  for (const { key } of beforeKeyed) existing.set(key, (existing.get(key) || 0) + 1);
  // Exempt issues on duplicate copies that the source already had (map owner/path/message ids).
  for (const idMap of duplicateMaps) {
    for (const { key } of beforeKeyed) {
      const remapped = remapIssueKeyThroughDuplicate(key, idMap);
      if (remapped) existing.set(remapped, (existing.get(remapped) || 0) + 1);
    }
  }
  const introduced: RepairIssue[] = [];
  for (const { issue, owner, key } of keyed(after)) {
    const count = existing.get(key) || 0;
    if (count > 0) { existing.set(key, count - 1); continue; }
    const where = owner.nodeId !== undefined ? ` (node '${owner.nodeId}')` : "";
    introduced.push({ ...issue, code: "PATCH_RESULT_INVALID", message: `after patch${where}: ${issue.message}`, suggestion: "This issue is introduced by the patch; issues already in the input document are not reported." });
  }
  return introduced;
}
