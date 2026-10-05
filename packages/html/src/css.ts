import type { DesignColor, DesignEffect, DesignFont, DesignPaint, DesignProperties, LetterSpacing, LineHeight } from "@compact-design/core";

const WEB_SAFE = new Set([
  "Arial", "Helvetica", "Times", "Times New Roman", "Courier", "Courier New",
  "Georgia", "Verdana", "Tahoma", "Trebuchet MS", "Impact", "Comic Sans MS", "system-ui", "sans-serif", "serif", "monospace"
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isDesignColor(value: unknown): value is DesignColor {
  return isRecord(value) && typeof value.r === "number" && typeof value.g === "number" && typeof value.b === "number";
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function htmlId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `n-${cleaned || "node"}`;
}

export function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

export function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function cssColor(value: DesignColor | undefined, opacity = 1): string {
  if (!value) return `rgba(0, 0, 0, ${opacity})`;
  const channel = (input: unknown) => {
    const n = finite(input, 0);
    return Math.round(n > 1 && n <= 255 ? n : n * 255);
  };
  const alpha = finite(value.a, 1) * opacity;
  return `rgba(${channel(value.r)}, ${channel(value.g)}, ${channel(value.b)}, ${alpha})`;
}

export function paintColor(paint: DesignPaint | undefined): string | undefined {
  if (!paint || paint.type !== "SOLID" || !paint.color) return undefined;
  return cssColor(paint.color, finite(paint.opacity, 1));
}

function gradientAngle(paint: DesignPaint): number {
  const transform = paint.gradientTransform;
  if (!transform) return 90;
  const cosine = transform[0]?.[0] ?? 1;
  const sine = transform[0]?.[1] ?? 0;
  const compact = Math.atan2(sine, cosine) * 180 / Math.PI;
  return compact + 90;
}

function gradientStops(paint: DesignPaint): string {
  const stops = paint.gradientStops || [];
  if (!stops.length) return `${cssColor(paint.color)}, ${cssColor(paint.color)}`;
  return stops.map((stop) => `${cssColor(stop.color)} ${Math.round(finite(stop.position, 0) * 1000) / 10}%`).join(", ");
}

export function backgroundLayers(paints: DesignPaint[]): string[] {
  const layers: string[] = [];
  for (const paint of [...paints].reverse()) {
    if (paint.type === "SOLID" && paint.color) layers.push(`linear-gradient(${cssColor(paint.color, finite(paint.opacity, 1))}, ${cssColor(paint.color, finite(paint.opacity, 1))})`);
    else if (paint.type === "GRADIENT_LINEAR") layers.push(`linear-gradient(${gradientAngle(paint)}deg, ${gradientStops(paint)})`);
    else if (paint.type === "GRADIENT_RADIAL" || paint.type === "GRADIENT_DIAMOND") layers.push(`radial-gradient(circle, ${gradientStops(paint)})`);
    else if (paint.type === "GRADIENT_ANGULAR") layers.push(`conic-gradient(${gradientStops(paint)})`);
    else if (paint.type === "IMAGE" && paint.src) {
      const size = paint.scaleMode === "FIT" ? "contain" : paint.scaleMode === "TILE" ? "auto" : "cover";
      const repeat = paint.scaleMode === "TILE" ? "repeat" : "no-repeat";
      layers.push(`url(${JSON.stringify(paint.src)}) ${repeat} center / ${size}`);
    }
  }
  return layers;
}

export function fontWeight(style: string): number {
  const value = style.toLowerCase();
  if (value.includes("thin")) return 100;
  if (value.includes("extralight") || value.includes("ultralight")) return 200;
  if (value.includes("light")) return 300;
  if (value.includes("medium")) return 500;
  if (value.includes("semibold") || value.includes("demibold")) return 600;
  if (value.includes("extrabold") || value.includes("ultrabold")) return 800;
  if (value.includes("black") || value.includes("heavy")) return 900;
  if (value.includes("bold")) return 700;
  return 400;
}

export function isItalic(style: string): boolean {
  return /italic|oblique/i.test(style);
}

export function quoteFont(family: string): string {
  return /[^a-zA-Z0-9-]/.test(family) ? `"${family.replace(/"/g, '\\"')}"` : family;
}

export function isWebSafeFont(family: string): boolean {
  return WEB_SAFE.has(family);
}

export function fontDeclarations(font: DesignFont | undefined): string[] {
  if (!font) return [];
  const declarations = [
    `font-family: ${quoteFont(font.family)}, sans-serif`,
    `font-size: ${finite(font.size, 16)}px`,
    `font-weight: ${fontWeight(font.style)}`
  ];
  if (isItalic(font.style)) declarations.push("font-style: italic");
  return declarations;
}

export function lineHeightCss(value: LineHeight | undefined): string | undefined {
  if (!value || value.unit === "AUTO") return undefined;
  if (value.unit === "PIXELS") return `${finite(value.value, 0)}px`;
  return String(finite(value.value, 100) / 100);
}

export function letterSpacingCss(value: LetterSpacing | undefined): string | undefined {
  if (!value) return undefined;
  if (value.unit === "PERCENT") return `${finite(value.value, 0) / 100}em`;
  return `${finite(value.value, 0)}px`;
}

export function effectShadows(effects: DesignEffect[]): string[] {
  const shadows: string[] = [];
  for (const effect of effects) {
    if (effect.visible === false) continue;
    if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
      const inset = effect.type === "INNER_SHADOW" ? "inset " : "";
      shadows.push(`${inset}${finite(effect.offset?.x, 0)}px ${finite(effect.offset?.y, 4)}px ${finite(effect.radius, 8)}px ${finite(effect.spread, 0)}px ${cssColor(effect.color)}`);
    }
  }
  return shadows;
}

export function blurFilters(effects: DesignEffect[]): { filter?: string; backdrop?: string } {
  const layer = effects.filter((effect) => effect.visible !== false && effect.type === "LAYER_BLUR");
  const backdrop = effects.filter((effect) => effect.visible !== false && effect.type === "BACKGROUND_BLUR");
  return {
    filter: layer.length ? layer.map((effect) => `blur(${finite(effect.radius, 8)}px)`).join(" ") : undefined,
    backdrop: backdrop.length ? backdrop.map((effect) => `blur(${finite(effect.radius, 8)}px)`).join(" ") : undefined
  };
}

const ALIGN: Record<string, string> = {
  MIN: "flex-start",
  MAX: "flex-end",
  CENTER: "center",
  SPACE_BETWEEN: "space-between",
  BASELINE: "baseline",
  STRETCH: "stretch"
};

export function layoutDeclarations(props: DesignProperties): string[] {
  const layout = props.layout;
  if (!layout?.direction) return [];
  const declarations: string[] = [];
  if (layout.direction === "GRID") {
    declarations.push("display: grid");
    if (typeof layout.itemSpacing === "number") declarations.push(`gap: ${layout.itemSpacing}px`);
  } else {
    declarations.push("display: flex");
    declarations.push(`flex-direction: ${layout.direction === "HORIZONTAL" ? "row" : "column"}`);
    if (layout.wrap) declarations.push("flex-wrap: wrap");
    declarations.push(`justify-content: ${ALIGN[layout.primaryAxisAlignItems || "MIN"] || "flex-start"}`);
    declarations.push(`align-items: ${ALIGN[layout.counterAxisAlignItems || "MIN"] || "flex-start"}`);
    if (typeof layout.itemSpacing === "number") declarations.push(`gap: ${layout.itemSpacing}px`);
    if (typeof layout.counterAxisSpacing === "number" && layout.wrap) declarations.push(`row-gap: ${layout.counterAxisSpacing}px`);
  }
  const padding = layout.padding;
  if (padding) {
    declarations.push(`padding: ${finite(padding.top, 0)}px ${finite(padding.right, 0)}px ${finite(padding.bottom, 0)}px ${finite(padding.left, 0)}px`);
  }
  return declarations;
}

export function childSizingDeclarations(props: DesignProperties, parentDirection: "HORIZONTAL" | "VERTICAL" | "GRID" | undefined): string[] {
  if (!parentDirection) return [];
  const declarations: string[] = [];
  const horizontal = props.layoutSizingHorizontal;
  const vertical = props.layoutSizingVertical;
  if (parentDirection === "HORIZONTAL") {
    if (horizontal === "FILL") declarations.push("flex: 1 1 0", "min-width: 0");
    else if (horizontal === "HUG") declarations.push("flex: 0 0 auto", "width: auto");
    if (vertical === "FILL") declarations.push("align-self: stretch", "height: auto");
    else if (vertical === "HUG") declarations.push("height: auto");
  } else if (parentDirection === "VERTICAL") {
    if (vertical === "FILL") declarations.push("flex: 1 1 0", "min-height: 0");
    else if (vertical === "HUG") declarations.push("flex: 0 0 auto", "height: auto");
    if (horizontal === "FILL") declarations.push("align-self: stretch", "width: auto");
    else if (horizontal === "HUG") declarations.push("width: auto");
  }
  if (typeof props.layoutGrow === "number") declarations.push(`flex-grow: ${props.layoutGrow}`);
  if (props.layoutAlign === "STRETCH") declarations.push("align-self: stretch");
  if (typeof props.minWidth === "number") declarations.push(`min-width: ${props.minWidth}px`);
  if (typeof props.maxWidth === "number") declarations.push(`max-width: ${props.maxWidth}px`);
  if (typeof props.minHeight === "number") declarations.push(`min-height: ${props.minHeight}px`);
  if (typeof props.maxHeight === "number") declarations.push(`max-height: ${props.maxHeight}px`);
  return declarations;
}

export function overflowDeclarations(props: DesignProperties): string[] {
  if (props.clipsContent) return ["overflow: hidden"];
  if (props.overflowDirection === "HORIZONTAL") return ["overflow-x: auto", "overflow-y: hidden"];
  if (props.overflowDirection === "VERTICAL") return ["overflow-x: hidden", "overflow-y: auto"];
  if (props.overflowDirection === "BOTH") return ["overflow: auto"];
  return [];
}

/** True when overflowDirection is a scrolling mode after core normalize. */
export function isScrollingOverflow(direction: DesignProperties["overflowDirection"]): direction is "HORIZONTAL" | "VERTICAL" | "BOTH" {
  return direction === "HORIZONTAL" || direction === "VERTICAL" || direction === "BOTH";
}

/** Clamp numberOfFixedChildren to [0, childCount], matching Figma import. */
export function clampedFixedChildCount(value: unknown, childCount: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || childCount <= 0) return 0;
  return Math.max(0, Math.min(childCount, Math.round(value)));
}

