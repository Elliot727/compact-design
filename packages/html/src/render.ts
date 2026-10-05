import {
  indexDocument,
  validate,
  type DesignFont,
  type DesignPaint,
  type DesignProperties,
  type InternalDocument,
  type InternalNode,
  type RepairIssue,
  type StyleDefinition,
  type VariableDefinition
} from "@compact-design/core";
import {
  arcPath,
  backgroundLayers,
  blendModeCss,
  blurFilters,
  childSizingDeclarations,
  cssColor,
  cssEscape,
  effectShadows,
  escapeHtml,
  finite,
  fontDeclarations,
  htmlId,
  isDesignColor,
  isRecord,
  isWebSafeFont,
  layoutDeclarations,
  letterSpacingCss,
  lineHeightCss,
  overflowDeclarations,
  paintColor,
  radiusDeclarations,
  regularPolygon,
  sanitizeSvg,
  strokeDeclarations,
  textCaseCss
} from "./css";

export interface RenderOptions {
  title?: string;
  background?: string;
}

export interface RenderResult {
  html: string;
  body: string;
  css: string;
}

export class RenderError extends Error {
  readonly issues: RepairIssue[];
  constructor(message: string, issues: RepairIssue[] = []) {
    super(message);
    this.name = "RenderError";
    this.issues = issues;
  }
}

interface VariableRef {
  collection: string;
  item: VariableDefinition;
}

interface RenderContext {
  document: InternalDocument;
  components: ReadonlyMap<string, InternalNode>;
  styles: Map<string, StyleDefinition>;
  variables: Map<string, VariableRef>;
  fonts: Set<string>;
  timeouts: Array<{ id: string; seconds: number; destination: string }>;
}

interface WalkState {
  parent: InternalNode | undefined;
  parentHasLayout: boolean;
  modes: Record<string, string>;
}

interface PrototypeLink {
  href?: string;
  timeout?: { seconds: number; destination: string };
  back?: boolean;
  setMode?: { collection: string; mode: string };
}

export function render(input: unknown, options: RenderOptions = {}): RenderResult {
  const result = validate(input);
  if (result.patch) throw new RenderError("Cannot render a Compact Design patch document.");
  if (!result.valid || !result.document) throw new RenderError("Compact Design document is not valid.", result.issues);
  return renderDocument(result.document, options);
}

