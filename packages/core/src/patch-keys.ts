import type { JsonObject } from "./types";

/**
 * Single source of truth for `set` in patch operations. Every key a node may
 * carry in the schema is either settable here or explicitly excluded. Core,
 * the JSON schema test-suite, and the Figma adapter all read this list.
 */
export const PATCH_SET_EXCLUDED_NODE_KEYS = ["id", "type", "children", "coordinateMode"] as const;

export const PATCH_SET_KEYS = [
  "name", "x", "y", "w", "h", "rotation",
  "fill", "fills", "stroke", "strokes",
  "strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight",
  "strokeAlign", "strokeCap", "strokeJoin", "dashPattern",
  "cornerRadius", "cornerRadii", "opacity", "blendMode", "visible", "locked", "isMask", "clipsContent",
  "effects", "elevation", "shadow",
  "layout", "constraints", "layoutSizingHorizontal", "layoutSizingVertical", "layoutAlign", "layoutGrow", "layoutPositioning",
  "minWidth", "maxWidth", "minHeight", "maxHeight", "layoutGrids",
  "text", "font", "lineHeight", "letterSpacing", "align", "verticalAlignment", "textDecoration", "textCase",
  "paragraphSpacing", "paragraphIndent", "listSpacing", "hangingPunctuation", "hangingList",
  "textAutoResize", "textTruncation", "maxLines", "runs",
  "pointCount", "innerRadius", "startingAngle", "endingAngle", "innerRadiusRatio",
  "svg", "vectorPaths", "componentId", "componentProperties", "instanceProperties", "variantAxes", "variant",
  "operation", "prototype", "overflowDirection", "numberOfFixedChildren", "styleRefs", "bindings", "variableModes"
] as const;

export type PatchSetKey = typeof PATCH_SET_KEYS[number];

/**
 * - `scalar`: the value replaces the previous value.
 * - `merge`: objects deep-merge into the current value (unmentioned fields are kept).
 * - `replace`: arrays (paint, effect, run, grid, path lists) replace the whole list.
 * - `deferred`: recognised but not patchable yet; both engines reject it with PATCH_SET_UNSUPPORTED.
 * - `immutable`: can never be patched in place; remove + insert instead.
 */
export type PatchSetSemantics = "scalar" | "merge" | "replace" | "deferred" | "immutable";

export const PATCH_SET_SEMANTICS: Readonly<Record<PatchSetKey, PatchSetSemantics>> = {
  name: "scalar", x: "scalar", y: "scalar", w: "scalar", h: "scalar", rotation: "scalar",
  fill: "replace", fills: "replace", stroke: "replace", strokes: "replace",
  strokeWeight: "scalar", strokeTopWeight: "scalar", strokeRightWeight: "scalar", strokeBottomWeight: "scalar", strokeLeftWeight: "scalar",
  strokeAlign: "scalar", strokeCap: "scalar", strokeJoin: "scalar", dashPattern: "replace",
  cornerRadius: "scalar", cornerRadii: "replace", opacity: "scalar", blendMode: "scalar", visible: "scalar", locked: "scalar", isMask: "scalar", clipsContent: "scalar",
  effects: "replace", elevation: "replace", shadow: "replace",
  layout: "merge", constraints: "merge", layoutSizingHorizontal: "scalar", layoutSizingVertical: "scalar", layoutAlign: "scalar", layoutGrow: "scalar", layoutPositioning: "scalar",
  minWidth: "scalar", maxWidth: "scalar", minHeight: "scalar", maxHeight: "scalar", layoutGrids: "replace",
  text: "scalar", font: "merge", lineHeight: "scalar", letterSpacing: "scalar", align: "scalar", verticalAlignment: "scalar", textDecoration: "scalar", textCase: "scalar",
  paragraphSpacing: "scalar", paragraphIndent: "scalar", listSpacing: "scalar", hangingPunctuation: "scalar", hangingList: "scalar",
  textAutoResize: "scalar", textTruncation: "scalar", maxLines: "scalar", runs: "replace",
  pointCount: "scalar", innerRadius: "scalar", startingAngle: "scalar", endingAngle: "scalar", innerRadiusRatio: "scalar",
  svg: "immutable", vectorPaths: "replace", componentId: "deferred", componentProperties: "deferred", instanceProperties: "deferred", variantAxes: "deferred", variant: "deferred",
  operation: "scalar", prototype: "deferred", overflowDirection: "scalar", numberOfFixedChildren: "scalar", styleRefs: "deferred", bindings: "deferred", variableModes: "deferred"
};