/**
 * Sticky pin for the last N children of a scrolling frame (numberOfFixedChildren).
 * Vertical → bottom; horizontal → right; BOTH → bottom+right (v1).
 */
export function fixedChildStickyDeclarations(overflow: "HORIZONTAL" | "VERTICAL" | "BOTH"): string[] {
  if (overflow === "VERTICAL") return ["position: sticky", "bottom: 0"];
  if (overflow === "HORIZONTAL") return ["position: sticky", "right: 0"];
  return ["position: sticky", "bottom: 0", "right: 0"];
}

export function radiusDeclarations(props: DesignProperties): string[] {
  if (Array.isArray(props.cornerRadii) && props.cornerRadii.length === 4) {
    return [`border-radius: ${props.cornerRadii.map((value) => `${finite(value, 0)}px`).join(" ")}`];
  }
  if (typeof props.cornerRadius === "number") return [`border-radius: ${props.cornerRadius}px`];
  return [];
}

export function strokeDeclarations(props: DesignProperties, colorOverride?: string): string[] {
  const color = colorOverride ?? paintColor(props.styles.strokes[0]);
  if (!color) return [];
  const style = props.dashPattern?.length ? "dashed" : "solid";
  const align = props.strokeAlign;
  const sides = [
    ["border-top-width", props.strokeTopWeight],
    ["border-right-width", props.strokeRightWeight],
    ["border-bottom-width", props.strokeBottomWeight],
    ["border-left-width", props.strokeLeftWeight]
  ] as const;
  const perSide = sides.some(([, value]) => typeof value === "number");
  // Per-side weights only map cleanly to CSS border; OUTSIDE/CENTER stay on border.
  if (perSide) {
    const declarations = [`border-style: ${style}`, `border-color: ${color}`, "border-width: 0"];
    for (const [property, value] of sides) if (typeof value === "number") declarations.push(`${property}: ${value}px`);
    return declarations;
  }
  const weight = finite(props.strokeWeight, 1);
  if (weight <= 0) return [];
  // INSIDE (and unset): CSS border under border-box — matches prior HTML behaviour.
  if (align === "OUTSIDE") {
    // Spread box-shadow sits outside without shrinking content. Dashed OUTSIDE
    // stays solid here — CSS shadows cannot cheaply reproduce dashPattern.
    return [`box-shadow: 0 0 0 ${weight}px ${color}`];
  }
  if (align === "CENTER") {
    // Approximate CENTER: half the weight as inside border + half as outer shadow.
    // Not pixel-perfect Figma, but keeps the stroke straddling the box edge.
    const half = weight / 2;
    return [`border: ${half}px ${style} ${color}`, `box-shadow: 0 0 0 ${half}px ${color}`];
  }
  return [`border: ${weight}px ${style} ${color}`];
}