export function renderDocument(document: InternalDocument, options: RenderOptions = {}): RenderResult {
  const ctx = createContext(document);
  const modes = initialBoardModes(document);
  const css: string[] = [baseCss(options.background || "#d8d4cb"), themeCss(document)];
  const body = document.nodes.map((node) => renderNode(node, ctx, { parent: undefined, parentHasLayout: false, modes: { ...modes } }, css)).join("\n");
  const board = boardCss(document.nodes);
  const fonts = fontLinks(ctx.fonts);
  const script = runtimeScript(ctx.timeouts);
  const stylesheet = [board, ...css].filter(Boolean).join("\n");
  const title = escapeHtml(options.title || document.nodes[0]?.name || "Compact Design");
  const modeAttrs = Object.entries(modes).map(([collection, mode]) => `data-cd-mode-${cssVar(collection)}="${escapeHtml(mode)}"`).join(" ");
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${fonts}
<style>
${stylesheet}
</style>
</head>
<body>
<main class="cd-board"${modeAttrs ? ` ${modeAttrs}` : ""}>
${body}
</main>
${script}
</body>
</html>
`;
  return { html: page, body, css: stylesheet };
}

function createContext(document: InternalDocument): RenderContext {
  const styles = new Map<string, StyleDefinition>();
  for (const style of document.styles) {
    if (style.id) styles.set(style.id, style);
    styles.set(style.name, style);
  }
  const variables = new Map<string, VariableRef>();
  for (const collection of document.variables) {
    for (const item of collection.items) {
      const ref = { collection: collection.name, item };
      if (item.id) variables.set(item.id, ref);
      variables.set(item.name, ref);
    }
  }
  return {
    document,
    components: indexDocument(document).components,
    styles,
    variables,
    fonts: new Set(),
    timeouts: []
  };
}

function boardCss(nodes: InternalNode[]): string {
  const minX = Math.min(0, ...nodes.map((node) => node.properties.position.x));
  const minY = Math.min(0, ...nodes.map((node) => node.properties.position.y));
  const width = Math.max(0, ...nodes.map((node) => node.properties.position.x + node.properties.size.width - minX));
  const height = Math.max(0, ...nodes.map((node) => node.properties.position.y + node.properties.size.height - minY));
  return `.cd-board { --cd-origin-x: ${minX}px; --cd-origin-y: ${minY}px; width: ${width}px; height: ${height}px; }`;
}

function baseCss(background: string): string {
  return `html, body { margin: 0; background: ${background}; }
.cd-board { position: relative; margin: 32px auto; }
.cd-node { box-sizing: border-box; }
.cd-node[data-type="TEXT"] { white-space: pre-wrap; overflow-wrap: break-word; }
.cd-node a.cd-hotspot, a.cd-node { color: inherit; text-decoration: none; }
.cd-shape { display: block; width: 100%; height: 100%; }`;
}

function renderNode(node: InternalNode, ctx: RenderContext, state: WalkState, css: string[]): string {
  if (node.properties.visible === false) return "";
  const modes = { ...state.modes, ...(node.properties.variableModes || {}) };
  const instanceOf = node.type === "INSTANCE" && node.properties.componentId
    ? ctx.components.get(node.properties.componentId)
    : undefined;
  const visual = instanceOf || node;
  const props = mergeInstance(node, instanceOf);
  noteFonts(props, ctx);
  const id = htmlId(node.id);
  const link = prototypeLink(props.prototype, ctx, id);
  css.push(nodeRule(id, node, props, state, modes, ctx));

  const childrenSource = instanceOf ? instanceOf.children : node.children;
  const childState: WalkState = {
    parent: instanceOf || node,
    parentHasLayout: Boolean((instanceOf || node).properties.layout?.direction),
    modes
  };
  const inner = [
    shapeMarkup(node.type === "INSTANCE" ? visual.type : node.type, props, ctx),
    ...childrenSource.map((child) => renderNode(applyInstanceText(child, node), ctx, childState, css))
  ].join("");

  const attrs = [
    `id="${escapeHtml(id)}"`,
    `class="cd-node"`,
    `data-type="${escapeHtml(node.type)}"`,
    `data-name="${escapeHtml(node.name)}"`
  ];
  if (link.timeout) attrs.push(`data-cd-timeout="${link.timeout.seconds}"`, `data-cd-navigate="${escapeHtml(htmlId(link.timeout.destination))}"`);
  if (link.back) attrs.push(`data-cd-back="true"`);
  if (link.setMode) {
    attrs.push(`data-cd-set-collection="${escapeHtml(cssVar(link.setMode.collection))}"`, `data-cd-set-mode="${escapeHtml(link.setMode.mode)}"`);
  }

  const tag = link.href || link.back || link.setMode ? "a" : "div";
  if (link.href) attrs.push(`href="${escapeHtml(link.href)}"`);
  else if (link.back || link.setMode) attrs.push(`href="#"`);
  if (node.type === "TEXT") return `<${tag} ${attrs.join(" ")}>${textInner(props, ctx)}</${tag}>`;
  if (node.type === "SVG" && props.svg) return `<${tag} ${attrs.join(" ")}>${sanitizeSvg(props.svg)}</${tag}>`;
  return `<${tag} ${attrs.join(" ")}>${inner}</${tag}>`;
}

function mergeInstance(node: InternalNode, component: InternalNode | undefined): DesignProperties {
  if (!component) return node.properties;
  return {
    ...component.properties,
    ...node.properties,
    styles: {
      fills: node.properties.styles.fills.length ? node.properties.styles.fills : component.properties.styles.fills,
      strokes: node.properties.styles.strokes.length ? node.properties.styles.strokes : component.properties.styles.strokes,
      effects: node.properties.styles.effects.length ? node.properties.styles.effects : component.properties.styles.effects
    },
    size: node.properties.size,
    position: node.properties.position,
    layout: node.properties.layout || component.properties.layout,
    prototype: node.properties.prototype || component.properties.prototype
  };
}

function applyInstanceText(child: InternalNode, instance: InternalNode): InternalNode {
  const overrides = instance.properties.instanceProperties;
  if (!overrides || child.type !== "TEXT") return child;
  const named = overrides[child.name];
  if (typeof named !== "string") return child;
  return { ...child, properties: { ...child.properties, text: named } };
}

function nodeRule(id: string, node: InternalNode, props: DesignProperties, state: WalkState, modes: Record<string, string>, ctx: RenderContext): string {
  const declarations = [
    ...positionDeclarations(props, state),
    ...sizeDeclarations(props, state),
    ...layoutDeclarations(props),
    ...childSizingDeclarations(props, state.parent?.properties.layout?.direction),
    ...overflowDeclarations(props),
    ...radiusDeclarations(props),
    ...(node.type === "ARC" || node.type === "LINE" ? [] : boundStrokeDeclarations(resolvedProps(props, ctx, modes), ctx)),
    ...paintDeclarations(node.type, resolvedProps(props, ctx, modes), ctx),
    ...effectDeclarations(node.type, props),
    ...textDeclarations(node.type, resolvedProps(props, ctx, modes), ctx),
  ];
  if (node.type === "ELLIPSE") declarations.push("border-radius: 50%");
  if (typeof props.opacity === "number") declarations.push(`opacity: ${props.opacity}`);
  if (typeof props.rotation === "number" && props.rotation !== 0) {
    declarations.push("transform-origin: center center", `transform: rotate(${props.rotation}deg)`);
  }
  const blend = blendModeCss(props.blendMode);
  if (blend) declarations.push(`mix-blend-mode: ${blend}`);
  if (props.layoutPositioning === "ABSOLUTE") declarations.push("position: absolute");
  return `#${cssEscape(id)} { ${declarations.filter(Boolean).join("; ")} }`;
}