export const PATCH_SET_DEFERRED_KEYS: readonly PatchSetKey[] = PATCH_SET_KEYS.filter((key) => PATCH_SET_SEMANTICS[key] === "deferred");

const ALL = null;
const FRAME_LIKE = ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"];
const AUTO_LAYOUT_CAPABLE = ["FRAME", "COMPONENT"];
const STROKABLE = ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "RECTANGLE", "ELLIPSE", "ARC", "LINE", "POLYGON", "STAR", "VECTOR", "TEXT", "BOOLEAN_OPERATION"];
const FILLABLE = [...STROKABLE, "SECTION"];
const BLENDABLE = [...STROKABLE, "GROUP"];
const LAYOUT_CHILD = [...STROKABLE, "GROUP"];
const TEXT_ONLY = ["TEXT"];

/** Compact node types each key applies to. `null` means every type. */
export const PATCH_SET_APPLIES_TO: Readonly<Record<PatchSetKey, readonly string[] | null>> = {
  name: ALL, x: ALL, y: ALL, rotation: [...BLENDABLE],
  w: [...STROKABLE, "SECTION", "SLICE"], h: [...STROKABLE, "SECTION", "SLICE"],
  fill: FILLABLE, fills: FILLABLE, stroke: STROKABLE, strokes: STROKABLE,
  strokeWeight: STROKABLE, strokeTopWeight: FRAME_LIKE.concat("RECTANGLE"), strokeRightWeight: FRAME_LIKE.concat("RECTANGLE"), strokeBottomWeight: FRAME_LIKE.concat("RECTANGLE"), strokeLeftWeight: FRAME_LIKE.concat("RECTANGLE"),
  strokeAlign: STROKABLE, strokeCap: ["LINE", "VECTOR", "ELLIPSE", "ARC"], strokeJoin: STROKABLE, dashPattern: STROKABLE,
  cornerRadius: [...FRAME_LIKE, "RECTANGLE", "POLYGON", "STAR", "VECTOR"], cornerRadii: [...FRAME_LIKE, "RECTANGLE"],
  opacity: BLENDABLE, blendMode: BLENDABLE, visible: ALL, locked: ALL, isMask: BLENDABLE, clipsContent: FRAME_LIKE,
  effects: BLENDABLE, elevation: BLENDABLE, shadow: BLENDABLE,
  layout: AUTO_LAYOUT_CAPABLE, constraints: STROKABLE,
  layoutSizingHorizontal: LAYOUT_CHILD, layoutSizingVertical: LAYOUT_CHILD, layoutAlign: LAYOUT_CHILD, layoutGrow: LAYOUT_CHILD, layoutPositioning: LAYOUT_CHILD,
  minWidth: LAYOUT_CHILD, maxWidth: LAYOUT_CHILD, minHeight: LAYOUT_CHILD, maxHeight: LAYOUT_CHILD, layoutGrids: AUTO_LAYOUT_CAPABLE,
  text: TEXT_ONLY, font: TEXT_ONLY, lineHeight: TEXT_ONLY, letterSpacing: TEXT_ONLY, align: TEXT_ONLY, verticalAlignment: TEXT_ONLY, textDecoration: TEXT_ONLY, textCase: TEXT_ONLY,
  paragraphSpacing: TEXT_ONLY, paragraphIndent: TEXT_ONLY, listSpacing: TEXT_ONLY, hangingPunctuation: TEXT_ONLY, hangingList: TEXT_ONLY,
  textAutoResize: TEXT_ONLY, textTruncation: TEXT_ONLY, maxLines: TEXT_ONLY, runs: TEXT_ONLY,
  pointCount: ["POLYGON", "STAR"], innerRadius: ["STAR"], startingAngle: ["ELLIPSE", "ARC"], endingAngle: ["ELLIPSE", "ARC"], innerRadiusRatio: ["ELLIPSE", "ARC"],
  svg: ALL, vectorPaths: ["VECTOR"], componentId: ALL, componentProperties: ALL, instanceProperties: ALL, variantAxes: ALL, variant: ALL,
  operation: ["BOOLEAN_OPERATION"], prototype: ALL, overflowDirection: AUTO_LAYOUT_CAPABLE, numberOfFixedChildren: AUTO_LAYOUT_CAPABLE,
  styleRefs: ALL, bindings: ALL, variableModes: ALL
};

/** Keys that style a TEXT node and are owned by a linked text style. */
export const PATCH_TEXT_STYLE_KEYS: readonly PatchSetKey[] = ["font", "lineHeight", "letterSpacing", "paragraphSpacing", "paragraphIndent", "listSpacing", "textCase", "textDecoration", "hangingPunctuation", "hangingList"];

