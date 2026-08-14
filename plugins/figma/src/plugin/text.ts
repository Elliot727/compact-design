import { paintFromData } from "./paints";
import { FALLBACK_FONT, finite } from "./value";
import type { DesignFont, DesignPaint, DesignProperties } from "@compact-design/core";

export const fontWarnings = new Set<string>();
export function clearFontWarnings(): void { fontWarnings.clear(); }

export async function loadFont(value?: Partial<DesignFont>): Promise<FontName> {
  const requested = value?.family ? { family: value.family, style: value.style || "Regular" } : FALLBACK_FONT;
  try { await figma.loadFontAsync(requested); return requested; }
  catch { fontWarnings.add(`${requested.family} ${requested.style} → ${FALLBACK_FONT.family} ${FALLBACK_FONT.style}`); await figma.loadFontAsync(FALLBACK_FONT); return FALLBACK_FONT; }
}

export async function applyText(node: TextNode, props: Partial<DesignProperties>): Promise<void> {
  node.fontName = await loadFont(props.font);
  node.characters = props.text || "";
  if (props.font && Number.isFinite(props.font.size)) node.fontSize = props.font.size;
  node.lineHeight = props.lineHeight?.unit === "PERCENT" ? { unit: "PERCENT", value: finite(props.lineHeight.value, 100) } : props.lineHeight?.unit === "PIXELS" ? { unit: "PIXELS", value: finite(props.lineHeight.value, 20) } : { unit: "AUTO" };
  if (props.letterSpacing) node.letterSpacing = props.letterSpacing;
  if (props.textDecoration) node.textDecoration = props.textDecoration;
  if (typeof props.paragraphSpacing === "number" && Number.isFinite(props.paragraphSpacing)) node.paragraphSpacing = props.paragraphSpacing;
  if (typeof props.paragraphIndent === "number" && Number.isFinite(props.paragraphIndent)) node.paragraphIndent = props.paragraphIndent;
  if (typeof props.listSpacing === "number" && Number.isFinite(props.listSpacing)) node.listSpacing = props.listSpacing;
  if (typeof props.hangingPunctuation === "boolean") node.hangingPunctuation = props.hangingPunctuation;
  if (typeof props.hangingList === "boolean") node.hangingList = props.hangingList;
  if (props.textCase) node.textCase = props.textCase;
  node.textAlignHorizontal = (props.alignment || "LEFT") as TextNode["textAlignHorizontal"];
  if (props.verticalAlignment) node.textAlignVertical = props.verticalAlignment;
  node.textAutoResize = props.textAutoResize || "NONE";
  if (props.textTruncation) node.textTruncation = props.textTruncation;
  if (typeof props.maxLines === "number" && Number.isFinite(props.maxLines)) node.maxLines = props.maxLines;
  let cursor = 0;
  for (const run of props.runs || []) {
    const start = typeof run.start === "number" && Number.isFinite(run.start) ? run.start : cursor;
    const end = typeof run.end === "number" && Number.isFinite(run.end) ? run.end : start + (typeof run.text === "string" ? run.text.length : 0);
    const runFont = run.font && typeof run.font === "object" && !Array.isArray(run.font) ? run.font as Partial<DesignFont> : props.font;
    const font = await loadFont(runFont);
    node.setRangeFontName(start, end, font);
    if (runFont && typeof runFont.size === "number" && Number.isFinite(runFont.size)) node.setRangeFontSize(start, end, runFont.size);
    const fill = run.fill && typeof run.fill === "object" && !Array.isArray(run.fill) ? await paintFromData(run.fill as DesignPaint) : null;
    if (fill) node.setRangeFills(start, end, [fill]);
    if (typeof run.textDecoration === "string") node.setRangeTextDecoration(start, end, run.textDecoration as TextDecoration);
    if (run.letterSpacing && typeof run.letterSpacing === "object") node.setRangeLetterSpacing(start, end, run.letterSpacing as LetterSpacing);
    if (typeof run.link === "string") node.setRangeHyperlink(start, end, { type: "URL", value: run.link });
    cursor = end;
  }
}
