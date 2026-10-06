import { patchSetBindingFields, patchSetTargetIssues, type InternalPatchDocument, type JsonObject, type PatchOperation, type PatchSetKey, type PatchSetValues, type PatchTargetContext } from "@compact-design/core";
import { applyGrids, applyLayoutPatch } from "./layout";
import { componentPropertyMaps, createNode, mapComponentPropertyReferences, mapInstancePropertyOverrides, type ImportContext } from "./nodes";
import { applyEffects, clearEffectWarnings, effectsFromData, effectWarnings, paints, paintFromData } from "./paints";
import { applyResourcePatch } from "./resources";
import { clamp, finite } from "./value";

const CONTAINER_TYPES = new Set(["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "SECTION", "BOOLEAN_OPERATION"]);
const GROUP_TYPES = new Set(["GROUP", "BOOLEAN_OPERATION"]);

function indexNodes(): Map<string, SceneNode> {
  const result = new Map<string, SceneNode>();
  for (const node of figma.currentPage.findAll()) { const id = node.getPluginData("compactDesignId"); if (id) result.set(id, node); }
  return result;
}

function sceneParent(node: SceneNode): SceneNode | null {
  const parent = node.parent;
  return parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT" ? parent as SceneNode : null;
}

/**
 * Figma's view of a patch target, mirroring core's corePatchContext so both
 * engines run patchSetTargetIssues on equivalent state. Figma types equal the
 * compact types except SVG (imported as FRAME) and ARC (an ELLIPSE with arcData).
 */
export function figmaPatchContext(node: SceneNode): PatchTargetContext {
  const parent = sceneParent(node);
  const mixed = figma.mixed;
  let mixedText = false; let mixedFontName = false; let textStyle = false;
  if (node.type === "TEXT") {
    mixedFontName = node.fontName === mixed;
    mixedText = [node.fontName, node.fontSize, node.fills, node.letterSpacing, node.textDecoration, node.hyperlink].some((value) => value === mixed);
    textStyle = node.textStyleId === mixed || (typeof node.textStyleId === "string" && node.textStyleId !== "");
  }
  const bound = "boundVariables" in node && node.boundVariables ? Object.keys(node.boundVariables) : [];
  return {
    type: node.type,
    parentType: parent ? parent.type : null,
    parentAutoLayout: Boolean(parent && "layoutMode" in parent && parent.layoutMode !== "NONE"),
    autoLayout: "layoutMode" in node && node.layoutMode !== "NONE",
    layoutPositioning: "layoutPositioning" in node ? node.layoutPositioning : undefined,
    mixedText,
    mixedFontName,
    textStyle,
    boundFields: bound,
    childCount: "children" in node ? node.children.length : 0
  };
}

async function loadFontStrict(font: FontName): Promise<FontName> {
  try { await figma.loadFontAsync(font); return font; }
  catch (error) { throw new Error(`font '${font.family} ${font.style}' is not available in Figma (${error instanceof Error ? error.message : String(error)})`); }
}

function writable(node: SceneNode, key: PatchSetKey, property: string): Record<string, unknown> {
  if (!(property in node)) throw new Error(`'${key}' is not supported on Figma ${node.type} node '${node.name}'`);
  return node as unknown as Record<string, unknown>;
}

function assign(node: SceneNode, key: PatchSetKey, property: string, value: unknown): void {
  writable(node, key, property)[property] = value;
}

async function applyTextSet(node: TextNode, values: PatchSetValues): Promise<void> {
  const length = node.characters.length;
  const current = node.fontName === figma.mixed ? node.getRangeAllFontNames(0, length) : [node.fontName];
  for (const font of current) await loadFontStrict(font);
  const uniform = node.fontName === figma.mixed ? null : node.fontName;
  const partial = values.font || {};
  let base: FontName | null = null;
  if (partial.family !== undefined || partial.style !== undefined) {
    if (!uniform && (partial.family === undefined || partial.style === undefined)) throw new Error(`'${node.name}' mixes fonts across ranges; set font.family and font.style together`);
    base = await loadFontStrict({ family: partial.family ?? uniform!.family, style: partial.style ?? uniform!.style });
  }
  if (values.runs !== undefined || values.text !== undefined) {
    node.characters = values.text !== undefined ? values.text : (values.runs || []).map((run) => typeof run.text === "string" ? run.text : "").join("");
  }
  if (base) node.fontName = base;
  if (partial.size !== undefined) node.fontSize = partial.size;
  if (values.lineHeight) node.lineHeight = values.lineHeight.unit === "AUTO" ? { unit: "AUTO" } : { unit: values.lineHeight.unit, value: finite(values.lineHeight.value, 100) };
  if (values.alignment !== undefined) node.textAlignHorizontal = values.alignment as TextNode["textAlignHorizontal"];
  if (values.verticalAlignment !== undefined) node.textAlignVertical = values.verticalAlignment;
  if (values.letterSpacing !== undefined) node.letterSpacing = values.letterSpacing;
  if (values.textDecoration !== undefined) node.textDecoration = values.textDecoration;
  if (values.textCase !== undefined) node.textCase = values.textCase;
  if (values.paragraphSpacing !== undefined) node.paragraphSpacing = values.paragraphSpacing;
  if (values.paragraphIndent !== undefined) node.paragraphIndent = values.paragraphIndent;
  if (values.listSpacing !== undefined) node.listSpacing = values.listSpacing;
  if (values.hangingPunctuation !== undefined) node.hangingPunctuation = values.hangingPunctuation;
  if (values.hangingList !== undefined) node.hangingList = values.hangingList;
  if (values.textAutoResize !== undefined) node.textAutoResize = values.textAutoResize;
  if (values.textTruncation !== undefined) node.textTruncation = values.textTruncation;
  if (values.maxLines !== undefined) node.maxLines = values.maxLines;
  if (values.runs !== undefined) {
    const nodeFont = node.fontName === figma.mixed ? null : node.fontName;
    let cursor = 0;
    for (const run of values.runs) {
      const start = typeof run.start === "number" && Number.isFinite(run.start) ? run.start : cursor;
      const end = typeof run.end === "number" && Number.isFinite(run.end) ? run.end : start + (typeof run.text === "string" ? run.text.length : 0);
      const runFont = run.font && typeof run.font === "object" && !Array.isArray(run.font) ? run.font as JsonObject : null;
      if (runFont && (runFont.family !== undefined || runFont.style !== undefined)) {
        const family = typeof runFont.family === "string" ? runFont.family : nodeFont?.family;
        const style = typeof runFont.style === "string" ? runFont.style : nodeFont?.style;
        if (!family || !style) throw new Error(`'${node.name}' run ${start}-${end}: font.family and font.style are required on mixed-font text`);
        node.setRangeFontName(start, end, await loadFontStrict({ family, style }));
      }
      if (runFont && typeof runFont.size === "number" && Number.isFinite(runFont.size)) node.setRangeFontSize(start, end, runFont.size);
      const fill = run.fill && typeof run.fill === "object" && !Array.isArray(run.fill) ? await paintFromData(run.fill as never) : null;
      if (fill) node.setRangeFills(start, end, [fill]);
      if (typeof run.textDecoration === "string") node.setRangeTextDecoration(start, end, run.textDecoration as TextDecoration);
      if (run.letterSpacing && typeof run.letterSpacing === "object") node.setRangeLetterSpacing(start, end, run.letterSpacing as LetterSpacing);
      if (typeof run.link === "string") node.setRangeHyperlink(start, end, { type: "URL", value: run.link });
      cursor = end;
    }
  }
}

type SetHandler = (node: SceneNode, values: PatchSetValues) => void | Promise<void>;
type SetPhase = "name" | "layout" | "child" | "geometry" | "appearance" | "text" | "shape" | "resources" | "component" | "rejected";
interface SetEntry { phase: SetPhase; apply?: SetHandler; }

const PHASE_ORDER: SetPhase[] = ["name", "layout", "child", "geometry", "appearance", "shape", "text", "resources", "component"];

const frameOnly = (key: PatchSetKey, node: SceneNode): FrameNode | ComponentNode => {
  if (node.type !== "FRAME" && node.type !== "COMPONENT") throw new Error(`'${key}' is not supported on Figma ${node.type} node '${node.name}'`);
  return node;
};
const rejected: SetEntry = { phase: "rejected" };
/** Warnings collected for the current SET apply (detach / clear). */
let setWarnings: string[] = [];
let setContext: ImportContext | null = null;

function nodeLabel(node: SceneNode): string {
  return node.getPluginData("compactDesignId") || node.name;
}

function hasFillBinding(node: SceneNode): boolean {
  if (!("fills" in node) || node.fills === figma.mixed || !Array.isArray(node.fills) || !node.fills.length) return false;
  const paint = node.fills[0] as Paint;
  return Boolean(paint && "boundVariables" in paint && paint.boundVariables);
}

function hasStrokeBinding(node: SceneNode): boolean {
  if (!("strokes" in node) || !Array.isArray(node.strokes) || !node.strokes.length) return false;
  const paint = node.strokes[0] as Paint;
  return Boolean(paint && "boundVariables" in paint && paint.boundVariables);
}

function hasStyleId(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

async function applyFillPaints(node: SceneNode, values: PatchSetValues): Promise<void> {
  const path = `node '${nodeLabel(node)}'`;
  if (hasFillBinding(node)) setWarnings.push(`${path}: detached bindings.fill because fill was set`);
  if ("fillStyleId" in node && hasStyleId(node.fillStyleId)) setWarnings.push(`${path}: detached styleRefs.fill because fill was set`);
  writable(node, "fill", "fills").fills = await paints(values.styles?.fills || []);
}

async function applyStrokePaints(node: SceneNode, values: PatchSetValues): Promise<void> {
  const path = `node '${nodeLabel(node)}'`;
  if (hasStrokeBinding(node)) setWarnings.push(`${path}: detached bindings.stroke because stroke was set`);
  if ("strokeStyleId" in node && hasStyleId(node.strokeStyleId)) setWarnings.push(`${path}: detached styleRefs.stroke because stroke was set`);
  writable(node, "stroke", "strokes").strokes = await paints(values.styles?.strokes || []);
}

function detachBoundScalars(node: SceneNode, set: JsonObject): void {
  const path = `node '${nodeLabel(node)}'`;
  const bound = ("boundVariables" in node && node.boundVariables) ? Object.keys(node.boundVariables as object) : [];
  const overwritten = patchSetBindingFields(set).filter((field) => bound.includes(field));
  for (const field of [...new Set(overwritten)]) {
    node.setBoundVariable(field as VariableBindableNodeField, null);
    setWarnings.push(`${path}: detached bindings.${field} because the set overwrites it`);
  }
}

async function applyBindingsStyleModes(node: SceneNode, values: PatchSetValues): Promise<void> {
  if (!setContext) throw new Error("patch context missing resources");
  await applyResourcePatch(node, {
    bindings: values.bindings,
    styleRefs: values.styleRefs,
    variableModes: values.variableModes
  }, setContext.resources, setWarnings);
}

async function applyInstancePropertiesSet(node: SceneNode, values: PatchSetValues): Promise<void> {
  if (node.type !== "INSTANCE") throw new Error(`'instanceProperties' is not supported on Figma ${node.type} node '${node.name}'`);
  if (!setContext) throw new Error("patch context missing");
  if (values.instanceProperties === undefined) return;
  const main = await node.getMainComponentAsync();
  if (!main) throw new Error(`INSTANCE '${node.name}' has no main component`);
  const { keys, types } = componentPropertyMaps(main);
  if (values.instanceProperties === null) {
    // Clear by setting defaults from definitions
    const defaults: Record<string, string | boolean | VariableAlias> = {};
    for (const [key, def] of Object.entries(main.componentPropertyDefinitions || {})) {
      defaults[key] = def.defaultValue as string | boolean | VariableAlias;
    }
    node.setProperties(defaults);
    return;
  }
  const overrides = mapInstancePropertyOverrides(values.instanceProperties as Record<string, string | boolean | VariableAlias | null>, keys, types, setContext);
  if (Object.keys(overrides).length) node.setProperties(overrides);
}

function owningComponent(node: SceneNode): ComponentNode | null {
  let current: BaseNode | null = node.parent;
  while (current) {
    if (current.type === "INSTANCE") return null;
    if (current.type === "COMPONENT") return current as ComponentNode;
    current = current.parent;
  }
  return null;
}

async function applyComponentPropertyReferencesSet(node: SceneNode, values: PatchSetValues): Promise<void> {
  if (values.componentPropertyReferences === undefined) return;
  if (values.componentPropertyReferences === null) {
    node.componentPropertyReferences = {};
    return;
  }
  const owner = owningComponent(node);
  if (!owner) throw new Error(`componentPropertyReferences must be on a descendant of a COMPONENT and must not cross a nested INSTANCE`);
  const { keys } = componentPropertyMaps(owner);
  // Merge with existing refs: start from current authored-mapped state on the node
  const current = node.componentPropertyReferences || {};
  const merged: { characters?: string | null; visible?: string | null; mainComponent?: string | null } = {
    characters: current.characters,
    visible: current.visible,
    mainComponent: current.mainComponent
  };
  for (const [field, value] of Object.entries(values.componentPropertyReferences)) {
    if (value === null) delete (merged as Record<string, unknown>)[field];
    else (merged as Record<string, unknown>)[field] = value;
  }
  const mapped = mapComponentPropertyReferences(merged, keys);
  // Clear fields that were nulled
  const result: { characters?: string; visible?: string; mainComponent?: string } = {};
  if (merged.characters != null) result.characters = mapped.characters;
  if (merged.visible != null) result.visible = mapped.visible;
  if (merged.mainComponent != null) result.mainComponent = mapped.mainComponent;
  node.componentPropertyReferences = result;
}

const scalar = (key: PatchSetKey, property: string, phase: SetPhase = "appearance", read: (values: PatchSetValues) => unknown = (values) => (values as Record<string, unknown>)[key]): SetEntry => ({ phase, apply: (node, values) => assign(node, key, property, read(values)) });

/**
 * One entry per PATCH_SET_KEYS key (enforced by the Record type): every key
 * either applies with core's merge semantics or is rejected by the shared
 * rules before any mutation. Nothing is silently ignored.
 */
export const FIGMA_SET_ENTRIES: Readonly<Record<PatchSetKey, SetEntry>> = {
  name: { phase: "name", apply: (node, values) => { node.name = values.name as string; } },
  x: { phase: "geometry" }, y: { phase: "geometry" }, w: { phase: "geometry" }, h: { phase: "geometry" },
  rotation: scalar("rotation", "rotation", "geometry"),
  fill: { phase: "appearance", apply: applyFillPaints },
  fills: { phase: "appearance", apply: applyFillPaints },
  stroke: { phase: "appearance", apply: applyStrokePaints },
  strokes: { phase: "appearance", apply: applyStrokePaints },
  strokeWeight: scalar("strokeWeight", "strokeWeight"),
  strokeTopWeight: scalar("strokeTopWeight", "strokeTopWeight"),
  strokeRightWeight: scalar("strokeRightWeight", "strokeRightWeight"),
  strokeBottomWeight: scalar("strokeBottomWeight", "strokeBottomWeight"),
  strokeLeftWeight: scalar("strokeLeftWeight", "strokeLeftWeight"),
  strokeAlign: scalar("strokeAlign", "strokeAlign"),
  strokeCap: scalar("strokeCap", "strokeCap"),
  strokeJoin: scalar("strokeJoin", "strokeJoin"),
  dashPattern: scalar("dashPattern", "dashPattern", "appearance", (values) => [...(values.dashPattern || [])]),
  cornerRadius: scalar("cornerRadius", "cornerRadius"),
  cornerRadii: { phase: "appearance", apply: (node, values) => {
    const target = writable(node, "cornerRadii", "topLeftRadius");
    [target.topLeftRadius, target.topRightRadius, target.bottomRightRadius, target.bottomLeftRadius] = values.cornerRadii || [];
  } },
  opacity: scalar("opacity", "opacity", "appearance", (values) => clamp(values.opacity, 0, 1)),
  blendMode: scalar("blendMode", "blendMode"),
  visible: scalar("visible", "visible"),
  locked: scalar("locked", "locked"),
  isMask: scalar("isMask", "isMask"),
  clipsContent: scalar("clipsContent", "clipsContent"),
  effects: { phase: "appearance", apply: async (node, values) => { writable(node, "effects", "effects"); applyEffects(node as SceneNode & BlendMixin, await effectsFromData(values.styles?.effects || [], node.name)); } },
  elevation: { phase: "appearance", apply: async (node, values) => { writable(node, "elevation", "effects"); applyEffects(node as SceneNode & BlendMixin, await effectsFromData(values.styles?.effects || [], node.name)); } },
  shadow: { phase: "appearance", apply: async (node, values) => { writable(node, "shadow", "effects"); applyEffects(node as SceneNode & BlendMixin, await effectsFromData(values.styles?.effects || [], node.name)); } },
  layout: { phase: "layout", apply: (node, values) => applyLayoutPatch(frameOnly("layout", node), values.layout || {}) },
  constraints: { phase: "child", apply: (node, values) => {
    const target = writable(node, "constraints", "constraints");
    target.constraints = { ...(target.constraints as Constraints), ...values.constraints };
  } },
  layoutSizingHorizontal: scalar("layoutSizingHorizontal", "layoutSizingHorizontal", "child"),
  layoutSizingVertical: scalar("layoutSizingVertical", "layoutSizingVertical", "child"),
  layoutAlign: scalar("layoutAlign", "layoutAlign", "child"),
  layoutGrow: scalar("layoutGrow", "layoutGrow", "child"),
  layoutPositioning: scalar("layoutPositioning", "layoutPositioning", "child"),
  minWidth: scalar("minWidth", "minWidth", "child"),
  maxWidth: scalar("maxWidth", "maxWidth", "child"),
  minHeight: scalar("minHeight", "minHeight", "child"),
  maxHeight: scalar("maxHeight", "maxHeight", "child"),
  layoutGrids: { phase: "layout", apply: (node, values) => { writable(node, "layoutGrids", "layoutGrids"); applyGrids(node, values.layoutGrids || []); } },
  text: { phase: "text" }, font: { phase: "text" }, lineHeight: { phase: "text" }, letterSpacing: { phase: "text" }, align: { phase: "text" },
  verticalAlignment: { phase: "text" }, textDecoration: { phase: "text" }, textCase: { phase: "text" }, paragraphSpacing: { phase: "text" },
  paragraphIndent: { phase: "text" }, listSpacing: { phase: "text" }, hangingPunctuation: { phase: "text" }, hangingList: { phase: "text" },
  textAutoResize: { phase: "text" }, textTruncation: { phase: "text" }, maxLines: { phase: "text" }, runs: { phase: "text" },
  pointCount: scalar("pointCount", "pointCount", "shape", (values) => Math.max(3, Math.round(finite(values.pointCount, 3)))),
  innerRadius: scalar("innerRadius", "innerRadius", "shape", (values) => clamp(values.innerRadius, 0, 1)),
  startingAngle: { phase: "shape", apply: (node, values) => { const target = writable(node, "startingAngle", "arcData"); target.arcData = { ...(target.arcData as ArcData), startingAngle: finite(values.startingAngle, 0) }; } },
  endingAngle: { phase: "shape", apply: (node, values) => { const target = writable(node, "endingAngle", "arcData"); target.arcData = { ...(target.arcData as ArcData), endingAngle: finite(values.endingAngle, Math.PI * 2) }; } },
  innerRadiusRatio: { phase: "shape", apply: (node, values) => { const target = writable(node, "innerRadiusRatio", "arcData"); target.arcData = { ...(target.arcData as ArcData), innerRadius: clamp(values.innerRadiusRatio, 0, 1) }; } },
  svg: rejected,
  vectorPaths: scalar("vectorPaths", "vectorPaths", "shape", (values) => (values.vectorPaths || []).map((path) => ({ ...path, data: String(path.data || "").replace(/,/g, " ").replace(/\s+/g, " ").trim() }))),
  componentId: rejected, componentProperties: rejected, instanceProperties: { phase: "component", apply: applyInstancePropertiesSet }, componentPropertyReferences: { phase: "component", apply: applyComponentPropertyReferencesSet }, variantAxes: rejected, variant: rejected,
  operation: scalar("operation", "booleanOperation", "shape"),
  prototype: rejected,
  overflowDirection: scalar("overflowDirection", "overflowDirection", "layout"),
  numberOfFixedChildren: scalar("numberOfFixedChildren", "numberOfFixedChildren", "layout"),
  styleRefs: { phase: "resources", apply: applyBindingsStyleModes }, bindings: { phase: "resources", apply: applyBindingsStyleModes }, variableModes: { phase: "resources", apply: applyBindingsStyleModes }
};

/** Shared core rules on Figma's view of the target, plus the Figma key table. Throws before any write. */
function checkSet(node: SceneNode, operation: PatchOperation, operationIndex: number): void {
  const set = operation.set || {};
  if (!operation.normalized) throw new Error(`patch.operations[${operationIndex}]: SET operation was not normalized`);
  const issues = patchSetTargetIssues(set, figmaPatchContext(node));
  if (issues.length) throw new Error(issues.map((issue) => `patch.operations[${operationIndex}].set.${issue}`).join("\n"));
  for (const key of Object.keys(set)) {
    const entry = FIGMA_SET_ENTRIES[key as PatchSetKey];
    if (!entry || entry.phase === "rejected") throw new Error(`patch.operations[${operationIndex}].set.${key}: '${key}' cannot be patched in Figma`);
  }
}

async function applySet(node: SceneNode, operation: PatchOperation, operationIndex: number, context: ImportContext, warnings: string[]): Promise<void> {
  checkSet(node, operation, operationIndex);
  const set = operation.set || {}; const values = operation.normalized!;
  setWarnings = [];
  setContext = context;
  try {
    // Detach conflicting bindings/styleRefs with WARNING (mirrors core).
    detachBoundScalars(node, set);
    const textStyleKeys = ["font", "lineHeight", "letterSpacing", "paragraphSpacing", "paragraphIndent", "listSpacing", "textCase", "textDecoration", "hangingPunctuation", "hangingList"];
    if (node.type === "TEXT" && textStyleKeys.some((key) => key in set) && hasStyleId(node.textStyleId)) {
      await node.setTextStyleIdAsync("");
      setWarnings.push(`node '${nodeLabel(node)}': detached styleRefs.text because typography was set`);
    }
    const keys = Object.keys(set) as PatchSetKey[];
    for (const phase of PHASE_ORDER) {
      const inPhase = keys.filter((key) => FIGMA_SET_ENTRIES[key].phase === phase);
      if (!inPhase.length) continue;
      if (phase === "geometry") {
        if (values.size) {
          if (!("resize" in node)) throw new Error(`'w'/'h' are not supported on Figma ${node.type} node '${node.name}'`);
          node.resize(Math.max(.01, finite(values.size.width, node.width)), Math.max(.01, finite(values.size.height, node.height)));
        }
        if (values.position?.x !== undefined) node.x = values.position.x;
        if (values.position?.y !== undefined) node.y = values.position.y;
      }
      if (phase === "text") {
        if (node.type !== "TEXT") throw new Error(`'${inPhase[0]}' is not supported on Figma ${node.type} node '${node.name}'`);
        await applyTextSet(node, values);
        continue;
      }
      const applied = new Set<SetHandler>();
      for (const key of inPhase) {
        const apply = FIGMA_SET_ENTRIES[key].apply;
        if (apply && !applied.has(apply)) { applied.add(apply); await apply(node, values); }
      }
    }
  } finally {
    warnings.push(...setWarnings);
    setWarnings = [];
    setContext = null;
  }
}

/** Offset of a parent's coordinate space: GROUP/BOOLEAN_OPERATION children use the group's parent space. */
function groupOffset(parent: BaseNode | null): { x: number; y: number } {
  return parent && GROUP_TYPES.has(parent.type) && "x" in parent ? { x: (parent as SceneNode).x, y: (parent as SceneNode).y } : { x: 0, y: 0 };
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

type Container = BaseNode & ChildrenMixin;
/**
 * Undo log entries, replayed in reverse on failure.
 * - replace: a SET/REMOVE target was cloned into the hidden backup holder before
 *   the change; rollback puts the clone back where the target was.
 * - create: an inserted/appended node; rollback removes it.
 * - move: rollback reinserts the node at its old parent/index and x/y.
 * Restoring a clone replaces node identities, so later-undone entries resolve
 * originals to their clone counterparts through `replaced`.
 */
type Undo =
  | { kind: "replace"; original: SceneNode; backup: SceneNode; parent: Container; index: number; counterparts: Array<[SceneNode, SceneNode]> }
  | { kind: "create"; node: SceneNode }
  | { kind: "move"; node: SceneNode; parent: Container; index: number; x: number; y: number };

function pairSubtree(original: SceneNode, copy: SceneNode, out: Array<[SceneNode, SceneNode]>): void {
  out.push([original, copy]);
  if ("children" in original && "children" in copy) original.children.forEach((child, index) => { const twin = copy.children[index]; if (twin) pairSubtree(child, twin, out); });
}

function rollback(log: Undo[], holder: FrameNode | null): void {
  const replaced = new Map<BaseNode, BaseNode>();
  const resolve = <T extends BaseNode>(node: T): T => { let current: BaseNode = node; while (replaced.has(current)) current = replaced.get(current)!; return current as T; };
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.kind === "create") {
      const node = resolve(entry.node);
      if (!node.removed) node.remove();
    } else if (entry.kind === "move") {
      const node = resolve(entry.node); const parent = resolve(entry.parent);
      if (node.removed || parent.removed) continue;
      parent.insertChild(Math.max(0, Math.min(entry.index, parent.children.length)), node);
      node.x = entry.x; node.y = entry.y;
    } else {
      const original = resolve(entry.original); const parent = resolve(entry.parent);
      const at = !original.removed && original.parent === parent ? parent.children.indexOf(original) : Math.min(entry.index, parent.children.length);
      // Re-link instances before removing a COMPONENT so rollback does not orphan them.
      const dependents: InstanceNode[] = [];
      if (original.type === "COMPONENT" && !original.removed) {
        for (const candidate of figma.currentPage.findAll((node) => node.type === "INSTANCE")) {
          const instance = candidate as InstanceNode;
          const mainId = "mainComponentId" in instance ? String((instance as { mainComponentId?: string }).mainComponentId || "") : "";
          const main = "mainComponent" in instance ? (instance as { mainComponent?: ComponentNode | null }).mainComponent : null;
          if (main === original || mainId === original.id) dependents.push(instance);
        }
      }
      if (!original.removed) original.remove();
      if (!parent.removed) parent.insertChild(Math.max(0, at), entry.backup);
      for (const [from, to] of entry.counterparts) replaced.set(from, to);
      if (entry.backup.type === "COMPONENT") {
        for (const instance of dependents) {
          if (!instance.removed && "swapComponent" in instance) instance.swapComponent(entry.backup as ComponentNode);
          else if (!instance.removed) {
            (instance as { mainComponentId?: string }).mainComponentId = entry.backup.id;
          }
        }
      }
    }
  }
  if (holder && !holder.removed) holder.remove();
}

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
  const warnings: string[] = [];
  const log: Undo[] = [];
  let holder: FrameNode | null = null;
  // Backups live in one hidden holder so they never appear inside the edited tree
  // (an ancestor cloned later must not capture an earlier backup).
  const park = (node: SceneNode): SceneNode => {
    if (!holder) { holder = figma.createFrame(); holder.name = "Compact Design patch backup"; holder.visible = false; figma.currentPage.appendChild(holder); }
    const backup = node.clone();
    holder.appendChild(backup);
    return backup;
  };

  try {
    for (const [operationIndex, operation] of document.patch.operations.entries()) {
      if (operation.op === "SET" || operation.op === "REMOVE") {
        const original = resolveNode(nodes, operation.id!)!;
        const parent = original.parent;
        if (!parent || !("insertChild" in parent) || original.removed) throw new Error(`patch.operations[${operationIndex}]: node '${operation.id}' was removed earlier in this patch or cannot be patched safely`);
        // Rules run before anything is cloned or written.
        if (operation.op === "SET") checkSet(original, operation, operationIndex);
        const index = parent.children.indexOf(original);
        const backup = park(original);
        const counterparts: Array<[SceneNode, SceneNode]> = [];
        pairSubtree(original, backup, counterparts);
        log.push({ kind: "replace", original, backup, parent, index, counterparts });
        if (operation.op === "SET") { await applySet(original, operation, operationIndex, context, warnings); affected.push(original); }
        else { original.remove(); nodes.delete(operation.id!); }
      }
      if (operation.op === "APPEND" || operation.op === "INSERT") {
        const parent = resolveNode(nodes, operation.parent!)! as SceneNode & ChildrenMixin;
        assertStructuralParent(parent, operationIndex, operation.parent!);
        // Authored x/y are parent-relative; inside a GROUP/BOOLEAN_OPERATION Figma
        // positions children in the group's parent space, so shift by the group.
        const offset = groupOffset(parent);
        const origin = { x: -offset.x, y: -offset.y };
        const at = clampIndex(operation.index ?? parent.children.length, parent.children.length);
        const node = await createNode(operation.node!, parent, origin, context);
        log.push({ kind: "create", node });
        // createNode appends; re-seat with insertChild so the final index matches core.
        if (operation.op === "INSERT") parent.insertChild(at, node);
        nodes.set(operation.node!.id, node);
        affected.push(node);
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
        log.push({ kind: "move", node, parent: previousParent, index: previousIndex, x: node.x, y: node.y });
        // A move keeps the node's parent-relative x/y (core does the same).
        const from = groupOffset(previousParent);
        const relative = { x: node.x - from.x, y: node.y - from.y };
        // Same-parent moves: Figma's insertChild removes first, then inserts at the
        // after-removal index — matching core's final-position semantics.
        const maxIndex = node.parent === parent ? parent.children.length - 1 : parent.children.length;
        const at = clampIndex(operation.index ?? 0, maxIndex);
        parent.insertChild(at, node);
        const to = groupOffset(parent);
        if (node.x !== relative.x + to.x) node.x = relative.x + to.x;
        if (node.y !== relative.y + to.y) node.y = relative.y + to.y;
        affected.push(node);
      }
    }
  } catch (error) {
    rollback(log, holder);
    throw error;
  }
  if (holder && !(holder as FrameNode).removed) (holder as FrameNode).remove();
  return { affected, warnings: [...warnings, ...effectWarnings] };
}