function positionDeclarations(props: DesignProperties, state: WalkState): string[] {
  if (!state.parent) {
    return [
      "position: absolute",
      `left: calc(${props.position.x}px - var(--cd-origin-x))`,
      `top: calc(${props.position.y}px - var(--cd-origin-y))`
    ];
  }
  if (state.parentHasLayout && props.layoutPositioning !== "ABSOLUTE") return ["position: relative"];
  const left = props.position.x - state.parent.properties.position.x;
  const top = props.position.y - state.parent.properties.position.y;
  return ["position: absolute", `left: ${left}px`, `top: ${top}px`];
}

function sizeDeclarations(props: DesignProperties, state: WalkState): string[] {
  const hugWidth = state.parentHasLayout && props.layoutSizingHorizontal === "HUG";
  const hugHeight = state.parentHasLayout && props.layoutSizingVertical === "HUG";
  const fillWidth = state.parentHasLayout && props.layoutSizingHorizontal === "FILL";
  const fillHeight = state.parentHasLayout && props.layoutSizingVertical === "FILL";
  const declarations: string[] = [];
  if (!hugWidth && !fillWidth) declarations.push(`width: ${finite(props.size.width, 0)}px`);
  if (!hugHeight && !fillHeight) declarations.push(`height: ${finite(props.size.height, 0)}px`);
  return declarations;
}

function resolvedProps(props: DesignProperties, ctx: RenderContext, modes: Record<string, string>): DesignProperties {
  const fills = [...props.styles.fills];
  const strokes = [...props.styles.strokes];
  const refs = props.styleRefs || {};
  if (refs.fill) {
    const style = ctx.styles.get(refs.fill);
    if (style?.paints?.length) fills.splice(0, fills.length, ...style.paints);
  }
  if (refs.stroke) {
    const style = ctx.styles.get(refs.stroke);
    if (style?.paints?.length) strokes.splice(0, strokes.length, ...style.paints);
  }
  const next: DesignProperties = { ...props, styles: { ...props.styles, fills, strokes } };
  const fillBinding = props.bindings?.fill;
  if (fillBinding && !isColorBinding(fillBinding, ctx)) {
    const color = resolveColor(fillBinding, modes, ctx);
    if (color) next.styles = { ...next.styles, fills: [{ type: "SOLID", color, opacity: 1 }, ...fills.slice(1)] };
  }
  const strokeBinding = props.bindings?.stroke;
  if (strokeBinding && !isColorBinding(strokeBinding, ctx)) {
    const color = resolveColor(strokeBinding, modes, ctx);
    if (color) next.styles = { ...next.styles, strokes: [{ type: "SOLID", color, opacity: 1 }, ...strokes.slice(1)] };
  }
  return next;
}