const PATCH_SET_KEY_SET: ReadonlySet<string> = new Set(PATCH_SET_KEYS);
export function isPatchSetKey(key: string): key is PatchSetKey { return PATCH_SET_KEY_SET.has(key); }

/**
 * The state of a patch target as seen by an engine (core document tree or the
 * Figma scene). Both engines build this and run the same rules, so a set that
 * is rejected in one is rejected in the other.
 */
export interface PatchTargetContext {
  /** Compact node type of the target (Figma maps its native type to the compact one). */
  type: string;
  /** Compact type of the parent, or null for a root canvas. */
  parentType: string | null;
  /** Parent currently has Auto Layout. */
  parentAutoLayout: boolean;
  /** Target currently has Auto Layout (before this set). */
  autoLayout: boolean;
  /** Current layoutPositioning of the target. */
  layoutPositioning?: string;
  /** TEXT with per-range styling (core: a run carrying font/fill/letterSpacing/textDecoration/link; Figma: some text property is "mixed" in Figma). */
  mixedText: boolean;
  /** TEXT whose fonts differ per range (core: a run with font.family/style; Figma: fontName is "mixed" in Figma). */
  mixedFontName: boolean;
  /** TEXT linked to a text style (core: styleRefs.text; Figma: textStyleId). */
  textStyle: boolean;
  /** Variable-bound fields on the target (compact binding field names). */
  boundFields: readonly string[];
  /** Number of direct children. */
  childCount: number;
}

const isObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const GROUP_TYPES = new Set(["GROUP", "BOOLEAN_OPERATION"]);
const PADDING_FIELDS: Record<string, string> = { left: "paddingLeft", top: "paddingTop", right: "paddingRight", bottom: "paddingBottom" };

/** Variable-binding field names a set would overwrite (fill/stroke excluded: those detach — see docs). */
export function patchSetBindingFields(set: JsonObject): string[] {
  const fields: string[] = [];
  const direct: Record<string, string[]> = {
    w: ["width"], h: ["height"], opacity: ["opacity"], visible: ["visible"], text: ["characters"],
    cornerRadius: ["cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"],
    cornerRadii: ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"],
    strokeWeight: ["strokeWeight"], strokeTopWeight: ["strokeTopWeight"], strokeRightWeight: ["strokeRightWeight"], strokeBottomWeight: ["strokeBottomWeight"], strokeLeftWeight: ["strokeLeftWeight"],
    minWidth: ["minWidth"], maxWidth: ["maxWidth"], minHeight: ["minHeight"], maxHeight: ["maxHeight"],
    paragraphSpacing: ["paragraphSpacing"], paragraphIndent: ["paragraphIndent"], letterSpacing: ["letterSpacing"], lineHeight: ["lineHeight"]
  };
  for (const [key, mapped] of Object.entries(direct)) if (key in set) fields.push(...mapped);
  if (isObject(set.layout)) {
    if ("itemSpacing" in set.layout) fields.push("itemSpacing");
    if ("counterAxisSpacing" in set.layout) fields.push("counterAxisSpacing");
    if (isObject(set.layout.padding)) for (const side of Object.keys(set.layout.padding)) if (PADDING_FIELDS[side]) fields.push(PADDING_FIELDS[side]);
  }
  if (isObject(set.font)) {
    if ("size" in set.font) fields.push("fontSize");
    if ("family" in set.font) fields.push("fontFamily");
    if ("style" in set.font) fields.push("fontStyle");
  }
  return fields;
}

/** Shape checks that need no target. Returns `key: message` strings. */
export function patchSetShapeIssues(set: JsonObject): string[] {
  const issues: string[] = [];
  for (const key of Object.keys(set)) {
    if (!isPatchSetKey(key)) {
      issues.push(`${key}: unknown set key '${key}'. Settable keys: ${PATCH_SET_KEYS.join(", ")}.`);
      continue;
    }
    const semantics = PATCH_SET_SEMANTICS[key];
    if (semantics === "deferred") issues.push(`${key}: '${key}' cannot be patched yet (planned follow-up). Re-import the node, or remove and insert it.`);
    if (semantics === "immutable") issues.push(`${key}: '${key}' cannot be patched in place. Remove the node and insert a new one.`);
  }
  for (const key of ["font", "layout", "constraints"] as const) {
    if (key in set && (!isObject(set[key]) || !Object.keys(set[key] as JsonObject).length)) issues.push(`${key}: '${key}' must be a non-empty object.`);
  }
  if (isObject(set.layout) && "padding" in set.layout && (!isObject(set.layout.padding) || !Object.keys(set.layout.padding).length)) issues.push("layout.padding: padding must be a non-empty object.");
  if ("fill" in set && "fills" in set) issues.push("fills: set either fill or fills, not both.");
  if ("stroke" in set && "strokes" in set) issues.push("strokes: set either stroke or strokes, not both.");
  if (isObject(set.layout) && set.layout.counterAxisAlignItems === "STRETCH") issues.push("layout.counterAxisAlignItems: STRETCH cannot be patched yet (Figma applies it per child at import). Set layoutAlign: STRETCH on the children instead.");
  if (Array.isArray(set.runs) && set.text === undefined && set.runs.some((run) => !isObject(run) || typeof run.text !== "string")) issues.push("runs: without text, every run must carry its own text so the content is defined.");
  return issues;
}

