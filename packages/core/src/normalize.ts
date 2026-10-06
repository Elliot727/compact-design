import { PATCH_SET_KEYS, patchSetShapeIssues } from "./patch-keys";
import type { CompactCanvas, CompactDocument, CompactNode, DesignColor, DesignEffect, DesignFont, DesignPaint, DesignProperties, InternalDocument, InternalNode, InternalPatchDocument, JsonObject, JsonValue, LetterSpacing, LineHeight, PatchOperation, PatchSetValues, PatchStyleDefinition, StyleDefinition, Transform, VariableCollectionDefinition } from "./types";

interface RawPaint extends JsonObject { type?: string; image?: string; fit?: string; opacity?: number; transform?: Transform; gradient?: string; angle?: number; stops?: Array<{ at: number; color: string | DesignColor }>; }
interface RawEffect extends JsonObject {
  type?: string; inner?: boolean; color?: string | DesignColor; secondaryColor?: string | DesignColor;
  x?: number; y?: number; offset?: { x: number; y: number }; blur?: number; radius?: number; spread?: number; visible?: boolean;
  blendMode?: string; showShadowBehindNode?: boolean; blurType?: string; startRadius?: number; startOffset?: { x: number; y: number }; endOffset?: { x: number; y: number };
  noiseType?: string; noiseSize?: number; density?: number; opacity?: number; clipToShape?: boolean;
  lightIntensity?: number; lightAngle?: number; refraction?: number; depth?: number; dispersion?: number;
  id?: string; properties?: Record<string, JsonValue>;
}
interface RawNode extends CompactNode { coordinateMode?: string; fill?: RawPaint | string; fills?: Array<RawPaint | string>; stroke?: RawPaint | string; strokes?: Array<RawPaint | string>; effects?: RawEffect[]; elevation?: string; shadow?: RawEffect | RawEffect[]; rotation?: number; font?: Partial<{ family: string; style: string; size: number }>; text?: string; runs?: Array<JsonObject & { text?: string }>; lineHeight?: number | LineHeight; align?: string; alignment?: unknown; fontSize?: unknown; }

function hexColor(value: unknown): DesignColor | null {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) return null;
  return { r: parseInt(value.slice(1, 3), 16), g: parseInt(value.slice(3, 5), 16), b: parseInt(value.slice(5, 7), 16), a: value.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1 };
}

function paint(value: RawPaint | string): DesignPaint {
  if (typeof value === "string") return { type: "SOLID", color: hexColor(value) || undefined, opacity: 1 };
  if (value.type) return { ...value, type: value.type } as DesignPaint;
  if (value.image) return {
    type: "IMAGE",
    src: value.image,
    scaleMode: ({ COVER: "FILL", CONTAIN: "FIT", CROP: "CROP", TILE: "TILE" } as Record<string, string>)[String(value.fit || "COVER").toUpperCase()] || "FILL",
    opacity: value.opacity ?? 1,
    imageTransform: value.transform
  };
  if (!value.gradient) return { ...value, type: "UNKNOWN" } as DesignPaint;
  const angle = typeof value.angle === "number" && Number.isFinite(value.angle) ? value.angle * Math.PI / 180 : null;
  const cosine = Math.cos(angle ?? 0);
  const sine = Math.sin(angle ?? 0);
  return {
    type: `GRADIENT_${String(value.gradient).toUpperCase()}`,
    gradientTransform: value.transform || (angle === null ? [[1, 0, 0], [0, 1, 0]] : [[cosine, sine, (1 - cosine - sine) / 2], [-sine, cosine, (1 + sine - cosine) / 2]]),
    gradientStops: (value.stops || []).map((stop) => ({ position: stop.at, color: hexColor(stop.color) || stop.color as DesignColor }))
  };
}

const elevationPresets: Record<string, RawEffect[]> = {
  NONE: [],
  LOW: [{ type: "DROP_SHADOW", color: "#00000024", offset: { x: 0, y: 2 }, blur: 8, spread: -1 }],
  MEDIUM: [{ type: "DROP_SHADOW", color: "#0000002E", offset: { x: 0, y: 8 }, blur: 24, spread: -4 }],
  HIGH: [{ type: "DROP_SHADOW", color: "#00000038", offset: { x: 0, y: 18 }, blur: 48, spread: -8 }],
  FLOATING: [{ type: "DROP_SHADOW", color: "#0000001F", offset: { x: 0, y: 2 }, blur: 6, spread: 0 }, { type: "DROP_SHADOW", color: "#00000030", offset: { x: 0, y: 16 }, blur: 40, spread: -8 }]
};

