export type JsonObject = Record<string, unknown>;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type Transform = [[number, number, number], [number, number, number]];
export interface LineHeight { unit: "AUTO" | "PIXELS" | "PERCENT"; value?: number; }
export interface LetterSpacing { unit: "PIXELS" | "PERCENT"; value: number; }
export interface VectorPath { windingRule: "NONZERO" | "EVENODD" | "NONE"; data: string; }
export interface VariableAlias { type: "VARIABLE_ALIAS"; id: string; }
export interface Constraints { horizontal: "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE"; vertical: "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE"; }
/** Authorable component property types. VARIANT axes use variantAxes/variant on COMPONENT_SET instead; Figma SLOT is out of scope. */
export type ComponentPropertyType = "BOOLEAN" | "TEXT" | "INSTANCE_SWAP";
export interface ComponentPropertyOptions { preferredValues?: Array<{ type: "COMPONENT" | "COMPONENT_SET"; key: string }>; }
/** Child-layer links to the nearest ancestor COMPONENT's componentProperties (Figma componentPropertyReferences). Values are authored property names. */
export interface ComponentPropertyReferences { characters?: string; visible?: string; mainComponent?: string; }
export type OverflowDirection = "NONE" | "HORIZONTAL" | "VERTICAL" | "BOTH";
export type BlendMode = "PASS_THROUGH" | "NORMAL" | "DARKEN" | "MULTIPLY" | "LINEAR_BURN" | "COLOR_BURN" | "LIGHTEN" | "SCREEN" | "LINEAR_DODGE" | "COLOR_DODGE" | "OVERLAY" | "SOFT_LIGHT" | "HARD_LIGHT" | "DIFFERENCE" | "EXCLUSION" | "HUE" | "SATURATION" | "COLOR" | "LUMINOSITY";
export type StrokeCap = "NONE" | "ROUND" | "SQUARE" | "LINE_ARROW" | "TRIANGLE_ARROW" | "DIAMOND_FILLED" | "CIRCLE_FILLED" | "TRIANGLE_FILLED" | "WASHI_TAPE_1" | "WASHI_TAPE_2" | "WASHI_TAPE_3" | "WASHI_TAPE_4" | "WASHI_TAPE_5" | "WASHI_TAPE_6";
export type StrokeJoin = "MITER" | "BEVEL" | "ROUND";
export type TextDecoration = "NONE" | "UNDERLINE" | "STRIKETHROUGH";
export type TextCase = "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" | "SMALL_CAPS" | "SMALL_CAPS_FORCED";

