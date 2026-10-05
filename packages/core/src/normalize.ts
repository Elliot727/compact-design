import type { CompactCanvas, CompactDocument, CompactNode, DesignColor, DesignEffect, DesignPaint, DesignProperties, InternalDocument, InternalNode, InternalPatchDocument, JsonObject, LetterSpacing, LineHeight, PatchOperation, StyleDefinition, Transform, VariableCollectionDefinition } from "./types";

interface RawPaint extends JsonObject { type?: string; image?: string; fit?: string; opacity?: number; transform?: Transform; gradient?: string; angle?: number; stops?: Array<{ at: number; color: string | DesignColor }>; }
interface RawEffect extends JsonObject { type?: string; inner?: boolean; color?: string | DesignColor; x?: number; y?: number; offset?: { x: number; y: number }; blur?: number; radius?: number; spread?: number; visible?: boolean; }
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

function effect(value: RawEffect): DesignEffect {
  if (!value || typeof value !== "object") return value;
  return {
    type: String(value.type || "DROP_SHADOW").toUpperCase(),
    color: hexColor(value.color) || (typeof value.color === "object" ? value.color : undefined),
    offset: value.offset || { x: 0, y: 4 },
    radius: value.blur ?? value.radius ?? 8,
    spread: value.spread || 0,
    visible: value.visible !== false
  };
}

const passthrough = [
  "cornerRadius", "cornerRadii", "opacity", "blendMode", "visible", "locked", "isMask", "clipsContent",
  "strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeAlign",
  "strokeCap", "strokeJoin", "dashPattern", "constraints", "layoutSizingHorizontal", "layoutSizingVertical",
  "layoutAlign", "layoutGrow", "layoutPositioning", "minWidth", "maxWidth", "minHeight", "maxHeight", "layout",
  "layoutGrids", "svg", "vectorPaths", "componentId", "operation", "styleRefs", "bindings", "pointCount",
  "innerRadius", "startingAngle", "endingAngle", "innerRadiusRatio", "componentProperties", "instanceProperties", "prototype", "variantAxes", "variant",
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
  if (typeof raw.overflowDirection === "string") {
    const overflowDirections: Record<string, DesignProperties["overflowDirection"]> = {
      NONE: "NONE",
      HORIZONTAL_SCROLLING: "HORIZONTAL",
      VERTICAL_SCROLLING: "VERTICAL",
      HORIZONTAL_AND_VERTICAL_SCROLLING: "BOTH"
    };
    props.overflowDirection = overflowDirections[raw.overflowDirection];
  }
  if (type === "TEXT") {
    const font = raw.font || {};
    props.text = raw.text !== undefined ? raw.text : (raw.runs || []).map((run) => run.text || "").join("");
    props.font = { family: font.family || "Arial", style: font.style || "Regular", size: font.size || 16 };
    props.lineHeight = typeof raw.lineHeight === "number"
      ? { unit: "PERCENT", value: raw.lineHeight <= 3 ? raw.lineHeight * 100 : raw.lineHeight }
      : (raw.lineHeight || { unit: "AUTO" });
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

export function isPatchDocument(value: unknown): boolean { return Boolean(value && typeof value === "object" && !Array.isArray(value) && "patch" in value); }

export function normalizePatchDocument(value: unknown): InternalPatchDocument {
  if (!isPatchDocument(value)) throw new Error("Patch document requires a patch object.");
  const source = value as { patch?: { operations?: JsonObject[] } };
  if (!Array.isArray(source.patch?.operations) || !source.patch.operations.length) throw new Error("patch.operations must be a non-empty array.");
  const operations: PatchOperation[] = source.patch.operations.map((operation, index) => {
    const op = String(operation.op || "").toUpperCase();
    if (!['SET', 'REMOVE', 'APPEND'].includes(op)) throw new Error(`patch.operations[${index}].op must be set, remove, or append.`);
    if ((op === 'SET' || op === 'REMOVE') && typeof operation.id !== 'string') throw new Error(`patch.operations[${index}].id is required.`);
    if (op === 'SET' && (!operation.set || typeof operation.set !== 'object' || Array.isArray(operation.set))) throw new Error(`patch.operations[${index}].set is required.`);
    if (op === 'APPEND' && (typeof operation.parent !== 'string' || !operation.node)) throw new Error(`patch.operations[${index}] requires parent and node.`);
    const result: PatchOperation = { op: op as PatchOperation['op'], id: typeof operation.id === "string" ? operation.id : undefined, parent: typeof operation.parent === "string" ? operation.parent : undefined, set: operation.set as JsonObject | undefined };
    if (op === 'SET') {
      const textKeys = ['text', 'font', 'lineHeight', 'letterSpacing', 'align', 'runs', 'textDecoration', 'paragraphSpacing', 'textAutoResize'];
      const set = operation.set as JsonObject;
      const syntheticType = textKeys.some((key) => key in set) ? 'TEXT' : 'FRAME';
      result.normalized = normalizeNode({ ...set, type: syntheticType, w: typeof set.w === "number" ? set.w : 1, h: typeof set.h === "number" ? set.h : 1 } as CompactNode, { x: 0, y: 0 }, `patch-${index}`).properties;
    }
    if (op === 'APPEND') result.node = normalizeNode(operation.node as CompactNode, { x: 0, y: 0 }, `patch-${index}-append`);
    return result;
  });
  return { patch: { operations } };
}