/**
 * Target-dependent rules. Both engines call this with their own view of the
 * target before applying a set. Returns `key: message` strings.
 */
export function patchSetTargetIssues(set: JsonObject, context: PatchTargetContext): string[] {
  const issues = patchSetShapeIssues(set);
  for (const key of Object.keys(set)) {
    if (!isPatchSetKey(key)) continue;
    const types = PATCH_SET_APPLIES_TO[key];
    if (types && !types.includes(context.type)) issues.push(`${key}: '${key}' does not apply to ${context.type} nodes.`);
  }
  const layout = isObject(set.layout) ? set.layout : null;
  const autoLayoutAfter = context.autoLayout || Boolean(layout && typeof layout.direction === "string");
  const positioningAfter = typeof set.layoutPositioning === "string" ? set.layoutPositioning : context.layoutPositioning;
  if (("x" in set || "y" in set) && context.parentType && GROUP_TYPES.has(context.parentType)) {
    issues.push(`${"x" in set ? "x" : "y"}: children of a ${context.parentType} cannot be positioned by patch (the group derives its bounds from its children). Set x/y on the ${context.parentType} instead, or move the node out first.`);
  }
  if (("x" in set || "y" in set) && context.parentAutoLayout && positioningAfter !== "ABSOLUTE") {
    issues.push(`${"x" in set ? "x" : "y"}: the parent uses Auto Layout, which positions this node. Also set layoutPositioning: "ABSOLUTE" to place it by x/y.`);
  }
  if (layout && !context.autoLayout && typeof layout.direction !== "string" && PATCH_SET_APPLIES_TO.layout?.includes(context.type)) {
    issues.push("layout.direction: the target has no Auto Layout yet; a partial layout must include direction to enable it.");
  }
  for (const key of ["layoutAlign", "layoutGrow", "layoutPositioning"] as const) {
    if (key in set && !context.parentAutoLayout) issues.push(`${key}: '${key}' only applies to children of an Auto Layout parent.`);
  }
  for (const key of ["layoutSizingHorizontal", "layoutSizingVertical"] as const) {
    if (set[key] === "FILL" && !context.parentAutoLayout) issues.push(`${key}: FILL requires an Auto Layout parent.`);
    if (set[key] === "HUG" && context.type !== "TEXT" && !autoLayoutAfter) issues.push(`${key}: HUG requires a TEXT node or an Auto Layout frame.`);
  }
  for (const key of ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const) {
    if (key in set && !autoLayoutAfter && !context.parentAutoLayout) issues.push(`${key}: '${key}' only applies to Auto Layout frames or their children.`);
  }
  if (typeof set.numberOfFixedChildren === "number" && set.numberOfFixedChildren > context.childCount) {
    issues.push(`numberOfFixedChildren: ${set.numberOfFixedChildren} exceeds the node's ${context.childCount} children.`);
  }
  if (context.type === "TEXT") {
    if (("text" in set || "runs" in set) && context.mixedText) {
      issues.push(`${"runs" in set ? "runs" : "text"}: the node has per-range text styling; replacing its content by patch is not supported yet. Remove and insert the TEXT node instead.`);
    }
    if (isObject(set.font) && context.mixedFontName && (("family" in set.font) !== ("style" in set.font))) {
      issues.push("font: the node mixes fonts across ranges; set font.family and font.style together (font.size alone is fine).");
    }
    if (context.textStyle) {
      const styled = PATCH_TEXT_STYLE_KEYS.filter((key) => key in set);
      if (styled.length) issues.push(`${styled[0]}: the node is linked to a text style; changing ${styled.join(", ")} would detach it, which patch does not support yet.`);
    }
  }
  const bound = patchSetBindingFields(set).filter((field) => context.boundFields.includes(field));
  if (bound.length) issues.push(`bindings: the set overwrites variable-bound field(s) ${[...new Set(bound)].join(", ")}; unbinding by patch is not supported yet.`);
  return issues;
}
