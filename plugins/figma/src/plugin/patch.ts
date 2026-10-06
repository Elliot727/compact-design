import type { InternalPatchDocument, PatchOperation } from "@compact-design/core";
import { applyAutoLayout, applyChildLayout, applyGeometry, applyGrids } from "./layout";
import { createNode, type ImportContext } from "./nodes";
import { applyAppearance, clearEffectWarnings, effectWarnings } from "./paints";
import { applyText } from "./text";

const CONTAINER_TYPES = new Set(["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "SECTION", "BOOLEAN_OPERATION"]);

function indexNodes(): Map<string, SceneNode> {
  const result = new Map<string, SceneNode>();
  for (const node of figma.currentPage.findAll()) { const id = node.getPluginData("compactDesignId"); if (id) result.set(id, node); }
  return result;
}

function appearanceChanged(set: Record<string, unknown>): boolean {
  return ["fill", "fills", "stroke", "strokes", "effects", "shadow", "elevation", "cornerRadius", "cornerRadii", "opacity", "blendMode", "visible", "locked", "isMask", "clipsContent", "strokeWeight", "dashPattern"].some((key) => key in set);
}

async function applySet(node: SceneNode, operation: PatchOperation): Promise<void> {
  const set = operation.set || {}; const props = operation.normalized;
  if (!props) throw new Error("SET operation was not normalized");
  if (typeof set.name === "string") node.name = set.name;
  const geometry = ["x", "y", "w", "h", "rotation"].some((key) => key in set);
  if (geometry) applyGeometry(node, { ...props, position: { x: typeof set.x === "number" ? set.x : node.x, y: typeof set.y === "number" ? set.y : node.y }, size: { width: typeof set.w === "number" ? set.w : node.width, height: typeof set.h === "number" ? set.h : node.height }, rotation: typeof set.rotation === "number" ? set.rotation : ("rotation" in node ? node.rotation : 0) }, { x: 0, y: 0 });
  if (appearanceChanged(set)) {
    const styles = props.styles || {};
    const merged = { ...props, styles: {
      fills: ("fill" in set || "fills" in set) ? styles.fills : ("fills" in node && node.fills !== figma.mixed ? [...node.fills] : []),
      strokes: ("stroke" in set || "strokes" in set) ? styles.strokes : ("strokes" in node ? [...node.strokes] : []),
      effects: ("effects" in set || "shadow" in set || "elevation" in set) ? styles.effects : ("effects" in node ? [...node.effects] : [])
    } };
    await applyAppearance(node, merged as unknown as typeof props, node.type === "TEXT");
  }
  if (node.type === "TEXT" && ["text", "font", "lineHeight", "letterSpacing", "align", "runs", "textDecoration", "paragraphSpacing"].some((key) => key in set)) {
    const currentFont = node.fontName === figma.mixed ? { family: "Arial", style: "Regular", size: typeof node.fontSize === "number" ? node.fontSize : 16 } : { ...node.fontName, size: typeof node.fontSize === "number" ? node.fontSize : 16 };
    await applyText(node, {
      text: typeof set.text === "string" ? set.text : node.characters,
      font: set.font ? props.font : currentFont,
      lineHeight: set.lineHeight ? props.lineHeight : (node.lineHeight === figma.mixed ? { unit: "AUTO" } : node.lineHeight),
      alignment: typeof set.align === "string" ? set.align : node.textAlignHorizontal,
      letterSpacing: set.letterSpacing ? props.letterSpacing : (node.letterSpacing === figma.mixed ? undefined : node.letterSpacing),
      textDecoration: typeof set.textDecoration === "string" ? set.textDecoration as TextDecoration : (node.textDecoration === figma.mixed ? undefined : node.textDecoration),
      paragraphSpacing: typeof set.paragraphSpacing === "number" ? set.paragraphSpacing : (typeof node.paragraphSpacing === "number" ? node.paragraphSpacing : 0),
      textAutoResize: node.textAutoResize,
      runs: set.runs ? props.runs : []
    });
  }
  if ((node.type === "FRAME" || node.type === "COMPONENT") && set.layout) applyAutoLayout(node, props.layout);
  if (set.constraints || set.layoutSizingHorizontal || set.layoutSizingVertical || set.layoutAlign || set.layoutGrow !== undefined) applyChildLayout(node, props);
  if (set.layoutGrids) applyGrids(node, props.layoutGrids || []);
}

function isInsideInstance(node: BaseNode | null): boolean {
  let current: BaseNode | null = node;
  while (current) {
    if (current.type === "INSTANCE") return true;
    current = current.parent;
  }
  return false;
}

function assertStructuralParent(parent: SceneNode, operationIndex: number, parentId: string): asserts parent is SceneNode & ChildrenMixin {
  if (isInsideInstance(parent)) {
    throw new Error(`patch.operations[${operationIndex}]: parent '${parentId}' is an INSTANCE (or inside one) and cannot accept structural edits`);
  }
  if (!CONTAINER_TYPES.has(parent.type) || !("insertChild" in parent)) {
    throw new Error(`patch.operations[${operationIndex}]: parent '${parentId}' was not found or cannot contain children`);
  }
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, length));
}

