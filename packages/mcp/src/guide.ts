export const LANGUAGE_GUIDE = `# Compact Design JSON

Write one JSON object. Do not call Figma primitive APIs. Validate, then import.

## Document
{
  "$schema": "https://github.com/Elliot727/compact-design/blob/main/spec/compact-design.schema.json",
  "canvas": { "id": "home", "name": "Home", "width": 1440, "height": 900, "fill": "#F6F0E4" },
  "nodes": [ /* top-level frames on that canvas */ ]
}

Use \`canvases\` for multiple screens. Give every layer that may be patched a stable \`id\`.

## Nodes
type: FRAME | GROUP | RECTANGLE | ELLIPSE | LINE | TEXT | VECTOR | SVG | COMPONENT | COMPONENT_SET | INSTANCE | BOOLEAN_OPERATION | POLYGON | STAR | SECTION | SLICE | ARC

Common fields: id, name, type, x, y, w, h, fill, stroke, strokeWeight, cornerRadius, opacity, rotation, layout, children, text, font, effects, componentId, variant.

## Layout
{ "direction": "HORIZONTAL" | "VERTICAL" | "GRID", "itemSpacing": 8, "padding": { "left": 16, "top": 16, "right": 16, "bottom": 16 } }
Child sizing: layoutSizingHorizontal / layoutSizingVertical = FIXED | HUG | FILL

## Paints
Hex "#RRGGBB" or "#RRGGBBAA". Gradients: { "type": "linear", "angle": 180, "stops": [["#000", 0], ["#fff", 1]] }
Images: https://…, file:photo.jpg (resolved from the MCP working directory), or data:image/png;base64,…

## Text
{ "type": "TEXT", "text": "Hello", "font": { "family": "Inter", "style": "Bold", "size": 24 }, "fill": "#111" }

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
2. Call validate. Fix every ERROR using path + message.
3. Optionally lint (advisory).
4. Call figma_import (or figma_patch). The Compact Design plugin must be open in Figma Desktop.
5. To edit what is already in the file, call figma_export with scope "page", or with id set to a Compact Design id. Then change that JSON with figma_patch. Do not regenerate the whole screen for a small edit.
6. If figma_status.pluginConnected is false, tell the user to run the plugin and retry.
`;