export interface DesignColor { r: number; g: number; b: number; a?: number; }
export interface DesignPoint { x: number; y: number; }
export interface DesignSize { width: number; height: number; }
export interface DesignFont { family: string; style: string; size: number; }
export interface DesignPaint {
  type: string; color?: DesignColor; opacity?: number; src?: string; bytes?: Uint8Array;
  sourceWidth?: number; sourceHeight?: number; resizedWidth?: number; resizedHeight?: number;
  scaleMode?: string; imageTransform?: Transform; gradientTransform?: Transform;
  gradientStops?: Array<{ position: number; color: DesignColor }>;
}
export interface DesignEffect {
  type: string; color?: DesignColor; offset?: DesignPoint; radius?: number; spread?: number; visible?: boolean; blendMode?: string;
  showShadowBehindNode?: boolean; blurType?: string; startRadius?: number; startOffset?: DesignPoint; endOffset?: DesignPoint;
  noiseType?: string; noiseSize?: number; density?: number; secondaryColor?: DesignColor; opacity?: number; clipToShape?: boolean;
  lightIntensity?: number; lightAngle?: number; refraction?: number; depth?: number; dispersion?: number;
  /** SHADER only: Figma shader id (from listAvailableShaders / importShaderById). */
  id?: string;
  /** SHADER only: property assignments keyed by property-definition id, passed through verbatim. */
  properties?: Record<string, JsonValue>;
}
export interface DesignStyles { fills: DesignPaint[]; strokes: DesignPaint[]; effects: DesignEffect[]; }
export interface DesignLayout {
  direction?: "HORIZONTAL" | "VERTICAL" | "GRID"; itemSpacing?: number; counterAxisSpacing?: number;
  padding?: { left?: number; top?: number; right?: number; bottom?: number };
  primaryAxisAlignItems?: string; counterAxisAlignItems?: string; primaryAxisSizingMode?: string; counterAxisSizingMode?: string; wrap?: boolean;
}
export interface DesignProperties {
  position: DesignPoint; size: DesignSize; rotation: number; styles: DesignStyles;
  text?: string; font?: DesignFont; lineHeight?: LineHeight; alignment?: string; letterSpacing?: LetterSpacing;
  runs?: JsonObject[]; layout?: DesignLayout; prototype?: JsonObject[]; bindings?: Record<string, string>; styleRefs?: Record<string, string>;
  variableModes?: Record<string, string>; breakpoint?: JsonObject; componentId?: string; variantAxes?: Record<string, string[]>; variant?: Record<string, string>;
  svg?: string; vectorPaths?: VectorPath[]; pointCount?: number; innerRadius?: number; startingAngle?: number; endingAngle?: number; innerRadiusRatio?: number;
  componentProperties?: Array<{ name: string; type: ComponentPropertyType; defaultValue: string | boolean; options?: ComponentPropertyOptions }>;
  instanceProperties?: Record<string, string | boolean | VariableAlias>;
  componentPropertyReferences?: ComponentPropertyReferences; operation?: "UNION" | "SUBTRACT" | "INTERSECT" | "EXCLUDE";
  overflowDirection?: OverflowDirection; numberOfFixedChildren?: number; layoutGrids?: JsonObject[];
  cornerRadius?: number; cornerRadii?: number[]; opacity?: number; blendMode?: BlendMode; visible?: boolean; locked?: boolean; isMask?: boolean; clipsContent?: boolean;
  constraints?: Constraints; layoutSizingHorizontal?: "FIXED" | "HUG" | "FILL"; layoutSizingVertical?: "FIXED" | "HUG" | "FILL"; layoutAlign?: "INHERIT" | "STRETCH"; layoutGrow?: number; layoutPositioning?: "AUTO" | "ABSOLUTE";
  minWidth?: number | null; maxWidth?: number | null; minHeight?: number | null; maxHeight?: number | null;
  strokeWeight?: number; strokeTopWeight?: number; strokeRightWeight?: number; strokeBottomWeight?: number; strokeLeftWeight?: number;
  strokeAlign?: "INSIDE" | "OUTSIDE" | "CENTER"; strokeCap?: StrokeCap; strokeJoin?: StrokeJoin; dashPattern?: number[];
  textAutoResize?: "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT" | "TRUNCATE"; textDecoration?: TextDecoration; paragraphSpacing?: number; paragraphIndent?: number; listSpacing?: number;
  hangingPunctuation?: boolean; hangingList?: boolean; textCase?: TextCase; verticalAlignment?: "TOP" | "CENTER" | "BOTTOM";
  textTruncation?: "DISABLED" | "ENDING"; maxLines?: number | null;
}