function isDescendantSceneNode(ancestor: SceneNode, candidate: BaseNode | null): boolean {
  let current: BaseNode | null = candidate;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

/** Resolve only via the compact-design plugin-data index (imported/mapped layers). */
function resolveNode(nodes: Map<string, SceneNode>, compactId: string): SceneNode | null {
  return nodes.get(compactId) || null;
}

type MoveUndo = { node: SceneNode; parent: SceneNode & ChildrenMixin; index: number };

function preflight(document: InternalPatchDocument, nodes: Map<string, SceneNode>): void {
  for (const [index, operation] of document.patch.operations.entries()) {
    if (operation.op === "SET" || operation.op === "REMOVE" || operation.op === "MOVE") {
      if (!resolveNode(nodes, operation.id!)) {
        throw new Error(`patch.operations[${index}]: node '${operation.id}' was not found`);
      }
    }
    if (operation.op === "APPEND" || operation.op === "INSERT" || operation.op === "MOVE") {
      const parent = resolveNode(nodes, operation.parent!);
      if (!parent) throw new Error(`patch.operations[${index}]: parent '${operation.parent}' was not found or cannot contain children`);
      assertStructuralParent(parent, index, operation.parent!);
      if ((operation.op === "APPEND" || operation.op === "INSERT") && operation.node && nodes.has(operation.node.id)) {
        throw new Error(`patch.operations[${index}]: appended ID '${operation.node.id}' already exists`);
      }
    }
    if (operation.op === "MOVE") {
      const node = resolveNode(nodes, operation.id!)!;
      const parent = resolveNode(nodes, operation.parent!)!;
      if (!node.parent || node.parent.type === "PAGE") {
        throw new Error(`patch.operations[${index}]: cannot move the document root`);
      }
      if (isInsideInstance(node.parent)) {
        throw new Error(`patch.operations[${index}]: node '${operation.id}' is inside an INSTANCE and cannot be moved`);
      }
      if (parent === node || isDescendantSceneNode(node, parent)) {
        throw new Error(`patch.operations[${index}]: cannot move a node under itself or its descendants`);
      }
    }
  }
}

export async function applyPatch(document: InternalPatchDocument, context: ImportContext): Promise<{ affected: SceneNode[]; warnings: string[] }> {
  clearEffectWarnings();
  const nodes = indexNodes();
  preflight(document, nodes);

  const affected: SceneNode[] = [];
  const backups: Array<{ original: SceneNode; backup: SceneNode }> = [];
  const created: SceneNode[] = [];
  const moveUndos: MoveUndo[] = [];

  try {
    for (const [operationIndex, operation] of document.patch.operations.entries()) {
      if (operation.op === "SET" || operation.op === "REMOVE") {
        const original = resolveNode(nodes, operation.id!)!;
        const parent = original.parent;
        if (!parent || !("insertChild" in parent)) throw new Error(`Cannot safely patch '${operation.id}'`);
        const index = parent.children.indexOf(original);
        const backup = original.clone();
        parent.insertChild(index, backup);
        backups.push({ original, backup });
        if (operation.op === "SET") { await applySet(original, operation); affected.push(original); }
        else { original.remove(); nodes.delete(operation.id!); }
      }
      if (operation.op === "APPEND" || operation.op === "INSERT") {
        const parent = resolveNode(nodes, operation.parent!)! as SceneNode & ChildrenMixin;
        assertStructuralParent(parent, operationIndex, operation.parent!);
        if (operation.op === "APPEND") {
          const node = await createNode(operation.node!, parent, { x: 0, y: 0 }, context);
          nodes.set(operation.node!.id, node);
          created.push(node);
          affected.push(node);
        } else {
          const beforeLength = parent.children.length;
          const at = clampIndex(operation.index ?? 0, beforeLength);
          const node = await createNode(operation.node!, parent, { x: 0, y: 0 }, context);
          // createNode appends; re-seat with insertChild so the final index matches core.
          parent.insertChild(at, node);
          nodes.set(operation.node!.id, node);
          created.push(node);
          affected.push(node);
        }
      }
      if (operation.op === "MOVE") {
        const node = resolveNode(nodes, operation.id!)!;
        const parent = resolveNode(nodes, operation.parent!)! as SceneNode & ChildrenMixin;
        assertStructuralParent(parent, operationIndex, operation.parent!);
        if (!node.parent || node.parent.type === "PAGE") {
          throw new Error(`patch.operations[${operationIndex}]: cannot move the document root`);
        }
        if (isInsideInstance(node.parent)) {
          throw new Error(`patch.operations[${operationIndex}]: node '${operation.id}' is inside an INSTANCE and cannot be moved`);
        }
        if (parent === node || isDescendantSceneNode(node, parent)) {
          throw new Error(`patch.operations[${operationIndex}]: cannot move a node under itself or its descendants`);
        }
        const previousParent = node.parent as SceneNode & ChildrenMixin;
        const previousIndex = previousParent.children.indexOf(node);
        moveUndos.push({ node, parent: previousParent, index: previousIndex });
        // Same-parent moves: Figma's insertChild removes first, then inserts at the
        // after-removal index — matching core's final-position semantics.
        const maxIndex = node.parent === parent ? parent.children.length - 1 : parent.children.length;
        const at = clampIndex(operation.index ?? 0, maxIndex);
        parent.insertChild(at, node);
        affected.push(node);
      }
    }
    for (const { backup } of backups) if (!backup.removed) backup.remove();
  } catch (error) {
    // Roll back in reverse: restore moves, remove inserts/appends, then SET/REMOVE via backups.
    for (let i = moveUndos.length - 1; i >= 0; i--) {
      const undo = moveUndos[i];
      if (!undo.node.removed && "insertChild" in undo.parent) {
        const at = Math.max(0, Math.min(undo.index, undo.parent.children.length));
        undo.parent.insertChild(at, undo.node);
      }
    }
    for (let i = created.length - 1; i >= 0; i--) {
      const node = created[i];
      if (!node.removed) node.remove();
    }
    for (const { original, backup } of backups) { if (!original.removed) original.remove(); }
    throw error;
  }
  return { affected, warnings: [...effectWarnings] };
}
