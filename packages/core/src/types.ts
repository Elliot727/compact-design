export type JsonObject = Record<string, unknown>;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type Transform = [[number, number, number], [number, number, number]];
export interface LineHeight { unit: "AUTO" | "PIXELS" | "PERCENT"; value?: number; }
export interface LetterSpacing { unit: "PIXELS" | "PERCENT"; value: number; }
export interface VectorPath { windingRule: "NONZERO" | "EVENODD" | "NONE"; data: string; }
export interface VariableAlias { type: "VARIABLE_ALIAS"; id: string; }
export interface Constraints { horizontal: "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE"; vertical: "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE"; }
export type ComponentPropertyType = "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "VARIANT";
export interface ComponentPropertyOptions { preferredValues?: Array<{ type: "COMPONENT" | "COMPONENT_SET"; key: string }>; }
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
export interface DesignEffect { type: string; color?: DesignColor; offset?: DesignPoint; radius?: number; spread?: number; visible?: boolean; blendMode?: string; }
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
  instanceProperties?: Record<string, string | boolean | VariableAlias>; operation?: "UNION" | "SUBTRACT" | "INTERSECT" | "EXCLUDE";
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

export interface PatchOperation {
  op: "SET" | "REMOVE" | "APPEND";
  id?: string;
  parent?: string;
  set?: JsonObject;
  normalized?: DesignProperties;
  node?: InternalNode;
}

export interface InternalPatchDocument {
  patch: { operations: PatchOperation[] };
}