export interface VariableDefinition { id?: string; name: string; type: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN"; value?: JsonValue | DesignColor; values?: Record<string, JsonValue | DesignColor>; }
export interface VariableCollectionDefinition { name: string; modes?: string[]; items: VariableDefinition[]; }
export interface StyleDefinition { id?: string; name: string; type: "PAINT" | "TEXT"; paints?: DesignPaint[]; font?: DesignFont; lineHeight?: LineHeight | number; letterSpacing?: LetterSpacing; paragraphSpacing?: number; }

export interface CompactDocument extends JsonObject {
  canvas?: CompactCanvas;
  canvases?: CompactCanvas[];
  nodes?: CompactNode[];
  styles?: JsonObject[];
  variables?: JsonObject[];
}

export interface CompactCanvas extends JsonObject {
  id?: string;
  name?: string;
  x?: number;
  y?: number;
  width: number;
  height: number;
  fill?: unknown;
  nodes?: CompactNode[];
  breakpoint?: JsonObject;
}

export interface CompactNode extends JsonObject {
  id?: string;
  name?: string;
  type?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  children?: CompactNode[];
}

export interface InternalNode {
  id: string;
  name: string;
  type: string;
  properties: DesignProperties;
  children: InternalNode[];
}

export interface InternalDocument {
  nodes: InternalNode[];
  styles: StyleDefinition[];
  variables: VariableCollectionDefinition[];
}

export type ImportMode = "CREATE" | "REPLACE" | "UPDATE";

/**
 * Normalized values of a patch `set`, independent of the target type. Only
 * keys present in the authored set appear here: no defaults are added.
 * Coordinates are parent-relative (the authoring convention).
 */
export interface ComponentPropertyPatchEntry {
  type?: ComponentPropertyType;
  defaultValue?: string | boolean;
  options?: ComponentPropertyOptions;
}

/** variantAxes patch value: string[] replaces options (never renames); object form renames explicitly. */
export type VariantAxisPatchEntry =
  | null
  | string[]
  | { rename?: string; options?: string[]; renameOptions?: Record<string, string> };

export interface PatchSetValues extends Omit<Partial<DesignProperties>, "position" | "size" | "styles" | "font" | "constraints" | "layout" | "bindings" | "styleRefs" | "variableModes" | "instanceProperties" | "componentPropertyReferences" | "componentProperties" | "variantAxes" | "variant"> {
  name?: string;
  position?: { x?: number; y?: number };
  size?: { width?: number; height?: number };
  styles?: { fills?: DesignPaint[]; strokes?: DesignPaint[]; effects?: DesignEffect[] };
  font?: Partial<DesignFont>;
  constraints?: Partial<Constraints>;
  layout?: DesignLayout;
  /** Shallow-merge; field `null` clears that entry; whole-key `null` clears the map. */
  bindings?: Record<string, string | null> | null;
  styleRefs?: Record<string, string | null> | null;
  variableModes?: Record<string, string | null> | null;
  instanceProperties?: Record<string, string | boolean | VariableAlias | null> | null;
  componentPropertyReferences?: { characters?: string | null; visible?: string | null; mainComponent?: string | null } | null;
  /** Name-keyed upsert of COMPONENT property definitions; `null` deletes a TEXT/BOOLEAN/INSTANCE_SWAP def. */
  componentProperties?: Record<string, ComponentPropertyPatchEntry | null> | null;
  /** Shallow-merge axes; array replaces options (never renames); object form `{ rename, options, renameOptions }` is explicit. Null axis deletes are rejected. */
  variantAxes?: Record<string, VariantAxisPatchEntry> | null;
  /** Merge variant selection on a COMPONENT inside a set. Whole-key or per-axis null is rejected. */
  variant?: Record<string, string | null> | null;
}

export interface PatchOperation {
  op: "SET" | "REMOVE" | "APPEND" | "INSERT" | "MOVE" | "DUPLICATE";
  id?: string;
  parent?: string;
  index?: number;
  /** Authored set object (keys from PATCH_SET_KEYS). */
  set?: JsonObject;
  /** Type-agnostic normalized set values; target-type rules run at apply time. */
  normalized?: PatchSetValues;
  node?: InternalNode;
  /** Required for DUPLICATE: non-empty suffix appended to every subtree id (unless overridden). */
  idSuffix?: string;
  /** Optional DUPLICATE overrides: sourceId → newId (keys must be in the source subtree). */
  ids?: Record<string, string>;
}

export interface InternalPatchDocument {
  patch: { operations: PatchOperation[] };
}