function effects(raw: RawNode): DesignEffect[] {
  const values = [...(elevationPresets[String(raw.elevation || "NONE").toUpperCase()] || [])];
  const shadows = raw.shadow === undefined ? [] : (Array.isArray(raw.shadow) ? raw.shadow : [raw.shadow]);
  values.push(...shadows.map((shadow) => ({ type: shadow.inner ? "INNER_SHADOW" : "DROP_SHADOW", color: shadow.color || "#00000033", offset: { x: shadow.x || 0, y: shadow.y ?? 4 }, blur: shadow.blur ?? 12, spread: shadow.spread || 0 })));
  values.push(...(raw.effects || []));
  return values.map(effect);
}

function resolveColor(value: unknown): DesignColor | undefined {
  return hexColor(value) || (typeof value === "object" && value ? value as DesignColor : undefined);
}

function effect(value: RawEffect): DesignEffect {
  if (!value || typeof value !== "object") return value;
  const type = String(value.type || "DROP_SHADOW").toUpperCase();
  const visible = value.visible !== false;
  if (type === "DROP_SHADOW" || type === "INNER_SHADOW") {
    return {
      type,
      color: resolveColor(value.color),
      offset: value.offset || { x: 0, y: 4 },
      radius: value.blur ?? value.radius ?? 8,
      spread: value.spread || 0,
      visible,
      ...(value.blendMode ? { blendMode: value.blendMode } : {}),
      ...(type === "DROP_SHADOW" && typeof value.showShadowBehindNode === "boolean" ? { showShadowBehindNode: value.showShadowBehindNode } : {})
    };
  }
  if (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR") {
    return {
      type,
      radius: value.blur ?? value.radius ?? 8,
      visible,
      ...(value.blurType ? { blurType: value.blurType } : {}),
      ...(value.startRadius !== undefined ? { startRadius: value.startRadius } : {}),
      ...(value.startOffset ? { startOffset: value.startOffset } : {}),
      ...(value.endOffset ? { endOffset: value.endOffset } : {})
    };
  }
  if (type === "NOISE") {
    return {
      type,
      color: resolveColor(value.color),
      visible,
      ...(value.blendMode ? { blendMode: value.blendMode } : {}),
      noiseType: value.noiseType || "MONOTONE",
      noiseSize: value.noiseSize ?? 1,
      density: value.density ?? 1,
      ...(value.secondaryColor !== undefined ? { secondaryColor: resolveColor(value.secondaryColor) } : {}),
      ...(value.opacity !== undefined ? { opacity: value.opacity } : {})
    };
  }
  if (type === "TEXTURE") {
    return {
      type,
      visible,
      noiseSize: value.noiseSize ?? 1,
      radius: value.blur ?? value.radius ?? 0,
      clipToShape: value.clipToShape !== false
    };
  }
  if (type === "GLASS") {
    return {
      type,
      visible,
      lightIntensity: value.lightIntensity ?? 0.5,
      lightAngle: value.lightAngle ?? -45,
      refraction: value.refraction ?? 0.5,
      depth: value.depth ?? 1,
      dispersion: value.dispersion ?? 0.1,
      radius: value.blur ?? value.radius ?? 0
    };
  }
  if (type === "SHADER") {
    return {
      type,
      id: typeof value.id === "string" ? value.id : "",
      visible,
      ...(value.properties && typeof value.properties === "object" && !Array.isArray(value.properties) ? { properties: value.properties } : {})
    };
  }
  return {
    type,
    color: resolveColor(value.color),
    offset: value.offset || { x: 0, y: 4 },
    radius: value.blur ?? value.radius ?? 8,
    spread: value.spread || 0,
    visible
  };
}