/** Collapse duplicate box-shadow declarations so stroke outlines coexist with effects. */
export function coalesceBoxShadows(declarations: string[]): string[] {
  const shadows: string[] = [];
  const rest: string[] = [];
  for (const declaration of declarations) {
    const match = /^box-shadow:\s*(.+)$/i.exec(declaration);
    if (match) shadows.push(match[1]);
    else rest.push(declaration);
  }
  if (shadows.length) rest.push(`box-shadow: ${shadows.join(", ")}`);
  return rest;
}

export function blendModeCss(value: string | undefined): string | undefined {
  if (!value || value === "PASS_THROUGH" || value === "NORMAL") return undefined;
  return value.toLowerCase().replace(/_/g, "-");
}

export function textCaseCss(value: string | undefined): string | undefined {
  if (value === "UPPER") return "uppercase";
  if (value === "LOWER") return "lowercase";
  if (value === "TITLE") return "capitalize";
  return undefined;
}

export function sanitizeSvg(markup: string): string {
  return markup
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

export function regularPolygon(cx: number, cy: number, radius: number, points: number, innerRatio?: number): string {
  const count = Math.max(3, Math.round(points));
  const coords: string[] = [];
  const steps = innerRatio === undefined ? count : count * 2;
  for (let index = 0; index < steps; index += 1) {
    const ratio = innerRatio === undefined || index % 2 === 0 ? 1 : innerRatio;
    const angle = -Math.PI / 2 + index * Math.PI * 2 / steps;
    coords.push(`${cx + radius * ratio * Math.cos(angle)},${cy + radius * ratio * Math.sin(angle)}`);
  }
  return coords.join(" ");
}

const TURN = Math.PI * 2;

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** SVG path for a Figma-style arc: radians from 3 o'clock, sweeping clockwise from start to end. */
export function arcPath(width: number, height: number, startingAngle: number, endingAngle: number, innerRadiusRatio: number): string {
  const rx = width / 2;
  const ry = height / 2;
  const ratio = Math.min(1, Math.max(0, innerRadiusRatio));
  let sweep = endingAngle - startingAngle;
  if (sweep < 0) sweep = sweep % TURN + TURN;
  const point = (angle: number, scale: number) => `${round(rx + rx * scale * Math.cos(angle))} ${round(ry + ry * scale * Math.sin(angle))}`;
  const ellipse = (scale: number) => {
    const r = `${round(rx * scale)} ${round(ry * scale)}`;
    return `M ${point(startingAngle, scale)} A ${r} 0 1 1 ${point(startingAngle + Math.PI, scale)} A ${r} 0 1 1 ${point(startingAngle, scale)} Z`;
  };
  if (sweep === 0 || sweep >= TURN) return ratio > 0 ? `${ellipse(1)} ${ellipse(ratio)}` : ellipse(1);
  const end = startingAngle + sweep;
  const large = sweep > Math.PI ? 1 : 0;
  const outer = `M ${point(startingAngle, 1)} A ${round(rx)} ${round(ry)} 0 ${large} 1 ${point(end, 1)}`;
  if (ratio === 0) return `${outer} L ${round(rx)} ${round(ry)} Z`;
  return `${outer} L ${point(end, ratio)} A ${round(rx * ratio)} ${round(ry * ratio)} 0 ${large} 0 ${point(startingAngle, ratio)} Z`;
}

export interface LayoutGridLayer {
  image: string;
  size: string;
  position: string;
  repeat: string;
}

function layoutGridColor(color: unknown): string {
  if (isDesignColor(color)) return cssColor(color);
  return cssColor({ r: 0, g: 0, b: 0, a: 0.1 });
}

/** Background layers for visible layoutGrids (GRID lattice, COLUMNS / ROWS bands). */
export function layoutGridLayers(grids: unknown): LayoutGridLayer[] {
  if (!Array.isArray(grids)) return [];
  const layers: LayoutGridLayer[] = [];
  for (const grid of grids) {
    if (!isRecord(grid) || grid.visible === false) continue;
    const color = layoutGridColor(grid.color);
    if (grid.pattern === "GRID") {
      const size = Math.max(1, finite(grid.sectionSize, 8));
      for (const angle of [0, 90] as const) {
        layers.push({
          image: `repeating-linear-gradient(${angle}deg, ${color} 0, ${color} 1px, transparent 1px, transparent ${size}px)`,
          size: "auto",
          position: "0 0",
          repeat: "repeat"
        });
      }
      continue;
    }
    if (grid.pattern === "COLUMNS" || grid.pattern === "ROWS") {
      const layer = rowsColsGridLayer(grid.pattern, grid, color);
      if (layer) layers.push(layer);
    }
  }
  return layers;
}

function rowsColsGridLayer(pattern: "COLUMNS" | "ROWS", grid: Record<string, unknown>, color: string): LayoutGridLayer | undefined {
  const count = Math.max(1, Math.round(finite(grid.count, 12)));
  const gutter = Math.max(0, finite(grid.gutterSize, 20));
  const offset = Math.max(0, finite(grid.offset, 0));
  const alignment = typeof grid.alignment === "string" ? grid.alignment : "STRETCH";
  const horizontal = pattern === "COLUMNS";
  const axis = horizontal ? "to right" : "to bottom";

  if (alignment === "STRETCH") {
    // Gradient box is already inset by offset via background-size/position.
    const section = `(100% - ${(count - 1) * gutter}px) / ${count}`;
    return {
      image: `repeating-linear-gradient(${axis}, ${color} 0, ${color} calc(${section}), transparent calc(${section}), transparent calc(${section} + ${gutter}px))`,
      size: horizontal ? `calc(100% - ${2 * offset}px) 100%` : `100% calc(100% - ${2 * offset}px)`,
      position: horizontal ? `${offset}px 0` : `0 ${offset}px`,
      repeat: "no-repeat"
    };
  }

  const sectionSize = Math.max(1, finite(grid.sectionSize, 64));
  const span = count * sectionSize + Math.max(0, count - 1) * gutter;
  const image = `repeating-linear-gradient(${axis}, ${color} 0, ${color} ${sectionSize}px, transparent ${sectionSize}px, transparent ${sectionSize + gutter}px)`;
  const size = horizontal ? `${span}px 100%` : `100% ${span}px`;

  if (alignment === "MAX") {
    return {
      image,
      size,
      position: horizontal
        ? `calc(100% - ${offset}px - ${span}px) 0`
        : `0 calc(100% - ${offset}px - ${span}px)`,
      repeat: "no-repeat"
    };
  }
  if (alignment === "CENTER") {
    return { image, size, position: "center", repeat: "no-repeat" };
  }
  // MIN (Left / Top)
  return {
    image,
    size,
    position: horizontal ? `${offset}px 0` : `0 ${offset}px`,
    repeat: "no-repeat"
  };
}

/**
 * Non-interactive ::after overlay declarations for visible layoutGrids.
 * Does not affect layout or hit-testing (pointer-events: none, absolute).
 */
export function layoutGridOverlayDeclarations(grids: unknown): string[] {
  const layers = layoutGridLayers(grids);
  if (!layers.length) return [];
  return [
    'content: ""',
    "position: absolute",
    "inset: 0",
    "pointer-events: none",
    "border-radius: inherit",
    "z-index: 9999",
    `background-image: ${layers.map((layer) => layer.image).join(", ")}`,
    `background-size: ${layers.map((layer) => layer.size).join(", ")}`,
    `background-position: ${layers.map((layer) => layer.position).join(", ")}`,
    `background-repeat: ${layers.map((layer) => layer.repeat).join(", ")}`
  ];
}