function paintDeclarations(type: string, props: DesignProperties, ctx: RenderContext): string[] {
  const fillBinding = props.bindings?.fill;
  if (fillBinding && isColorBinding(fillBinding, ctx)) {
    const value = `var(--cd-${cssVar(fillBinding)})`;
    if (type === "TEXT") return [`color: ${value}`];
    if (type === "STAR" || type === "POLYGON" || type === "VECTOR" || type === "SVG" || type === "ARC" || type === "LINE") return [];
    return [`background: ${value}`];
  }
  if (type === "TEXT") {
    const color = paintColor(props.styles.fills[0]);
    return color ? [`color: ${color}`] : [];
  }
  if (type === "STAR" || type === "POLYGON" || type === "VECTOR" || type === "SVG" || type === "ARC" || type === "LINE") return [];
  const layers = backgroundLayers(props.styles.fills);
  return layers.length ? [`background: ${layers.join(", ")}`] : [];
}

function effectDeclarations(type: string, props: DesignProperties): string[] {
  const declarations: string[] = [];
  if (type === "TEXT") {
    const shadows = textShadows(props.styles.effects);
    if (shadows.length) declarations.push(`text-shadow: ${shadows.join(", ")}`);
  } else {
    const shadows = effectShadows(props.styles.effects);
    if (shadows.length) declarations.push(`box-shadow: ${shadows.join(", ")}`);
  }
  const blur = blurFilters(props.styles.effects);
  if (blur.filter) declarations.push(`filter: ${blur.filter}`);
  if (blur.backdrop) declarations.push(`backdrop-filter: ${blur.backdrop}`);
  return declarations;
}

function textShadows(effects: DesignProperties["styles"]["effects"]): string[] {
  return effects
    .filter((effect) => effect.visible !== false && effect.type === "DROP_SHADOW")
    .map((effect) => `${finite(effect.offset?.x, 0)}px ${finite(effect.offset?.y, 4)}px ${finite(effect.radius, 8)}px ${cssColor(effect.color)}`);
}

function textDeclarations(type: string, props: DesignProperties, ctx: RenderContext): string[] {
  if (type !== "TEXT") return [];
  const font = textFont(props, ctx);
  const declarations = fontDeclarations(font);
  const lineHeight = lineHeightCss(props.lineHeight);
  const letterSpacing = letterSpacingCss(props.letterSpacing);
  if (lineHeight) declarations.push(`line-height: ${lineHeight}`);
  if (letterSpacing) declarations.push(`letter-spacing: ${letterSpacing}`);
  if (props.alignment) declarations.push(`text-align: ${props.alignment.toLowerCase()}`);
  if (props.verticalAlignment === "CENTER") declarations.push("display: flex", "align-items: center");
  if (props.verticalAlignment === "BOTTOM") declarations.push("display: flex", "align-items: flex-end");
  if (props.textDecoration === "UNDERLINE") declarations.push("text-decoration: underline");
  if (props.textDecoration === "STRIKETHROUGH") declarations.push("text-decoration: line-through");
  const transform = textCaseCss(props.textCase);
  if (transform) declarations.push(`text-transform: ${transform}`);
  if (typeof props.paragraphIndent === "number") declarations.push(`text-indent: ${props.paragraphIndent}px`);
  if (props.textTruncation === "ENDING" || props.textAutoResize === "TRUNCATE") {
    declarations.push("overflow: hidden", "text-overflow: ellipsis", "white-space: nowrap");
  }
  if (typeof props.maxLines === "number") {
    declarations.push("display: -webkit-box", "-webkit-box-orient: vertical", `-webkit-line-clamp: ${props.maxLines}`, "overflow: hidden");
  }
  return declarations;
}

function textFont(props: DesignProperties, ctx: RenderContext): DesignFont | undefined {
  const ref = props.styleRefs?.text;
  if (ref) {
    const style = ctx.styles.get(ref);
    if (style?.font) return style.font;
  }
  return props.font;
}