const OVERFLOW_DIRECTIONS: Record<string, DesignProperties["overflowDirection"]> = {
  NONE: "NONE",
  HORIZONTAL: "HORIZONTAL",
  VERTICAL: "VERTICAL",
  BOTH: "BOTH",
  HORIZONTAL_SCROLLING: "HORIZONTAL",
  VERTICAL_SCROLLING: "VERTICAL",
  HORIZONTAL_AND_VERTICAL_SCROLLING: "BOTH"
};

function lineHeightValue(value: number | LineHeight): LineHeight {
  return typeof value === "number" ? { unit: "PERCENT", value: value <= 3 ? value * 100 : value } : value;
}

const passthrough = [
  "cornerRadius", "cornerRadii", "opacity", "blendMode", "visible", "locked", "isMask", "clipsContent",
  "strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeAlign",
  "strokeCap", "strokeJoin", "dashPattern", "constraints", "layoutSizingHorizontal", "layoutSizingVertical",
  "layoutAlign", "layoutGrow", "layoutPositioning", "minWidth", "maxWidth", "minHeight", "maxHeight", "layout",
  "layoutGrids", "svg", "vectorPaths", "componentId", "operation", "styleRefs", "bindings", "pointCount",
  "innerRadius", "startingAngle", "endingAngle", "innerRadiusRatio", "componentProperties", "instanceProperties", "componentPropertyReferences", "prototype", "variantAxes", "variant",
  "overflowDirection", "numberOfFixedChildren", "variableModes"
];

function normalizeNode(node: CompactNode, parent: { x: number; y: number }, path: string): InternalNode {
  const raw = node as RawNode;
  const type = String(raw.type || "FRAME").toUpperCase();
  const relative = raw.coordinateMode !== "ABSOLUTE";
  const x = (relative ? parent.x : 0) + (raw.x || 0);
  const y = (relative ? parent.y : 0) + (raw.y || 0);
  const fills = raw.fills || (raw.fill !== undefined ? [raw.fill] : undefined);
  const strokes = raw.strokes || (raw.stroke !== undefined ? [raw.stroke] : undefined);
  const props: DesignProperties = {
    position: { x, y },
    size: { width: raw.w ?? Number.NaN, height: raw.h ?? Number.NaN },
    rotation: raw.rotation || 0,
    styles: {
      fills: fills === undefined ? (type === "TEXT" ? [paint("#FFFFFF")] : []) : fills.map(paint),
      strokes: strokes === undefined ? [] : strokes.map(paint),
      effects: effects(raw)
    }
  };
  if (type === "TEXT" && raw.alignment !== undefined) throw new Error(`${path}.alignment is not part of the current text API; use align.`);
  if (type === "TEXT" && raw.fontSize !== undefined) throw new Error(`${path}.fontSize is not part of the current text API; use font.size.`);
  Object.assign(props, Object.fromEntries(passthrough.filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]])));
  if (typeof raw.overflowDirection === "string") props.overflowDirection = OVERFLOW_DIRECTIONS[raw.overflowDirection];
  if (type === "TEXT") {
    const font = raw.font || {};
    props.text = raw.text !== undefined ? raw.text : (raw.runs || []).map((run) => run.text || "").join("");
    props.font = { family: font.family || "Arial", style: font.style || "Regular", size: font.size || 16 };
    props.lineHeight = raw.lineHeight !== undefined ? lineHeightValue(raw.lineHeight) : { unit: "AUTO" };
    props.alignment = raw.align || "LEFT";
    for (const key of ["letterSpacing", "textDecoration", "paragraphSpacing", "paragraphIndent", "listSpacing", "hangingPunctuation", "hangingList", "textCase", "verticalAlignment", "textAutoResize", "textTruncation", "maxLines", "runs"]) {
      if (raw[key] !== undefined) Object.assign(props, { [key]: raw[key] });
    }
  }
  return {
    id: raw.id || `generated:${type.toLowerCase()}:${path}`,
    name: raw.name || raw.id || type,
    type,
    properties: props as InternalNode["properties"],
    children: (raw.children || []).map((child: CompactNode, index: number) => normalizeNode(child, { x, y }, `${path}-${index}`))
  };
}

