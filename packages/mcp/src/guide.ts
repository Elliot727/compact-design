export const LANGUAGE_GUIDE = `# Compact Design JSON

Write one JSON object. Do not call Figma primitive APIs. Validate, then import.

## Document
{
  "$schema": "https://github.com/Elliot727/compact-design/blob/main/spec/compact-design.schema.json",
  "canvas": { "id": "home", "name": "Home", "width": 1440, "height": 900, "fill": "#F6F0E4" },
  "nodes": [ /* top-level frames on that canvas */ ],
  "variables": [],
  "styles": []
}

Use \`canvases\` for multiple screens. Give every layer that may be patched a stable \`id\`.

## Nodes
type: FRAME | GROUP | RECTANGLE | ELLIPSE | LINE | TEXT | VECTOR | SVG | COMPONENT | COMPONENT_SET | INSTANCE | BOOLEAN_OPERATION | POLYGON | STAR | SECTION | SLICE | ARC

Common fields: id, name, type, x, y, w, h, fill, stroke, strokeWeight, strokeAlign, strokeCap, strokeJoin, cornerRadius, opacity, rotation, layout, layoutGrids, children, text, font, effects, componentId, variant, bindings, variableModes, styleRefs, isMask.
\`layoutGrids\`: frame grids — GRID (sectionSize) or COLUMNS/ROWS (alignment, count, gutterSize).
\`strokeAlign\`: CENTER | INSIDE | OUTSIDE. \`strokeCap\` / \`strokeJoin\` set line ends and corners.
\`isMask\`: true masks following siblings — put the mask before the masked siblings.
\`BOOLEAN_OPERATION\` requires \`operation\` UNION | SUBTRACT | INTERSECT | EXCLUDE plus children.
\`overflowDirection\`: authored \`*_SCROLLING\` or short \`NONE\`|\`HORIZONTAL\`|\`VERTICAL\`|\`BOTH\` (both forms normalize to the short set). \`numberOfFixedChildren\` (integer ≥ 0): when the frame scrolls, its last N children stay fixed (sticky in HTML).

## Layout
{ "direction": "HORIZONTAL" | "VERTICAL" | "GRID", "itemSpacing": 8, "padding": { "left": 16, "top": 16, "right": 16, "bottom": 16 } }
Child sizing: layoutSizingHorizontal / layoutSizingVertical = FIXED | HUG | FILL

## Paints
Hex "#RRGGBB" or "#RRGGBBAA". Gradients: { "type": "linear", "angle": 180, "stops": [["#000", 0], ["#fff", 1]] }
Images: https://…, file:photo.jpg (resolved from the MCP working directory), or data:image/png;base64,…

## Text
{ "type": "TEXT", "text": "Hello", "font": { "family": "Inter", "style": "Bold", "size": 24 }, "fill": "#111" }
Typography controls sit on the TEXT node (not inside \`font\`): \`textCase\` ORIGINAL | UPPER | LOWER | TITLE | SMALL_CAPS | SMALL_CAPS_FORCED; \`hangingPunctuation\`, \`hangingList\` (booleans); \`listSpacing\`, \`paragraphSpacing\`, \`paragraphIndent\` (numbers ≥ 0). \`listSpacing\` and \`hangingList\` are Figma-faithful; HTML has no list-marker DOM yet.

## Effects
{ "effects": [{ "type": "DROP_SHADOW", "color": "#00000055", "offset": { "x": 0, "y": 12 }, "blur": 28, "spread": -4, "showShadowBehindNode": true }] }
Types: DROP_SHADOW | INNER_SHADOW | LAYER_BLUR | BACKGROUND_BLUR | NOISE | TEXTURE | GLASS | SHADER. SHADER is supported with a required Figma shader id (+ optional properties keyed by property-definition id): { "type": "SHADER", "id": "<shader id>" }.
Progressive blurs may set blurType, startRadius, startOffset, endOffset.

## Styles and styleRefs
Document \`styles\` hold reusable PAINT and TEXT styles. Nodes reference them via \`styleRefs\` keys \`fill\` / \`stroke\` (PAINT) and \`text\` (TEXT), by id or name:
{ "styles": [
  { "id": "ink", "name": "Ink", "type": "PAINT", "paints": ["#112233"] },
  { "id": "body", "name": "Body", "type": "TEXT", "font": { "family": "Inter", "style": "Regular", "size": 14 } }
],
  "nodes": [{ "type": "FRAME", "w": 50, "h": 50, "styleRefs": { "fill": "ink", "stroke": "Ink" },
    "children": [{ "type": "TEXT", "w": 40, "h": 16, "text": "Hi", "styleRefs": { "text": "Body" } }] }] }
validate returns ERROR if a styleRef is missing or the wrong type (same class as bindings).

## Variables and modes
Collections live under document \`variables\`. Types: COLOR | FLOAT | STRING | BOOLEAN.
Single-mode (default):
{ "variables": [{ "name": "Tokens", "items": [
  { "id": "brand", "name": "color/brand", "type": "COLOR", "value": { "r": 0, "g": 25, "b": 168, "a": 1 } },
  { "id": "space-md", "name": "space/md", "type": "FLOAT", "value": 16 }
] }] }
Multi-mode — declare \`modes\`, then per-item \`values\` keyed by those exact mode names:
{ "variables": [{ "name": "Theme", "modes": ["Light", "Dark"], "items": [
  { "id": "surface", "name": "colour/surface", "type": "COLOR", "values": {
    "Light": { "r": 248, "g": 245, "b": 238, "a": 1 },
    "Dark": { "r": 26, "g": 27, "b": 24, "a": 1 }
  } }
] }] }
When \`modes\` is set, every \`values\` object must cover each mode. COLOR values use {r,g,b,a}; FLOAT/STRING/BOOLEAN stay typed.

## Bindings and variableModes
Bind nodes to variables by id or name. \`fill\` / \`stroke\` bind the first paint color; other keys must be valid bindable fields:
{ "type": "FRAME", "w": 320, "h": 200, "fill": "#F8F5EE",
  "bindings": { "fill": "surface", "stroke": "brand" },
  "variableModes": { "Theme": "Dark" } }
\`variableModes\` selects a collection mode on a canvas or frame; descendants inherit it. validate returns ERROR if a binding names an unknown variable, or a mode/collection is undeclared.

## Prototype SET_VARIABLE_MODE
{ "prototype": [{ "trigger": { "type": "ON_CLICK" },
  "actions": [{ "type": "SET_VARIABLE_MODE", "collection": "Theme", "mode": "Dark" }] }] }

## Patch
{
  "patch": { "operations": [
    { "op": "set", "id": "title", "set": { "text": "Updated" } },
    { "op": "remove", "id": "old-badge" },
    { "op": "append", "parent": "list", "node": { "type": "FRAME", "w": 100, "h": 40 } }
  ] }
}

## Workflow
1. Author Compact Design JSON for the request.
2. Call validate. Fix every ERROR using path + message (unknown binding/mode/styleRefs are ERROR).
3. Optionally lint (advisory).
4. Call figma_import (or figma_patch). The Compact Design plugin must be open in Figma Desktop.
5. To edit what is already in the file, prefer figma_export (scope "page", or id set to a Compact Design id) then figma_patch on that JSON. Do not regenerate the whole screen for a small edit. Export round-trips variables, modes, bindings, styles/styleRefs, and layout grids when present.
6. If figma_status.pluginConnected is false, tell the user to run the plugin and retry.
`;