function textInner(props: DesignProperties, ctx: RenderContext): string {
  if (Array.isArray(props.runs) && props.runs.length) {
    return props.runs.map((run) => {
      if (!isRecord(run)) return "";
      const text = typeof run.text === "string" ? run.text : "";
      const style: string[] = [];
      if (isRecord(run.font)) {
        const font = {
          family: typeof run.font.family === "string" ? run.font.family : "Arial",
          style: typeof run.font.style === "string" ? run.font.style : "Regular",
          size: finite(run.font.size, 16)
        };
        ctx.fonts.add(font.family);
        style.push(...fontDeclarations(font));
      }
      const fill = runFill(run.fill);
      if (fill) style.push(`color: ${fill}`);
      if (run.textDecoration === "UNDERLINE") style.push("text-decoration: underline");
      if (run.textDecoration === "STRIKETHROUGH") style.push("text-decoration: line-through");
      if (isRecord(run.letterSpacing)) {
        const spacing = letterSpacingCss({
          unit: run.letterSpacing.unit === "PERCENT" ? "PERCENT" : "PIXELS",
          value: finite(run.letterSpacing.value, 0)
        });
        if (spacing) style.push(`letter-spacing: ${spacing}`);
      }
      let markup = `<span${style.length ? ` style="${escapeHtml(style.join("; "))}"` : ""}>${escapeHtml(text)}</span>`;
      if (typeof run.link === "string") markup = `<a href="${escapeHtml(run.link)}">${markup}</a>`;
      return markup;
    }).join("");
  }
  return escapeHtml(props.text || "");
}