function applyStructuredVariants(nodes: InternalNode[]): void {
  for (const node of nodes) {
    if (node.type === "COMPONENT_SET" && node.properties.variantAxes) {
      const axes = node.properties.variantAxes as Record<string, string[]>;
      for (const child of node.children) {
        const selected = child.properties.variant || {};
        child.name = Object.keys(axes).map((axis) => `${axis}=${selected[axis] ?? axes[axis][0]}`).join(", ");
      }
    }
    applyStructuredVariants(node.children);
  }
}

function objectAt(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  return value as JsonObject;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${path} must be a non-empty string.`);
  return value;
}

function normalizeStyles(value: unknown): StyleDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("styles must be an array.");
  return value.map((entry, index) => {
    const path = `styles[${index}]`; const raw = objectAt(entry, path);
    const type = stringAt(raw.type, `${path}.type`);
    if (type !== "PAINT" && type !== "TEXT") throw new Error(`${path}.type must be PAINT or TEXT.`);
    const style: StyleDefinition = { id: typeof raw.id === "string" ? raw.id : undefined, name: stringAt(raw.name, `${path}.name`), type };
    if (type === "PAINT") {
      if (!Array.isArray(raw.paints)) throw new Error(`${path}.paints must be an array.`);
      style.paints = raw.paints.map((item, paintIndex) => {
        if (typeof item === "string") return paint(item);
        return paint(objectAt(item, `${path}.paints[${paintIndex}]`) as RawPaint);
      });
    } else {
      const fontValue = objectAt(raw.font, `${path}.font`);
      style.font = { family: stringAt(fontValue.family, `${path}.font.family`), style: stringAt(fontValue.style, `${path}.font.style`), size: typeof fontValue.size === "number" ? fontValue.size : 16 };
      if (typeof raw.paragraphSpacing === "number") style.paragraphSpacing = raw.paragraphSpacing;
      if (typeof raw.lineHeight === "number" || (raw.lineHeight && typeof raw.lineHeight === "object")) style.lineHeight = raw.lineHeight as number | LineHeight;
      if (raw.letterSpacing && typeof raw.letterSpacing === "object") style.letterSpacing = raw.letterSpacing as LetterSpacing;
    }
    return style;
  });
}

function normalizeVariables(value: unknown): VariableCollectionDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("variables must be an array.");
  return value.map((entry, collectionIndex) => {
    const path = `variables[${collectionIndex}]`; const raw = objectAt(entry, path);
    const modes = raw.modes === undefined ? undefined : Array.isArray(raw.modes) && raw.modes.every((mode) => typeof mode === "string") ? raw.modes as string[] : (() => { throw new Error(`${path}.modes must be an array of strings.`); })();
    if (!Array.isArray(raw.items)) throw new Error(`${path}.items must be an array.`);
    const items = raw.items.map((entryValue, variableIndex) => {
      const itemPath = `${path}.items[${variableIndex}]`; const item = objectAt(entryValue, itemPath);
      const type = stringAt(item.type, `${itemPath}.type`);
      if (!(["COLOR", "FLOAT", "STRING", "BOOLEAN"] as string[]).includes(type)) throw new Error(`${itemPath}.type must be COLOR, FLOAT, STRING, or BOOLEAN.`);
      if (item.values !== undefined && (!item.values || typeof item.values !== "object" || Array.isArray(item.values))) throw new Error(`${itemPath}.values must be an object keyed by mode.`);
      const variableType = type as "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
      const normalizeValue = (rawValue: unknown, valuePath: string) => {
        if (variableType === "FLOAT" && typeof rawValue === "number" && Number.isFinite(rawValue)) return rawValue;
        if (variableType === "STRING" && typeof rawValue === "string") return rawValue;
        if (variableType === "BOOLEAN" && typeof rawValue === "boolean") return rawValue;
        if (variableType === "COLOR") {
          const color = objectAt(rawValue, valuePath);
          if (typeof color.r === "number" && typeof color.g === "number" && typeof color.b === "number" && (color.a === undefined || typeof color.a === "number")) return { r: color.r, g: color.g, b: color.b, ...(color.a === undefined ? {} : { a: color.a }) };
        }
        throw new Error(`${valuePath} must match variable type ${variableType}.`);
      };
      const singleValue = item.value === undefined ? undefined : normalizeValue(item.value, `${itemPath}.value`);
      const values = item.values === undefined ? undefined : Object.fromEntries(Object.entries(item.values as JsonObject).map(([mode, modeValue]) => [mode, normalizeValue(modeValue, `${itemPath}.values.${mode}`)]));
      return { id: typeof item.id === "string" ? item.id : undefined, name: stringAt(item.name, `${itemPath}.name`), type: variableType, value: singleValue, values };
    });
    return { name: stringAt(raw.name, `${path}.name`), modes, items };
  });
}

export function normalizeDocument(value: unknown): InternalDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The current schema requires exactly one document object.");
  const source = value as CompactDocument;
  if (source.version !== undefined || source.properties !== undefined || source.type !== undefined) {
    throw new Error("Legacy and versioned schemas are not supported. Use the current compact document API.");
  }
  if (source.canvas && source.canvases) throw new Error("Use canvas or canvases, not both.");
  const canvases = source.canvases || (source.canvas ? [{ ...source.canvas, nodes: source.nodes || [] }] : null);
  if (!canvases?.length) throw new Error("Document requires canvas or a non-empty canvases array.");
  const result: InternalDocument = {
    nodes: canvases.map((canvas: CompactCanvas, index: number) => {
      const root = normalizeNode({
        id: canvas.id || `canvas:${index}`, name: canvas.name || `Canvas ${index + 1}`, type: "FRAME",
        x: canvas.x ?? index * ((canvas.width || 1440) + 120), y: canvas.y || 0, w: canvas.width, h: canvas.height,
        fill: canvas.fill || "#FFFFFF", cornerRadius: canvas.cornerRadius, clipsContent: canvas.clipsContent !== false,
        coordinateMode: "ABSOLUTE", children: canvas.nodes || []
      } as CompactNode, { x: 0, y: 0 }, `canvas-${index}`);
      root.properties.breakpoint = canvas.breakpoint;
      if (canvas.variableModes) root.properties.variableModes = canvas.variableModes as DesignProperties["variableModes"];
      if (canvas.bindings) root.properties.bindings = canvas.bindings as DesignProperties["bindings"];
      return root;
    }),
    styles: normalizeStyles(source.styles),
    variables: normalizeVariables(source.variables)
  };
  applyStructuredVariants(result.nodes);
  return result;
}

const SET_VALUE_RENAMES: Record<string, string> = { align: "alignment" };
const SET_STRUCTURED_KEYS = new Set(["name", "x", "y", "w", "h", "fill", "fills", "stroke", "strokes", "effects", "shadow", "elevation", "lineHeight", "overflowDirection", "font", "constraints", "layout"]);

/**
 * Normalize a patch `set` without knowing the target. Only authored keys are
 * produced; nothing is defaulted (no Arial, no TEXT fill). Unknown, deferred
 * and immutable keys throw. Coordinates stay parent-relative.
 */
export function normalizePatchSet(set: JsonObject, path = "set"): PatchSetValues {
  const issues = patchSetShapeIssues(set);
  if (issues.length) throw new Error(`${path}.${issues[0]}`);
  const raw = set as RawNode & JsonObject;
  const values: PatchSetValues = {};
  if (typeof raw.name === "string") values.name = raw.name;
  if ("x" in raw || "y" in raw) values.position = { ...("x" in raw ? { x: raw.x } : {}), ...("y" in raw ? { y: raw.y } : {}) };
  if ("w" in raw || "h" in raw) values.size = { ...("w" in raw ? { width: raw.w } : {}), ...("h" in raw ? { height: raw.h } : {}) };
  const styles: NonNullable<PatchSetValues["styles"]> = {};
  if (raw.fills !== undefined) styles.fills = raw.fills.map(paint);
  else if (raw.fill !== undefined) styles.fills = [paint(raw.fill)];
  if (raw.strokes !== undefined) styles.strokes = raw.strokes.map(paint);
  else if (raw.stroke !== undefined) styles.strokes = [paint(raw.stroke)];
  if (raw.effects !== undefined || raw.shadow !== undefined || raw.elevation !== undefined) styles.effects = effects(raw);
  if (Object.keys(styles).length) values.styles = styles;
  if (raw.lineHeight !== undefined) values.lineHeight = lineHeightValue(raw.lineHeight);
  if (typeof raw.overflowDirection === "string") values.overflowDirection = OVERFLOW_DIRECTIONS[raw.overflowDirection];
  if (raw.font !== undefined) values.font = { ...raw.font };
  if (raw.constraints !== undefined) values.constraints = { ...(raw.constraints as JsonObject) } as PatchSetValues["constraints"];
  if (raw.layout !== undefined) {
    const layout = raw.layout as JsonObject;
    values.layout = { ...layout, ...(layout.padding && typeof layout.padding === "object" ? { padding: { ...(layout.padding as JsonObject) } } : {}) } as PatchSetValues["layout"];
  }
  for (const key of PATCH_SET_KEYS) {
    if (SET_STRUCTURED_KEYS.has(key) || raw[key] === undefined) continue;
    Object.assign(values, { [SET_VALUE_RENAMES[key] || key]: raw[key] });
  }
  return values;
}

export function isPatchDocument(value: unknown): boolean { return Boolean(value && typeof value === "object" && !Array.isArray(value) && "patch" in value); }

/** Patch styles: TEXT font may be partial (merged on upsert). PAINT paints still required when present. */
function normalizePatchStyles(value: unknown): PatchStyleDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("styles must be an array.");
  return value.map((entry, index) => {
    const path = `styles[${index}]`; const raw = objectAt(entry, path);
    const type = stringAt(raw.type, `${path}.type`);
    if (type !== "PAINT" && type !== "TEXT") throw new Error(`${path}.type must be PAINT or TEXT.`);
    const style: PatchStyleDefinition = { id: typeof raw.id === "string" ? raw.id : undefined, name: stringAt(raw.name, `${path}.name`), type };
    if (type === "PAINT") {
      if (raw.paints !== undefined) {
        if (!Array.isArray(raw.paints)) throw new Error(`${path}.paints must be an array.`);
        style.paints = raw.paints.map((item, paintIndex) => {
          if (typeof item === "string") return paint(item);
          return paint(objectAt(item, `${path}.paints[${paintIndex}]`) as RawPaint);
        });
      }
    } else {
      if (raw.font !== undefined) {
        const fontValue = objectAt(raw.font, `${path}.font`);
        const font: Partial<DesignFont> = {};
        if (fontValue.family !== undefined) font.family = stringAt(fontValue.family, `${path}.font.family`);
        if (fontValue.style !== undefined) font.style = stringAt(fontValue.style, `${path}.font.style`);
        if (fontValue.size !== undefined) {
          if (typeof fontValue.size !== "number" || !Number.isFinite(fontValue.size) || fontValue.size <= 0) throw new Error(`${path}.font.size must be a positive number.`);
          font.size = fontValue.size;
        }
        if (!Object.keys(font).length) throw new Error(`${path}.font must include at least one of family, style, size.`);
        style.font = font;
      }
      if (typeof raw.paragraphSpacing === "number") style.paragraphSpacing = raw.paragraphSpacing;
      if (typeof raw.lineHeight === "number" || (raw.lineHeight && typeof raw.lineHeight === "object")) style.lineHeight = raw.lineHeight as number | LineHeight;
      if (raw.letterSpacing && typeof raw.letterSpacing === "object") style.letterSpacing = raw.letterSpacing as LetterSpacing;
    }
    return style;
  });
}

export function normalizePatchDocument(value: unknown): InternalPatchDocument {
  if (!isPatchDocument(value)) throw new Error("Patch document requires a patch object.");
  const source = value as { patch?: { operations?: JsonObject[] }; variables?: unknown; styles?: unknown };
  if (!Array.isArray(source.patch?.operations)) throw new Error("patch.operations must be an array.");
  const hasTokens = (Array.isArray(source.variables) && source.variables.length > 0) || (Array.isArray(source.styles) && source.styles.length > 0);
  if (!source.patch.operations.length && !hasTokens) {
    throw new Error("patch.operations must be a non-empty array (or the patch must carry variables/styles).");
  }
  const operations: PatchOperation[] = source.patch.operations.map((operation, index) => {
    const op = String(operation.op || "").toUpperCase();
    if (!['SET', 'REMOVE', 'APPEND', 'INSERT', 'MOVE', 'DUPLICATE', 'WRAP', 'UNWRAP', 'COMPONENTIZE'].includes(op)) throw new Error(`patch.operations[${index}].op must be set, remove, append, insert, move, duplicate, wrap, unwrap, or componentize.`);
    if ((op === 'SET' || op === 'REMOVE' || op === 'MOVE' || op === 'DUPLICATE' || op === 'UNWRAP' || op === 'COMPONENTIZE') && typeof operation.id !== 'string') throw new Error(`patch.operations[${index}].id is required.`);
    if (op === 'SET' && (!operation.set || typeof operation.set !== 'object' || Array.isArray(operation.set))) throw new Error(`patch.operations[${index}].set is required.`);
    if (op === 'APPEND' && (typeof operation.parent !== 'string' || !operation.node)) throw new Error(`patch.operations[${index}] requires parent and node.`);
    if (op === 'INSERT' && (typeof operation.parent !== 'string' || !operation.node)) throw new Error(`patch.operations[${index}] requires parent and node.`);
    if (op === 'MOVE' && typeof operation.parent !== 'string') throw new Error(`patch.operations[${index}].parent is required.`);
    if ((op === 'INSERT' || op === 'MOVE') && (typeof operation.index !== 'number' || !Number.isInteger(operation.index) || operation.index < 0)) {
      throw new Error(`patch.operations[${index}].index must be a non-negative integer.`);
    }
    if (op === 'DUPLICATE') {
      if (typeof operation.idSuffix !== "string" || !operation.idSuffix) {
        throw new Error(`patch.operations[${index}].idSuffix must be a non-empty string.`);
      }
      if (operation.index !== undefined && (typeof operation.index !== "number" || !Number.isInteger(operation.index) || operation.index < 0)) {
        throw new Error(`patch.operations[${index}].index must be a non-negative integer.`);
      }
      if (operation.ids !== undefined) {
        if (typeof operation.ids !== "object" || operation.ids === null || Array.isArray(operation.ids)) {
          throw new Error(`patch.operations[${index}].ids must be an object.`);
        }
        for (const [key, value] of Object.entries(operation.ids as Record<string, unknown>)) {
          if (typeof value !== "string" || !value) {
            throw new Error(`patch.operations[${index}].ids.${key} must be a non-empty string.`);
          }
        }
      }
    }
    if (op === 'WRAP') {
      if (!Array.isArray(operation.ids) || !operation.ids.length || operation.ids.some((id) => typeof id !== "string" || !id)) {
        throw new Error(`patch.operations[${index}].ids must be a non-empty array of non-empty strings.`);
      }
      if (new Set(operation.ids as string[]).size !== (operation.ids as string[]).length) {
        throw new Error(`patch.operations[${index}].ids must not contain duplicates.`);
      }
      if (!operation.node || typeof operation.node !== "object" || Array.isArray(operation.node)) {
        throw new Error(`patch.operations[${index}].node is required.`);
      }
      const wrapType = String((operation.node as CompactNode).type || "FRAME").toUpperCase();
      if (wrapType !== "FRAME") {
        throw new Error(`patch.operations[${index}].node.type must be FRAME (wrap-as-GROUP is not supported in v1).`);
      }
      if (operation.index !== undefined && (typeof operation.index !== "number" || !Number.isInteger(operation.index) || operation.index < 0)) {
        throw new Error(`patch.operations[${index}].index must be a non-negative integer.`);
      }
    }
    if (op === 'UNWRAP') {
      if (typeof operation.id !== "string" || !operation.id) {
        throw new Error(`patch.operations[${index}].id is required.`);
      }
    }
    if (op === 'COMPONENTIZE') {
      if (typeof operation.id !== "string" || !operation.id) {
        throw new Error(`patch.operations[${index}].id is required.`);
      }
      if (operation.properties !== undefined) {
        if (!operation.properties || typeof operation.properties !== "object" || Array.isArray(operation.properties)) {
          throw new Error(`patch.operations[${index}].properties must be an object.`);
        }
        for (const [name, decl] of Object.entries(operation.properties as Record<string, unknown>)) {
          if (!name) throw new Error(`patch.operations[${index}].properties: property names must be non-empty.`);
          if (!decl || typeof decl !== "object" || Array.isArray(decl)) {
            throw new Error(`patch.operations[${index}].properties.${name} must be an object.`);
          }
          const d = decl as Record<string, unknown>;
          const t = String(d.type || "").toUpperCase();
          if (!["TEXT", "BOOLEAN", "INSTANCE_SWAP"].includes(t)) {
            throw new Error(`patch.operations[${index}].properties.${name}.type must be TEXT, BOOLEAN, or INSTANCE_SWAP.`);
          }
          if (typeof d.layer !== "string" || !d.layer) {
            throw new Error(`patch.operations[${index}].properties.${name}.layer must be a non-empty string.`);
          }
        }
      }
      if (operation.instances !== undefined) {
        if (!Array.isArray(operation.instances) || operation.instances.some((id) => typeof id !== "string" || !id)) {
          throw new Error(`patch.operations[${index}].instances must be an array of non-empty strings.`);
        }
        if (new Set(operation.instances as string[]).size !== (operation.instances as string[]).length) {
          throw new Error(`patch.operations[${index}].instances must not contain duplicates.`);
        }
      }
    }
        const result: PatchOperation = {
      op: op as PatchOperation['op'],
      id: typeof operation.id === "string" ? operation.id : undefined,
      parent: typeof operation.parent === "string" ? operation.parent : undefined,
      index: typeof operation.index === "number" ? operation.index : undefined,
      set: operation.set as JsonObject | undefined,
      idSuffix: typeof operation.idSuffix === "string" ? operation.idSuffix : undefined,
      ids: operation.ids && typeof operation.ids === "object" && !Array.isArray(operation.ids)
        ? { ...(operation.ids as Record<string, string>) }
        : undefined,
      wrapIds: op === 'WRAP' && Array.isArray(operation.ids) ? [...(operation.ids as string[])] : undefined,
      componentizeProperties: op === 'COMPONENTIZE' && operation.properties && typeof operation.properties === "object" && !Array.isArray(operation.properties)
        ? Object.fromEntries(Object.entries(operation.properties as Record<string, { type: string; layer: string }>).map(([name, decl]) => [name, { type: String(decl.type).toUpperCase() as "TEXT" | "BOOLEAN" | "INSTANCE_SWAP", layer: decl.layer }]))
        : undefined,
      componentizeInstances: op === 'COMPONENTIZE' && Array.isArray(operation.instances) ? [...(operation.instances as string[])] : undefined
    };
    if (op === 'SET') {
      const set = operation.set as JsonObject;
      if (!Object.keys(set).length) throw new Error(`patch.operations[${index}].set must contain at least one key.`);
      result.normalized = normalizePatchSet(set, `patch.operations[${index}].set`);
    }
    if (op === 'APPEND') result.node = normalizeNode(operation.node as CompactNode, { x: 0, y: 0 }, `patch-${index}-append`);
    if (op === 'INSERT') result.node = normalizeNode(operation.node as CompactNode, { x: 0, y: 0 }, `patch-${index}-insert`);
    if (op === 'WRAP') {
      const raw = operation.node as CompactNode;
      // Seed omitted w/h with 1 so normalizeNode/validate don't fail; apply fills bbox later.
      const seeded = {
        ...raw,
        type: "FRAME",
        w: typeof raw.w === "number" && raw.w > 0 ? raw.w : 1,
        h: typeof raw.h === "number" && raw.h > 0 ? raw.h : 1,
        children: []
      } as CompactNode;
      result.node = normalizeNode(seeded, { x: 0, y: 0 }, `patch-${index}-wrap`);
      // Remember whether size was authored (NaN marker via custom flag on size — use width/height <= 0 impossible; store via name tag? Better: keep authored flags on operation).
      if (!(typeof raw.w === "number" && raw.w > 0)) result.node.properties.size.width = Number.NaN;
      if (!(typeof raw.h === "number" && raw.h > 0)) result.node.properties.size.height = Number.NaN;
    }
    return result;
  });
  const result: InternalPatchDocument = { patch: { operations } };
  const variables = normalizeVariables(source.variables);
  if (variables.length) result.variables = variables;
  const styles = normalizePatchStyles(source.styles);
  if (styles.length) result.styles = styles;
  return result;
}
