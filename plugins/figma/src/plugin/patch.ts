import type { InternalPatchDocument, PatchOperation } from "@compact-design/core";
import { applyAutoLayout, applyChildLayout, applyGeometry, applyGrids } from "./layout";
import { createNode, type ImportContext } from "./nodes";
import { applyAppearance } from "./paints";
import { applyText } from "./text";

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

export async function applyPatch(document: InternalPatchDocument, context: ImportContext): Promise<{ affected: SceneNode[]; warnings: string[] }> {
  const nodes = indexNodes();
  for (const [index, operation] of document.patch.operations.entries()) {
    if ((operation.op === "SET" || operation.op === "REMOVE") && !nodes.has(operation.id!)) throw new Error(`patch.operations[${index}]: node '${operation.id}' was not found`);
    if (operation.op === "APPEND") {
      const parent = nodes.get(operation.parent!);
      if (!parent || !("appendChild" in parent)) throw new Error(`patch.operations[${index}]: parent '${operation.parent}' was not found or cannot contain children`);
      if (operation.node && nodes.has(operation.node.id)) throw new Error(`patch.operations[${index}]: appended ID '${operation.node.id}' already exists`);
    }
  }
  const affected: SceneNode[] = []; const backups: Array<{ original: SceneNode; backup: SceneNode }> = [];
  try {
    for (const operation of document.patch.operations) {
      if (operation.op === "SET" || operation.op === "REMOVE") {
        const original = nodes.get(operation.id!)!; const parent = original.parent;
        if (!parent || !("insertChild" in parent)) throw new Error(`Cannot safely patch '${operation.id}'`);
        const index = parent.children.indexOf(original); const backup = original.clone(); parent.insertChild(index, backup); backups.push({ original, backup });
        if (operation.op === "SET") { await applySet(original, operation); affected.push(original); }
        else { original.remove(); nodes.delete(operation.id!); }
      }
      if (operation.op === "APPEND") {
        const parent = nodes.get(operation.parent!)! as SceneNode & ChildrenMixin;
        const node = await createNode(operation.node!, parent, { x: 0, y: 0 }, context); nodes.set(operation.node!.id, node); affected.push(node);
      }
    }
    for (const { backup } of backups) if (!backup.removed) backup.remove();
  } catch (error) {
    for (const { original, backup } of backups) { if (!original.removed) original.remove(); }
    throw error;
  }
  return { affected, warnings: [] };
}