function runFill(value: unknown): string | undefined {
  if (typeof value === "string" && /^#/.test(value)) return value;
  if (isDesignColor(value)) return cssColor(value);
  if (isRecord(value) && value.type === "SOLID") {
    const paint: DesignPaint = { type: "SOLID", color: isDesignColor(value.color) ? value.color : undefined, opacity: finite(value.opacity, 1) };
    return paintColor(paint);
  }
  return undefined;
}

function boundStrokeDeclarations(props: DesignProperties, ctx: RenderContext): string[] {
  const strokeBinding = props.bindings?.stroke;
  if (strokeBinding && isColorBinding(strokeBinding, ctx)) {
    const color = `var(--cd-${cssVar(strokeBinding)})`;
    const style = props.dashPattern?.length ? "dashed" : "solid";
    const weight = finite(props.strokeWeight, 1);
    if (weight <= 0) return [];
    return [`border: ${weight}px ${style} ${color}`];
  }
  return strokeDeclarations(props);
}

function isColorBinding(key: string, ctx: RenderContext): boolean {
  const ref = ctx.variables.get(key);
  return Boolean(ref && ref.item.type === "COLOR");
}

function cssVar(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function initialBoardModes(document: InternalDocument): Record<string, string> {
  const modes: Record<string, string> = {};
  for (const collection of document.variables) {
    if (collection.modes?.length) modes[collection.name] = collection.modes[0];
    else {
      for (const item of collection.items) {
        if (item.values) {
          const first = Object.keys(item.values)[0];
          if (first) {
            modes[collection.name] = first;
            break;
          }
        }
      }
    }
  }
  const walk = (nodes: InternalNode[]): void => {
    for (const node of nodes) {
      Object.assign(modes, node.properties.variableModes || {});
      walk(node.children);
    }
  };
  walk(document.nodes);
  return modes;
}

function themeCss(document: InternalDocument): string {
  const values: string[] = [];
  const selectors: string[] = [];
  for (const collection of document.variables) {
    const modeNames = collection.modes?.length
      ? collection.modes
      : [...new Set(collection.items.flatMap((item) => item.values ? Object.keys(item.values) : []))];
    if (!modeNames.length) continue;
    const colorItems = collection.items.filter((item) => item.type === "COLOR");
    if (!colorItems.length) continue;
    for (const item of colorItems) {
      const key = cssVar(item.id || item.name);
      for (const mode of modeNames) {
        const raw = item.values?.[mode] ?? item.value;
        if (isDesignColor(raw)) values.push(`--cd-${key}-${cssVar(mode)}: ${cssColor(raw)}`);
      }
    }
    for (const mode of modeNames) {
      const active = colorItems.map((item) => {
        const key = cssVar(item.id || item.name);
        return `--cd-${key}: var(--cd-${key}-${cssVar(mode)})`;
      });
      selectors.push(`.cd-board[data-cd-mode-${cssVar(collection.name)}="${mode}"] { ${active.join("; ")} }`);
    }
  }
  if (!values.length) return "";
  return [`.cd-board { ${values.join("; ")} }`, ...selectors].join("\n");
}

function resolveColor(key: string, modes: Record<string, string>, ctx: RenderContext) {
  const ref = ctx.variables.get(key);
  if (!ref) return undefined;
  const value = resolveVariableValue(ref, modes);
  return isDesignColor(value) ? value : undefined;
}

function resolveVariableValue(ref: VariableRef, modes: Record<string, string>) {
  const mode = modes[ref.collection];
  if (mode && ref.item.values && ref.item.values[mode] !== undefined) return ref.item.values[mode];
  if (ref.item.value !== undefined) return ref.item.value;
  if (ref.item.values) {
    const first = Object.values(ref.item.values)[0];
    if (first !== undefined) return first;
  }
  return undefined;
}

function noteFonts(props: DesignProperties, ctx: RenderContext): void {
  if (props.font?.family) ctx.fonts.add(props.font.family);
  const textStyle = props.styleRefs?.text ? ctx.styles.get(props.styleRefs.text) : undefined;
  if (textStyle?.font?.family) ctx.fonts.add(textStyle.font.family);
  for (const run of props.runs || []) {
    if (isRecord(run) && isRecord(run.font) && typeof run.font.family === "string") ctx.fonts.add(run.font.family);
  }
}

function prototypeLink(value: DesignProperties["prototype"], ctx: RenderContext, sourceId: string): PrototypeLink {
  if (!Array.isArray(value) || !value.length) return {};
  const reaction = isRecord(value[0]) ? value[0] : undefined;
  if (!reaction) return {};
  const trigger = isRecord(reaction.trigger) ? reaction.trigger : {};
  const actions = Array.isArray(reaction.actions) ? reaction.actions : [];
  if (!actions.some(isRecord)) return {};
  const triggerType = String(trigger.type || "ON_CLICK").toUpperCase();
  const link: PrototypeLink = {};
  for (const candidate of actions.filter(isRecord)) {
    const type = String(candidate.type || "").toUpperCase();
    if (type === "SET_VARIABLE_MODE" && triggerType !== "AFTER_TIMEOUT") {
      const collection = typeof candidate.collection === "string" ? candidate.collection
        : typeof candidate.variableCollectionId === "string" ? candidate.variableCollectionId : "";
      const mode = typeof candidate.mode === "string" ? candidate.mode
        : typeof candidate.variableModeId === "string" ? candidate.variableModeId : "";
      if (collection && mode) link.setMode = { collection, mode };
      continue;
    }
    if (type === "URL" && typeof candidate.url === "string" && !link.href) link.href = candidate.url;
    if (type === "BACK") {
      link.href = link.href || "#";
      link.back = true;
    }
    if ((type === "NAVIGATE" || type === "SWAP" || type === "OVERLAY") && typeof candidate.destination === "string") {
      if (triggerType === "AFTER_TIMEOUT") {
        const seconds = finite(trigger.timeout, 1);
        ctx.timeouts.push({ id: sourceId, seconds, destination: candidate.destination });
        link.timeout = { seconds, destination: candidate.destination };
      } else if (!link.href) {
        link.href = `#${htmlId(candidate.destination)}`;
      }
    }
  }
  return link;
}

function shapeFill(props: DesignProperties, ctx: RenderContext): string {
  const fillBinding = props.bindings?.fill;
  if (fillBinding && isColorBinding(fillBinding, ctx)) return `var(--cd-${cssVar(fillBinding)})`;
  return paintColor(props.styles.fills[0]) || "currentColor";
}

function shapeStroke(props: DesignProperties, ctx: RenderContext): string | undefined {
  const strokeBinding = props.bindings?.stroke;
  if (strokeBinding && isColorBinding(strokeBinding, ctx)) return `var(--cd-${cssVar(strokeBinding)})`;
  return paintColor(props.styles.strokes[0]);
}

function shapeMarkup(type: string, props: DesignProperties, ctx: RenderContext): string {
  const fill = shapeFill(props, ctx);
  if (type === "ELLIPSE") {
    return "";
  }
  if (type === "ARC") {
    const width = Math.max(1, finite(props.size.width, 1));
    const height = Math.max(1, finite(props.size.height, 1));
    const d = arcPath(width, height, finite(props.startingAngle, 0), finite(props.endingAngle, Math.PI * 1.5), finite(props.innerRadiusRatio, 0));
    const stroke = shapeStroke(props, ctx);
    const strokeAttrs = stroke ? ` stroke="${escapeHtml(stroke)}" stroke-width="${finite(props.strokeWeight, 1)}"` : "";
    return `<svg class="cd-shape" viewBox="0 0 ${width} ${height}" overflow="visible" aria-hidden="true"><path d="${d}" fill-rule="evenodd" fill="${escapeHtml(fill)}"${strokeAttrs}/></svg>`;
  }
  if (type === "POLYGON" || type === "STAR") {
    const width = Math.max(1, finite(props.size.width, 1));
    const height = Math.max(1, finite(props.size.height, 1));
    const points = regularPolygon(width / 2, height / 2, Math.min(width, height) / 2, finite(props.pointCount, type === "STAR" ? 5 : 6), type === "STAR" ? finite(props.innerRadius, 0.5) : undefined);
    return `<svg class="cd-shape" viewBox="0 0 ${width} ${height}" aria-hidden="true"><polygon points="${points}" fill="${escapeHtml(fill)}"/></svg>`;
  }
  if (type === "VECTOR" && props.vectorPaths?.length) {
    const width = Math.max(1, finite(props.size.width, 1));
    const height = Math.max(1, finite(props.size.height, 1));
    const paths = props.vectorPaths.map((path) => `<path d="${escapeHtml(path.data)}" fill-rule="${path.windingRule === "EVENODD" ? "evenodd" : "nonzero"}" fill="${escapeHtml(fill)}"/>`).join("");
    return `<svg class="cd-shape" viewBox="0 0 ${width} ${height}" aria-hidden="true">${paths}</svg>`;
  }
  if (type === "LINE") {
    const width = Math.max(1, finite(props.size.width, 1));
    const height = Math.max(1, finite(props.size.height, 1));
    const horizontal = width >= height;
    const x1 = horizontal ? 0 : width / 2;
    const y1 = horizontal ? height / 2 : 0;
    const x2 = horizontal ? width : width / 2;
    const y2 = horizontal ? height / 2 : height;
    const stroke = shapeStroke(props, ctx) || fill;
    const weight = finite(props.strokeWeight, 1);
    const attrs = [
      `x1="${x1}"`,
      `y1="${y1}"`,
      `x2="${x2}"`,
      `y2="${y2}"`,
      `stroke="${escapeHtml(stroke)}"`,
      `stroke-width="${weight}"`
    ];
    if (props.dashPattern?.length) attrs.push(`stroke-dasharray="${props.dashPattern.map((n) => finite(n, 0)).join(" ")}"`);
    const linecap = strokeLinecapCss(props.strokeCap);
    if (linecap) attrs.push(`stroke-linecap="${linecap}"`);
    return `<svg class="cd-shape" viewBox="0 0 ${width} ${height}" overflow="visible" aria-hidden="true"><line ${attrs.join(" ")}/></svg>`;
  }
  return "";
}

function strokeLinecapCss(cap: string | undefined): string | undefined {
  if (cap === "ROUND") return "round";
  if (cap === "SQUARE") return "square";
  if (cap === "NONE") return "butt";
  return undefined;
}

function fontLinks(families: Set<string>): string {
  const custom = [...families].filter((family) => !isWebSafeFont(family));
  if (!custom.length) return "";
  const query = custom.map((family) => `family=${encodeURIComponent(family)}:wght@400;500;600;700`).join("&");
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?${query}&display=swap" rel="stylesheet">`;
}

function runtimeScript(_timeouts: RenderContext["timeouts"]): string {
  return `<script>
(() => {
  document.querySelectorAll("[data-cd-set-mode]").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.preventDefault();
      const collection = (node.getAttribute("data-cd-set-collection") || "").replace(/[^a-zA-Z0-9_-]+/g, "-");
      const mode = node.getAttribute("data-cd-set-mode");
      const board = node.closest(".cd-board");
      if (!board || !collection || !mode) return;
      board.setAttribute("data-cd-mode-" + collection, mode);
    });
  });
  document.querySelectorAll("[data-cd-timeout]").forEach((node) => {
    const seconds = Number(node.getAttribute("data-cd-timeout"));
    const destination = node.getAttribute("data-cd-navigate");
    if (!destination) return;
    setTimeout(() => { location.hash = destination; }, Math.max(0, seconds) * 1000);
  });
  document.querySelectorAll("[data-cd-back]").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.preventDefault();
      history.back();
    });
  });
})();
</script>`;
}

