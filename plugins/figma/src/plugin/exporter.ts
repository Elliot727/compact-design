import type { ExportCandidate } from "./export-plan";
import { VariableExportContext, exportColorChannels } from "./export-variables";
import { StyleExportContext } from "./export-styles";

type CompactValue = Record<string, unknown>;
let activeExportIds = new Map<string, string>();
let activeNodeExportIds = new WeakMap<SceneNode, string>();
let activeMainComponents = new WeakMap<InstanceNode, ComponentNode | null>();
let activeVariables: VariableExportContext | null = null;
let activeStyles: StyleExportContext | null = null;
function storedCompactId(node: SceneNode): string { return node.getPluginData("compactDesignId") || node.id; }
function compactId(node: SceneNode): string { return activeNodeExportIds.get(node) || activeExportIds.get(node.id) || storedCompactId(node); }

export function exportCanvasId(compactId: string, nodeType: string): string {
  return nodeType === "FRAME" ? compactId : `${compactId}-canvas`;
}

export function uniqueExportIds(preferredIds: string[]): string[] {
  const result: string[] = [];
  const used = new Set<string>();
  for (const preferredId of preferredIds) {
    let candidate = preferredId;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${preferredId}-${suffix++}`;
    result.push(candidate);
    used.add(candidate);
  }
  return result;
}

function rgba(color: RGB | RGBA, opacity = 1): string {
  const channel = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0").toUpperCase();
  const alpha = "a" in color ? color.a * opacity : opacity;
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}${alpha < 0.999 ? channel(alpha) : ""}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]; const b = bytes[index + 1]; const c = bytes[index + 2];
    output += alphabet[a >> 2];
    output += alphabet[((a & 3) << 4) | ((b || 0) >> 4)];
    output += index + 1 < bytes.length ? alphabet[((b & 15) << 2) | ((c || 0) >> 6)] : "=";
    output += index + 2 < bytes.length ? alphabet[c & 63] : "=";
  }
  return output;
}

function imageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
  return "image/jpeg";
}

async function compactPaint(paint: Paint): Promise<unknown> {
  if (paint.type === "SOLID") return rgba(paint.color, paint.opacity ?? 1);
  if (["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"].includes(paint.type)) {
    const gradient = paint as GradientPaint;
    return {
    gradient: gradient.type.slice(9),
    transform: gradient.gradientTransform,
    stops: gradient.gradientStops.map((stop: ColorStop) => ({ at: stop.position, color: rgba(stop.color) })),
    ...(gradient.opacity !== undefined && gradient.opacity !== 1 ? { opacity: gradient.opacity } : {})
  };
  }
  if (paint.type === "IMAGE") {
    if (!paint.imageHash) return { image: "file:missing-image.jpg", fit: paint.scaleMode };
    const image = figma.getImageByHash(paint.imageHash);
    if (!image) return { image: "file:missing-image.jpg", fit: paint.scaleMode };
    const bytes = await image.getBytesAsync();
    return {
      image: `data:${imageMime(bytes)};base64,${bytesToBase64(bytes)}`,
      fit: ({ FILL: "COVER", FIT: "CONTAIN", CROP: "CROP", TILE: "TILE" } as Record<string, string>)[paint.scaleMode] || "COVER",
      ...(paint.opacity !== undefined && paint.opacity !== 1 ? { opacity: paint.opacity } : {}),
      ...(paint.scaleMode === "CROP" && "imageTransform" in paint ? { transform: paint.imageTransform } : {})
    };
  }
  return null;
}

async function compactPaints(values: readonly Paint[] | PluginAPI["mixed"]): Promise<unknown[]> {
  if (values === figma.mixed) return [];
  return (await Promise.all(values.filter((paint) => paint.visible !== false).map(compactPaint))).filter(Boolean);
}

export function compactStrokeAppearance(
  node: {
    strokeAlign?: "CENTER" | "INSIDE" | "OUTSIDE";
    strokeCap?: string | symbol;
    strokeJoin?: string | symbol;
  },
  mixed: unknown
): CompactValue {
  const result: CompactValue = {};
  if ("strokeAlign" in node && node.strokeAlign !== undefined && node.strokeAlign !== "CENTER") result.strokeAlign = node.strokeAlign;
  if ("strokeCap" in node && node.strokeCap !== undefined && node.strokeCap !== mixed && node.strokeCap !== "NONE") result.strokeCap = node.strokeCap;
  if ("strokeJoin" in node && node.strokeJoin !== undefined && node.strokeJoin !== mixed && node.strokeJoin !== "MITER") result.strokeJoin = node.strokeJoin;
  return result;
}


export function compactTextTypography(
  node: {
    textCase?: string | symbol;
    paragraphIndent?: number | symbol;
    listSpacing?: number | symbol;
    hangingPunctuation?: boolean;
    hangingList?: boolean;
  },
  mixed: unknown
): CompactValue {
  const result: CompactValue = {};
  if (node.textCase !== undefined && node.textCase !== mixed && node.textCase !== "ORIGINAL") result.textCase = node.textCase;
  if (typeof node.paragraphIndent === "number" && node.paragraphIndent !== 0) result.paragraphIndent = node.paragraphIndent;
  if (typeof node.listSpacing === "number" && node.listSpacing !== 0) result.listSpacing = node.listSpacing;
  if (node.hangingPunctuation === true) result.hangingPunctuation = true;
  if (node.hangingList === true) result.hangingList = true;
  return result;
}


export function compactOverflow(
  node: {
    overflowDirection?: string;
    numberOfFixedChildren?: number;
  }
): CompactValue {
  const result: CompactValue = {};
  const overflowDirections: Record<string, string> = {
    HORIZONTAL: "HORIZONTAL_SCROLLING",
    VERTICAL: "VERTICAL_SCROLLING",
    BOTH: "HORIZONTAL_AND_VERTICAL_SCROLLING"
  };
  if (typeof node.overflowDirection === "string") {
    const authored = overflowDirections[node.overflowDirection];
    if (authored) result.overflowDirection = authored;
  }
  if (typeof node.numberOfFixedChildren === "number" && node.numberOfFixedChildren > 0) result.numberOfFixedChildren = node.numberOfFixedChildren;
  return result;
}

export function compactLayoutGrids(values: readonly LayoutGrid[]): CompactValue[] {
  return values.map((grid) => {
    const color = exportColorChannels(grid.color ?? { r: 0, g: 0, b: 0, a: 0.1 });
    if (grid.pattern === "GRID") return { pattern: "GRID", sectionSize: grid.sectionSize, color, visible: grid.visible };
    return {
      pattern: grid.pattern,
      alignment: grid.alignment,
      count: grid.count,
      gutterSize: grid.gutterSize,
      offset: grid.offset,
      ...(grid.alignment === "STRETCH" ? {} : { sectionSize: grid.sectionSize }),
      color,
      visible: grid.visible
    };
  });
}

export function compactEffects(values: readonly Effect[]): unknown[] {
  return values.filter((effect) => effect.visible !== false).map((effect) => {
    if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
      const result: CompactValue = {
        type: effect.type,
        color: rgba(effect.color),
        offset: effect.offset,
        blur: effect.radius,
        spread: effect.spread,
        visible: effect.visible
      };
      if (effect.type === "DROP_SHADOW" && effect.showShadowBehindNode) result.showShadowBehindNode = true;
      return result;
    }
    if (effect.type === "LAYER_BLUR" || effect.type === "BACKGROUND_BLUR") {
      const result: CompactValue = { type: effect.type, blur: effect.radius, visible: effect.visible };
      if (effect.blurType === "PROGRESSIVE") {
        result.blurType = "PROGRESSIVE";
        result.startRadius = effect.startRadius;
        result.startOffset = effect.startOffset;
        result.endOffset = effect.endOffset;
      }
      return result;
    }
    if (effect.type === "NOISE") {
      const result: CompactValue = {
        type: "NOISE",
        noiseType: effect.noiseType,
        color: rgba(effect.color),
        noiseSize: effect.noiseSize,
        density: effect.density,
        visible: effect.visible,
        blendMode: effect.blendMode
      };
      if (effect.noiseType === "DUOTONE") result.secondaryColor = rgba(effect.secondaryColor);
      if (effect.noiseType === "MULTITONE") result.opacity = effect.opacity;
      return result;
    }
    if (effect.type === "TEXTURE") {
      return {
        type: "TEXTURE",
        noiseSize: effect.noiseSize,
        radius: effect.radius,
        clipToShape: effect.clipToShape,
        visible: effect.visible
      };
    }
    if (effect.type === "GLASS") {
      return {
        type: "GLASS",
        lightIntensity: effect.lightIntensity,
        lightAngle: effect.lightAngle,
        refraction: effect.refraction,
        depth: effect.depth,
        dispersion: effect.dispersion,
        radius: effect.radius,
        visible: effect.visible
      };
    }
    if (effect.type === "SHADER") {
      const result: CompactValue = { type: "SHADER", id: effect.id, visible: effect.visible };
      // Property values are keyed by Figma property-definition id; pass them
      // through verbatim so import can re-apply them after importShaderById.
      if (effect.properties && Object.keys(effect.properties).length) result.properties = JSON.parse(JSON.stringify(effect.properties));
      return result;
    }
    return { type: (effect as Effect).type, visible: (effect as Effect).visible };
  });
}

function font(value: FontName | PluginAPI["mixed"], size: number | PluginAPI["mixed"]): CompactValue {
  if (value === figma.mixed) return { family: "Arial", style: "Regular", size: typeof size === "number" ? size : 16 };
  return { family: value.family, style: value.style, size: typeof size === "number" ? size : 16 };
}

async function instanceMainComponent(node: InstanceNode): Promise<ComponentNode | null> {
  if (!activeMainComponents.has(node)) activeMainComponents.set(node, await node.getMainComponentAsync());
  return activeMainComponents.get(node) || null;
}

function nodeType(node: SceneNode, exportedIds: Set<string>, mainComponent: ComponentNode | null): string {
  if (node.type === "INSTANCE") return mainComponent && exportedIds.has(mainComponent.id) ? "INSTANCE" : "FRAME";
  if (["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "BOOLEAN_OPERATION", "RECTANGLE", "ELLIPSE", "LINE", "POLYGON", "STAR", "SECTION", "SLICE", "VECTOR", "TEXT"].includes(node.type)) return node.type;
  return "FRAME";
}

async function compactNode(node: SceneNode, exportedIds: Set<string>): Promise<CompactValue> {
  const mainComponent = node.type === "INSTANCE" ? await instanceMainComponent(node) : null;
  const type = nodeType(node, exportedIds, mainComponent);
  const result: CompactValue = { id: compactId(node), name: node.name, type, x: node.x, y: node.y, w: node.width, h: node.height };
  if ("rotation" in node && node.rotation) result.rotation = node.rotation;
  if ("opacity" in node && node.opacity !== 1) result.opacity = node.opacity;
  if ("blendMode" in node && node.blendMode !== "NORMAL" && node.blendMode !== "PASS_THROUGH") result.blendMode = node.blendMode;
  if (!node.visible) result.visible = false;
  if (node.locked) result.locked = true;
  if ("fills" in node) {
    const fills = await compactPaints(node.fills);
    if (fills.length === 1) result.fill = fills[0]; else if (fills.length) result.fills = fills;
  }
  if ("strokes" in node) {
    const strokes = await compactPaints(node.strokes);
    if (strokes.length === 1) result.stroke = strokes[0]; else if (strokes.length) result.strokes = strokes;
    if (strokes.length && "strokeWeight" in node && node.strokeWeight !== figma.mixed) result.strokeWeight = node.strokeWeight;
    if (strokes.length && "dashPattern" in node && node.dashPattern.length) result.dashPattern = [...node.dashPattern];
    if (strokes.length) Object.assign(result, compactStrokeAppearance(node, figma.mixed));
  }
  if ("effects" in node && node.effects.length) result.effects = compactEffects(node.effects);
  if ("layoutGrids" in node && node.layoutGrids.length) result.layoutGrids = compactLayoutGrids(node.layoutGrids);
  if ("cornerRadius" in node && node.cornerRadius !== figma.mixed && node.cornerRadius) result.cornerRadius = node.cornerRadius;
  else if ("topLeftRadius" in node && [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius].some(Boolean)) result.cornerRadii = [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius];
  if ("clipsContent" in node && node.clipsContent) result.clipsContent = true;
  if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") Object.assign(result, compactOverflow(node));
  if ("isMask" in node && node.isMask) result.isMask = true;
  if ("constraints" in node) result.constraints = node.constraints;
  if ("layoutSizingHorizontal" in node) result.layoutSizingHorizontal = node.layoutSizingHorizontal;
  if ("layoutSizingVertical" in node) result.layoutSizingVertical = node.layoutSizingVertical;
  if ((node.type === "FRAME" || node.type === "COMPONENT") && node.layoutMode !== "NONE") result.layout = {
    direction: node.layoutMode,
    itemSpacing: node.itemSpacing,
    padding: { left: node.paddingLeft, top: node.paddingTop, right: node.paddingRight, bottom: node.paddingBottom },
    primaryAxisAlignItems: node.primaryAxisAlignItems,
    counterAxisAlignItems: node.counterAxisAlignItems,
    primaryAxisSizingMode: node.primaryAxisSizingMode === "AUTO" ? "HUG" : node.primaryAxisSizingMode,
    counterAxisSizingMode: node.counterAxisSizingMode === "AUTO" ? "HUG" : node.counterAxisSizingMode,
    ...(node.layoutWrap === "WRAP" ? { wrap: true, counterAxisSpacing: node.counterAxisSpacing } : {})
  };
  if (node.type === "TEXT") {
    result.text = node.characters;
    result.font = font(node.fontName, node.fontSize);
    if (node.textAlignHorizontal !== "LEFT") result.align = node.textAlignHorizontal;
    if (node.textAlignVertical !== "TOP") result.verticalAlignment = node.textAlignVertical;
    if (node.textAutoResize !== "NONE") result.textAutoResize = node.textAutoResize;
    if (node.letterSpacing !== figma.mixed) result.letterSpacing = node.letterSpacing;
    if (node.lineHeight !== figma.mixed) result.lineHeight = node.lineHeight;
    if (node.paragraphSpacing) result.paragraphSpacing = node.paragraphSpacing;
    Object.assign(result, compactTextTypography(node, figma.mixed));
    if (node.textDecoration !== figma.mixed && node.textDecoration !== "NONE") result.textDecoration = node.textDecoration;
  }
  if (node.type === "VECTOR") result.vectorPaths = node.vectorPaths;
  if (node.type === "POLYGON") result.pointCount = node.pointCount;
  if (node.type === "STAR") { result.pointCount = node.pointCount; result.innerRadius = node.innerRadius; }
  if (node.type === "ELLIPSE" && (node.arcData.startingAngle !== 0 || node.arcData.endingAngle !== Math.PI * 2 || node.arcData.innerRadius !== 0)) { result.type = "ARC"; result.startingAngle = node.arcData.startingAngle; result.endingAngle = node.arcData.endingAngle; result.innerRadiusRatio = node.arcData.innerRadius; }
  if (node.type === "BOOLEAN_OPERATION") result.operation = node.booleanOperation;
  if (node.type === "INSTANCE" && type === "INSTANCE" && mainComponent) { result.componentId = activeExportIds.get(mainComponent.id) || compactId(mainComponent); result.instanceProperties = Object.fromEntries(Object.entries(node.componentProperties).map(([key, value]) => [key, value.value])); }
  const prototype = await compactReactions(node);
  if (prototype) result.prototype = prototype;
  if (activeVariables) {
    const bindings = await activeVariables.bindingsForNode(node);
    if (bindings) result.bindings = bindings;
    const variableModes = await activeVariables.variableModesForNode(node);
    if (variableModes) result.variableModes = variableModes;
  }
  if (activeStyles) {
    const styleRefs = activeStyles.styleRefsForNode(node);
    if (styleRefs) result.styleRefs = styleRefs;
  }
  if ("children" in node) result.children = await Promise.all(node.children.filter((child): child is SceneNode => child.type !== "STICKY" && child.type !== "CONNECTOR" && child.type !== "SHAPE_WITH_TEXT" && child.type !== "CODE_BLOCK" && child.type !== "STAMP" && child.type !== "WIDGET" && child.type !== "EMBED" && child.type !== "LINK_UNFURL" && child.type !== "MEDIA").map((child) => compactNode(child, exportedIds)));
  return result;
}

function collectNodes(node: SceneNode, result: SceneNode[]): void {
  result.push(node);
  if ("children" in node) for (const child of node.children) if ("x" in child) collectNodes(child as SceneNode, result);
}

function compactTrigger(value: Trigger | null): CompactValue {
  if (!value) return { type: "ON_CLICK" };
  return { ...value };
}

async function compactVariableData(value: VariableData | undefined): Promise<unknown> {
  if (!value) return undefined;
  if (value.type === "VARIABLE_ALIAS" && value.value && typeof value.value === "object" && "id" in value.value) return { variable: value.value.id };
  if (value.type === "EXPRESSION" && value.value && typeof value.value === "object" && "expressionFunction" in value.value) return { function: value.value.expressionFunction, resolvedType: value.resolvedType, arguments: await Promise.all(value.value.expressionArguments.map(compactVariableData)) };
  return value.value;
}

async function compactAction(value: Action): Promise<CompactValue | null> {
  if (value.type === "NODE") {
    const destination = value.destinationId ? activeExportIds.get(value.destinationId) : undefined;
    if (!destination) return null;
    return {
      type: value.navigation, destination,
      ...(value.transition ? { transition: { ...value.transition, easing: value.transition.easing } } : {}),
      ...(value.overlayRelativePosition ? { overlayRelativePosition: value.overlayRelativePosition } : {}),
      ...(value.resetVideoPosition ? { resetVideoPosition: true } : {}), ...(value.resetScrollPosition ? { resetScrollPosition: true } : {}),
      ...(value.resetInteractiveComponents ? { resetInteractiveComponents: true } : {})
    };
  }
  if (value.type === "BACK" || value.type === "CLOSE") return { type: value.type };
  if (value.type === "URL") return { type: value.type, url: value.url, openInNewTab: value.openInNewTab };
  if (value.type === "UPDATE_MEDIA_RUNTIME") return { type: value.type, destination: value.destinationId, mediaAction: value.mediaAction, ...(value.mediaAction === "SKIP_FORWARD" || value.mediaAction === "SKIP_BACKWARD" ? { amountToSkip: value.amountToSkip } : {}), ...(value.mediaAction === "SKIP_TO" ? { newTimestamp: value.newTimestamp } : {}) };
  if (value.type === "SET_VARIABLE") return { type: value.type, variable: value.variableId, value: await compactVariableData(value.variableValue) };
  if (value.type === "SET_VARIABLE_MODE") return { type: value.type, collection: value.variableCollectionId, mode: value.variableModeId };
  const conditional = value as Extract<Action, { type: "CONDITIONAL" }>;
  const blocks = (await Promise.all(conditional.conditionalBlocks.map(async (block: ConditionalBlock) => {
    const actions = (await Promise.all(block.actions.map(compactAction))).filter((action): action is CompactValue => action !== null);
    return actions.length ? { ...(block.condition ? { condition: await compactVariableData(block.condition) } : {}), actions } : null;
  }))).filter((block): block is { actions: CompactValue[] } => block !== null);
  return blocks.length ? { type: "CONDITIONAL", blocks } : null;
}

async function compactReactions(node: SceneNode): Promise<CompactValue[] | null> {
  if (!("reactions" in node) || !node.reactions.length) return null;
  const reactions = await Promise.all(node.reactions.map(async (reaction) => ({ trigger: compactTrigger(reaction.trigger), actions: (await Promise.all((reaction.actions || (reaction.action ? [reaction.action] : [])).map(compactAction))).filter((action): action is CompactValue => action !== null) })));
  return reactions.filter((reaction) => reaction.actions.length > 0);
}

export async function collectExportCandidates(page: PageNode): Promise<{ candidates: ExportCandidate[]; nodes: Map<string, SceneNode> }> {
  const candidates: ExportCandidate[] = [];
  const nodes = new Map<string, SceneNode>();
  const visit = async (node: SceneNode, parentFigmaId: string | null): Promise<void> => {
    nodes.set(node.id, node);
    const mainComponent = node.type === "INSTANCE" ? await node.getMainComponentAsync() : null;
    candidates.push({
      figmaId: node.id,
      compactId: node.getPluginData("compactDesignId") || node.id,
      type: node.type,
      name: node.name,
      parentFigmaId,
      mainComponentFigmaId: node.type === "INSTANCE" ? mainComponent?.id ?? null : undefined
    });
    if ("children" in node) for (const child of node.children) if ("x" in child) await visit(child as SceneNode, node.id);
  };
  for (const child of page.children) if ("x" in child) await visit(child as SceneNode, null);
  return { candidates, nodes };
}

export async function exportSelection(selection: readonly SceneNode[]): Promise<{ document: CompactValue; warnings: string[] }> {
  if (!selection.length) throw new Error("Select at least one frame or layer to export.");
  const exportedNodes: SceneNode[] = [];
  const exportedIds = new Set<string>();
  selection.forEach((node) => collectNodes(node, exportedNodes));
  exportedNodes.forEach((node) => exportedIds.add(node.id));
  const assignedIds = uniqueExportIds(exportedNodes.map(storedCompactId));
  activeExportIds = new Map();
  activeNodeExportIds = new WeakMap();
  activeMainComponents = new WeakMap();
  activeVariables = new VariableExportContext();
  activeStyles = new StyleExportContext();
  exportedNodes.forEach((node, index) => {
    const assigned = assignedIds[index];
    activeNodeExportIds.set(node, assigned);
    if (!activeExportIds.has(node.id)) activeExportIds.set(node.id, assigned);
  });
  const warnings: string[] = [];
  const canvases: CompactValue[] = [];
  try {
    for (const node of selection) {
      await activeVariables.collectRefsFromNode(node);
      await activeStyles.collectRefsFromNode(node);
    }
    const variables = await activeVariables.buildVariablesArray();
    warnings.push(...activeVariables.warnings);
    const styles = await activeStyles.buildStylesArray(compactPaints);
    warnings.push(...activeStyles.warnings);
    for (const [index, node] of selection.entries()) {
      const canBecomeCanvas = node.type === "FRAME";
      const exported = await compactNode(node, exportedIds);
      const exportedFills = Array.isArray(exported.fills) ? exported.fills : [];
      const fill = canBecomeCanvas ? (exported.fill ?? exportedFills[0] ?? "#FFFFFF") : "#FFFFFF";
      const children = canBecomeCanvas && Array.isArray(exported.children) ? exported.children : [{ ...exported, x: 0, y: 0 }];
      // Canvas schema forbids node-only props (bindings, variableModes, styleRefs).
      const canvas: CompactValue = { id: exportCanvasId(compactId(node), node.type), name: node.name, x: index * (node.width + 120), width: node.width, height: node.height, fill, clipsContent: "clipsContent" in node ? node.clipsContent : true, nodes: children };
      canvases.push(canvas);
      if (node.type === "INSTANCE") {
        const mainComponent = await instanceMainComponent(node);
        if (!mainComponent || !exportedIds.has(mainComponent.id)) warnings.push(`Instance '${node.name}' was flattened to an editable frame because its main component was outside the selection.`);
      }
    }
    if (canvases.length === 1) {
      const { nodes, ...canvas } = canvases[0];
      return { document: { canvas, nodes, ...(styles.length ? { styles } : {}), ...(variables.length ? { variables } : {}) }, warnings };
    }
    return { document: { canvases, ...(styles.length ? { styles } : {}), ...(variables.length ? { variables } : {}) }, warnings };
  } finally {
    activeVariables = null;
    activeStyles = null;
  }
}
