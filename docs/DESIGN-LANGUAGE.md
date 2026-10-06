# Compact Design JSON — Current API

Compact Design JSON is the public design language implemented by `@compact-design/core` and consumed by the Figma reference adapter. There are no selectable schema versions and no legacy document forms. This document always describes the current schema.

The machine-readable Draft 2020-12 specification is [`compact-design.schema.json`](../spec/compact-design.schema.json). Add `"$schema": "../spec/compact-design.schema.json"` to a document for editor validation and autocomplete. Cross-document rules such as unique IDs and component reference resolution are enforced by `@compact-design/core`.

Core accepts exactly one JSON object, validates and normalizes it, then exposes a canonical document to an adapter. The Figma adapter turns that representation into native editable Figma nodes.

## Import modes and stable IDs

Every imported canvas and layer stores its JSON `id` as private Figma plugin data. Those stable IDs power three import modes:

- **Create new** refuses a canvas ID already present on the current page.
- **Update matching IDs** replaces matching imported canvases in their existing layer-stack position and creates unmatched canvases. Use patches for surgical child-layer edits.
- **Replace matching canvases** explicitly replaces every matching canvas with the supplied definition.

Full-document update is canvas-granular and rebuilds the contents of a matching canvas. A JSON patch is node-granular: `set` changes only the keys it lists, with the merge rules in [Patch `set` semantics](#patch-set-semantics). Existing canvases are cloned temporarily so failures restore the previous design.

Give every layer that may be updated or patched an explicit stable ID. Generated fallback IDs depend on tree position and should not be treated as long-term identifiers.

## JSON patch documents

A patch is the second accepted top-level document form. It targets layers previously imported by this plugin:

```json
{
  "$schema": "../spec/compact-design.schema.json",
  "patch": {
    "operations": [
      { "op": "set", "id": "hero-title", "set": { "text": "A quieter kind of stay.", "fill": "#F6F0E4" } },
      { "op": "remove", "id": "old-badge" },
      {
        "op": "append",
        "parent": "room-grid",
        "node": { "id": "room-three", "type": "FRAME", "w": 320, "h": 420, "fill": "#E8E0D2", "children": [] }
      },
      {
        "op": "insert",
        "parent": "room-grid",
        "index": 1,
        "node": { "id": "room-featured", "type": "FRAME", "w": 320, "h": 420, "fill": "#D9CDB8", "children": [] }
      },
      { "op": "move", "id": "room-featured", "parent": "room-grid", "index": 0 }
    ]
  }
}
```

- `set` changes only the keys it lists (see [Patch `set` semantics](#patch-set-semantics)). Unknown keys are errors.
- `remove` deletes the matching node.
- `append` creates a native child under a matching container (equivalent to `insert` at `index = children.length`). It uses the same parent checks as `insert` (missing parent, non-container, INSTANCE or inside an INSTANCE).
- `insert` creates a native child at `index` under a matching container. `index` is a non-negative integer; on apply it is clamped to `[0, children.length]` so oversized values append.
- `move` reparents an existing node (or reorders within the same parent) to `index`. For same-parent moves, `index` is the **final** position after the node is removed. Moving a node under itself or a descendant, moving the document root, moving a node **out of** an INSTANCE, targeting a missing id/parent, or choosing a non-container / INSTANCE parent are errors.

All targets, parents, and appended IDs are checked before the first operation against layers previously imported by this plugin (compact-design plugin data only — raw Figma ids are not accepted). The Figma applicator preflights against the current page index, so a node or parent created earlier in the **same** patch is not visible there: a `set`, `remove`, or `move` that targets it, or an `insert`/`append` under it, fails preflight and nothing changes. Put the properties on the inserted node instead, or use a second patch. Core's abstract `applyPatch` / `validatePatch` does accept such targets. This is the one known difference between the engines.

Patches are atomic in Figma. Every `set` is checked against the rules below before its target is touched. Each changed or removed node is cloned into a hidden "Compact Design patch backup" frame before it is changed. Inserts are removed, and moves go back to their original parent, index, and x/y, if a later operation fails. The undo log is replayed in reverse, so a `set` after a `move` of the same node, or a `set` on an ancestor after edits to its children, also restores cleanly. The holder frame is deleted when the patch finishes. A layer restored after a failure is the clone, so it gets a new Figma node id. Patch image fills use the same remote, local-file, embedded-image and downscaling pipeline as full documents.

### Patch `set` semantics

`set` accepts exactly the keys in `$defs.patchSet` of the schema. That is every node property except `id`, `type`, `children`, and `coordinateMode`. Core exports the same list as `PATCH_SET_KEYS`, and the Figma plugin applies from that list. A typo such as `"txet"` fails schema validation, `normalizePatch`, `validatePatch`, and the Figma plugin. Set values are normalized without guessing the node type and **without defaults**: no Arial, no white TEXT fill, no `AUTO` line height. The rules that depend on the target (which keys apply to which type, Auto Layout, text styling) run at apply time against the real target, in core and in Figma, through the same `patchSetTargetIssues` function.

| Keys | Semantics |
| --- | --- |
| `layout`, `layout.padding` | **Deep merge.** `{ "layout": { "itemSpacing": 24 } }` keeps direction, padding, and alignment. `{ "layout": { "padding": { "left": 8 } } }` keeps the other three sides. |
| `font` | **Merge.** `{ "font": { "size": 32 } }` keeps family and style. |
| `constraints` | **Merge.** A missing axis keeps its current value, or Figma's default `MIN` if the node had no constraints. |
| `fill`/`fills`, `stroke`/`strokes` | **Replace** the whole paint list. Setting both forms at once is an error. Replacing fills detaches a `bindings.fill` variable and a `styleRefs.fill` style (WARNING), just as assigning paints does in Figma. Strokes do the same with `stroke`. |
| `effects`, `shadow`, `elevation` | **Replace** the whole effect list. When several of these are set together, they combine as in authoring: elevation preset, then shadows, then effects. `{ "effects": [] }` clears all effects. |
| `runs`, `layoutGrids`, `vectorPaths`, `dashPattern`, `cornerRadii` | **Replace** the whole array. |
| `x`, `y` | **Parent-relative**, the same as authoring and Figma. The node's whole subtree moves with it. |
| every other key | **Scalar replace.** `align` maps to the canonical `alignment`. `lineHeight` numbers become percentages, as in authoring. |
| `bindings`, `styleRefs`, `variableModes`, `instanceProperties`, `componentPropertyReferences` | **Shallow-merge** object entries. A field set to `null` clears that entry; the whole key set to `null` clears the map. For `instanceProperties`, `null` resets the override to the main component's default (core drops the key; Figma sets `defaultValue`). `INSTANCE_SWAP` values use the same type-aware compact→Figma id remap as import. `componentPropertyReferences` values must name a property on the owning COMPONENT. |
| `componentProperties` | **Name-keyed upsert on COMPONENT** (not COMPONENT_SET). Pass `{ "Label": { "defaultValue": "Go" } }` to edit, `{ "Icon": { "type": "INSTANCE_SWAP", "defaultValue": "icon-id" } }` to add (type + defaultValue required on create), `{ "Show": null }` to delete. Type is immutable after create. VARIANT properties are not authorable here — use `variantAxes`. Deleting a property still referenced by `componentPropertyReferences` fails post-patch validation. Figma remaps INSTANCE_SWAP defaults the same way as import. |
| `variantAxes` | **Shallow-merge on COMPONENT_SET.** Unmentioned axes are kept. A **string array** replaces that axis's options and **never** renames. Object form `{ "rename"?, "options"?, "renameOptions"? }` renames explicitly (e.g. `{ "State": { "rename": "Status", "options": ["Default", "Pressed"], "renameOptions": { "Hover": "Pressed" } } }`). Axis `null` is an error (Figma cannot delete VARIANT properties). Removing an option still used by a child without `renameOptions` is an error. Every declared option must be carried by a COMPONENT child after the patch (Figma derives options from child names); a later op in the same patch may set/append a child to carry a new option. Renames rewrite child names/`variant` and instance VARIANT overrides **only for instances of this set**. |
| `variant` | **Merge on a COMPONENT inside a COMPONENT_SET.** Every axis/value must already be declared on the parent `variantAxes`. Rewrites the component's variant name (`State=Hover`). Whole-key `null` and per-axis `null` are rejected (variant components require a selection). |
| `prototype`, `componentId` | **Not patchable yet.** Rejected with `PATCH_SET_UNSUPPORTED`. Remapping prototype destinations / swapping the instance main component is deferred. Re-import, or remove and insert. |
| `svg` | **Never patchable in place.** Remove the node and insert a new SVG node. |

Target rules. Each is an error in both engines, never a silent no-op:

- A key must apply to the target type. For example, `text`, `font`, and `runs` apply only to TEXT. `layout`, `layoutGrids`, `overflowDirection`, and `numberOfFixedChildren` apply only to FRAME and COMPONENT. `w`/`h` are rejected on GROUP and BOOLEAN_OPERATION, whose bounds come from their children.
- **Partial layout on a frame without Auto Layout:** this is an error unless `layout.direction` is given. With a direction, Auto Layout is enabled exactly as on import, and unmentioned fields take the import defaults (FIXED sizing, MIN alignment, 0 spacing and padding). `layout.counterAxisAlignItems: "STRETCH"` cannot be patched yet. Set `layoutAlign: "STRETCH"` on the children instead.
- **x/y under Auto Layout:** this is an error unless the node also has, or is given, `layoutPositioning: "ABSOLUTE"`. **x/y on a child of a GROUP or BOOLEAN_OPERATION** is an error. Move the group itself, or move the node out first. `layoutAlign`, `layoutGrow`, `layoutPositioning`, and `layoutSizing*: "FILL"` need an Auto Layout parent. `layoutSizing*: "HUG"` needs a TEXT node or an Auto Layout frame. `min/max` sizes need Auto Layout on the node or its parent. `numberOfFixedChildren` cannot exceed the child count.
- **Text content vs runs:** when both `text` and `runs` are set, `text` is the content and the runs style ranges of it, as in authoring. `runs` alone sets the content to the concatenated run texts, so every run must then have `text`. `text` alone clears the old runs. Replacing the content of a node that already has **per-range styling** is rejected for now. Remove and insert the node instead. In core, per-range styling means a run with font, fill, letterSpacing, textDecoration, or link. In Figma, it means any text property that is `figma.mixed`.
- **Node-level typography applies to the whole text**, as in Figma. Setting `font` fields, `fill`, `letterSpacing`, or `textDecoration` on a TEXT node clears the matching overrides on its existing runs.
- **Mixed fonts (`figma.mixed`):** Figma loads every range font before editing. `font.size` alone applies to all ranges. `font.family` without `font.style`, or the reverse, is an error on mixed-font text. A font that Figma cannot load is an error, and the whole patch rolls back. The patch never falls back to Arial.
- **Linked text styles and variable bindings:** setting raw `fill`/`stroke`/`font` (or other typography) on a node that has a conflicting `bindings.*` or `styleRefs.*` **detaches** that binding/styleRef and emits a **WARNING** in both core and Figma (never silent). You can also clear a binding or styleRef explicitly with `null` (for example `{ "bindings": { "fill": null } }`).

- **Bindings/styleRefs vs paints:** patching `bindings` or `styleRefs` does not rewrite the node's authored `fill`/`stroke` paints in core (same as import: the binding or style is the source of truth at render time). Figma applies the live paint/style on the canvas.

`validate(patch)` no longer reports every patch document as valid. It checks the schema and core's key rules, which cover unknown, deferred, conflicting, and empty keys. `validatePatch(document, patch)` also runs the target rules and `validateDocument` on the patched result. This reports structured issues such as `PATCH_SET_INVALID`, `PATCH_OPERATION`, or `PATCH_RESULT_INVALID` (for example an undefined variable in an inserted node's `bindings`, an unknown `styleRefs` style, or a missing component). `applyPatch` throws `PatchError`, with the same issues, under the same conditions. Only issues the patch **introduces** are reported. Issues already in the input document never block a patch, even on nodes the patch touches. Issues the patch causes on nodes it only touched indirectly are still reported: for example, removing a component breaks an untouched instance, and moving a variant into a set that doesn't declare its value creates a conflict. Issues are compared by code, owning node id (or variable or collection name), the property path inside that node, and message. Array indexes are never part of the comparison, so an insert, move or remove that shifts indexes does not make an old issue look new. The comparison counts copies, so a second copy of an existing problem on a new node is new.

## Preview, repair output, and design lint

The plugin displays dimensions, layer/image totals, matching/new canvas counts, and lint findings before import. It intentionally does not render a visual thumbnail because browser previews cannot accurately reproduce Figma layout, fonts, images, masks, vectors, and effects. **Copy repair JSON** produces an LLM-friendly response:

```json
{
  "valid": false,
  "issues": [{
    "severity": "ERROR",
    "code": "SCHEMA_VALIDATION",
    "path": "nodes[0].children[2].layout.direction",
    "message": "must be HORIZONTAL, VERTICAL, or GRID",
    "suggestion": "Use the allowed property type or enum from compact-design.schema.json."
  }]
}
```

The optional design lint checks:

- approximate WCAG text/background colour contrast;
- interactive targets smaller than 44×44;
- spacing values outside a consistent 4px scale;
- row/column-like containers missing Auto Layout;
- repeated detached elements and missing component usage;
- likely fixed-box text overflow;
- repeated hard-coded colours not bound to variables;
- broken prototype destination IDs.

Lint is heuristic and advisory because Figma is not a browser layout engine. Schema/semantic validation errors remain blocking.

## Exporting a Figma design

Select one or more frames or layers in Figma and choose **Export selection**. A selected container is represented as a canvas and its descendants become `nodes`. Multiple selected roots produce `canvases`. The generated document is placed in the JSON editor and can be copied, downloaded, edited, or imported again.

Through `@compact-design/mcp`, `figma_export` can read the whole current page (`scope: "page"`) or one layer by its Compact Design id or Figma id. An id export includes a main component that lives on the same page, so the instance stays an instance. A component that lives on another page is still flattened.

Solid and gradient paints, embedded image fills, geometry, hierarchy, common effects, text, Auto Layout, constraints, vectors and standard shapes are preserved. Image data is embedded as a base64 data URL, which makes exports self-contained but can make the JSON file large. Instances whose main component is outside the selection are flattened into editable frames to prevent invalid component references. Figma-only metadata or properties that have no compact-language equivalent may be omitted.

## Document structure

Use one canvas:

```json
{
  "canvas": {
    "id": "desktop",
    "name": "Desktop",
    "width": 1440,
    "height": 1000,
    "fill": "#FFFFFF",
    "clipsContent": true
  },
  "nodes": [],
  "variables": [],
  "styles": []
}
```

Or use responsive canvases:

```json
{
  "canvases": [
    {
      "id": "desktop",
      "name": "Desktop 1440",
      "x": 0,
      "width": 1440,
      "height": 1000,
      "fill": "#FFFFFF",
      "breakpoint": { "name": "desktop", "minWidth": 1200 },
      "nodes": []
    },
    {
      "id": "mobile",
      "name": "Mobile 390",
      "x": 1560,
      "width": 390,
      "height": 1200,
      "fill": "#FFFFFF",
      "breakpoint": { "name": "mobile", "minWidth": 0, "maxWidth": 767 },
      "nodes": []
    }
  ]
}
```

With `canvas`, document-level `nodes` become its children. With `canvases`, each canvas owns a `nodes` array. Every canvas becomes a separate top-level Figma frame. Breakpoint data is preserved as plugin data for re-export and tooling; Figma does not dynamically switch breakpoints.

Canvas width and height are required positive numbers. Canvas `x` and `y` default to an automatically spaced horizontal arrangement and zero respectively.

## Coordinates

Coordinates are parent-relative. A child at `x: 24, y: 16` is placed 24 pixels from its parent’s left and 16 pixels from its top. Patch `set` x/y, and the nodes passed to `insert`/`append`, use the same parent-relative convention. `move` keeps the node's parent-relative x/y, so a node moved under a new parent keeps its offset from that parent's origin.

Use `coordinateMode: "ABSOLUTE"` only when a node already uses canvas coordinates. Width and height must be finite positive numbers. Numeric strings, CSS units, `NaN`, and `Infinity` are invalid.

## Common node properties

```json
{
  "id": "card",
  "name": "Feature Card",
  "type": "FRAME",
  "x": 24,
  "y": 24,
  "w": 320,
  "h": 200,
  "rotation": 0,
  "fill": "#FFFFFF",
  "stroke": "#D0D5DD",
  "strokeWeight": 1,
  "cornerRadius": 16,
  "opacity": 1,
  "visible": true,
  "locked": false,
  "children": []
}
```

Required node fields are `w` and `h`. `type` defaults to `FRAME`. IDs and names are generated when omitted. Explicit IDs must be unique and are required for referenced components.

Defaults:

| Field | Default |
|---|---|
| `type` | `FRAME` |
| `x`, `y`, `rotation` | `0` |
| `opacity` | `1` |
| `blendMode` | `NORMAL` |
| `visible` | `true` |
| `locked`, `isMask` | `false` |
| shape fills, strokes, effects | empty |
| text fill | `#FFFFFF` |
| font | Arial Regular 16 |
| children | empty |

The importer falls back to Arial Regular if a requested font is unavailable. Use installed font family/style combinations explicitly for predictable results.

## Node types

- `FRAME`: container supporting children, paints, clipping, Auto Layout, and grids.
- `GROUP`: native group; requires children.
- `RECTANGLE`: rectangle with uniform or individual radii.
- `ELLIPSE`: ellipse or circle.
- `ARC`: ellipse with configurable start, end, and inner radius.
- `LINE`: native line.
- `POLYGON`: polygon with configurable point count.
- `STAR`: star with configurable point count and inner radius.
- `SECTION`: native Figma section. Prefer it as a top-level node.
- `SLICE`: native export slice. Prefer it as a top-level node.
- `TEXT`: editable text with optional rich runs.
- `SVG`: editable nodes created from inline SVG markup.
- `VECTOR`: vector using Figma path data.
- `COMPONENT`: native reusable component with optional properties.
- `COMPONENT_SET`: combines component children as variants.
- `INSTANCE`: instance referencing an earlier component.
- `BOOLEAN_OPERATION`: union, subtract, intersect, or exclude operation.

## Solid and gradient paints

Use hex shorthand for one solid paint. This is the canonical and preferred form for generated documents:

```json
{ "fill": "#6C5CFF", "stroke": "#FFFFFF66" }
```

Hex formats are `#RRGGBB` and `#RRGGBBAA`. Use `fills` and `strokes` arrays for multiple paints. The expanded `{ "type": "SOLID", "color": ... }` record exists for native Figma paint/style interchange; LLMs should use hex unless they specifically need an expanded record.

Gradient shorthand:

```json
{
  "fills": [{
    "gradient": "LINEAR",
    "transform": [[1, 0, 0], [0, 1, 0]],
    "stops": [
      { "at": 0, "color": "#6C5CFF" },
      { "at": 1, "color": "#43E6B0" }
    ]
  }]
}
```

Gradient kinds: `LINEAR`, `RADIAL`, `ANGULAR`, and `DIAMOND`. At least two stops are required.

Compact node paints use `gradient: "LINEAR"` with `stops`. Native style/export records may use `type: "GRADIENT_LINEAR"` with `gradientStops`. Both normalize to the same Figma paint, but generated node JSON should prefer the compact `gradient` form. The `GRADIENT_*` form primarily exists so exported Figma styles remain lossless.

For LLM-friendly linear gradients, use degrees instead of a transform matrix:

```json
{ "fill": { "gradient": "LINEAR", "angle": 135, "stops": [{ "at": 0, "color": "#6C5CFF" }, { "at": 1, "color": "#43E6B0" }] } }
```

Angles are clockwise degrees. `0` points left-to-right. An explicit `transform` takes precedence over `angle`.

## Image fills

Images are paints applied to frames and shapes:

```json
{
  "type": "RECTANGLE",
  "w": 640,
  "h": 420,
  "cornerRadius": 24,
  "fill": {
    "image": "https://example.com/photo.jpg",
    "fit": "COVER",
    "opacity": 1
  }
}
```

`image` may be a direct HTTPS URL or a local asset reference such as `file:room.jpg`.

For local files, reference the exact filename in JSON:

```json
{
  "type": "RECTANGLE",
  "w": 640,
  "h": 420,
  "fill": { "image": "file:room.jpg", "fit": "COVER" }
}
```

Choose **Add images** in the plugin and select all referenced image files. Multiple files may be selected at once. Matching is case-sensitive and primarily uses the filename; a reference containing folders also falls back to its final filename. Missing files are reported before any Figma nodes are created. Local PNG, JPEG, GIF, and WebP files are accepted by the picker, subject to browser and Figma decoding support.

| Compact value | Figma value | Behaviour |
|---|---|---|
| `COVER` | `FILL` | Covers the shape and may crop edges |
| `CONTAIN` | `FIT` | Shows the whole image and may leave space |
| `CROP` | `CROP` | Uses an optional crop transform |
| `TILE` | `TILE` | Repeats the image |

For custom cropping, set `fit: "CROP"` and provide `transform`, a Figma 2×3 image transform matrix.

Before import, the UI inspects every remote and local image. Images larger than 4096 pixels on either axis are proportionally resized to fit inside 4096×4096, encoded as JPEG at 90% quality, and passed to Figma as bytes. Smaller local files are passed through as their original bytes; smaller remote images retain URL-based import. Resizing preserves aspect ratio but removes animation and may convert transparency to the canvas encoding result. Remote hosts must permit cross-origin access; preflight errors identify the failing URL.

## Corners and strokes

- `cornerRadius`: non-negative uniform radius.
- `cornerRadii`: `[topLeft, topRight, bottomRight, bottomLeft]`.
- `strokeWeight`: uniform width.
- `strokeTopWeight`, `strokeRightWeight`, `strokeBottomWeight`, `strokeLeftWeight`: per-side widths on compatible nodes.
- `strokeAlign`: `CENTER`, `INSIDE`, or `OUTSIDE`.
- `strokeCap`: supported Figma cap such as `NONE`, `ROUND`, or `SQUARE`.
- `strokeJoin`: `MITER`, `BEVEL`, or `ROUND`.
- `dashPattern`: alternating dash and gap values, such as `[8, 4]`.

## Effects and layer state

```json
{
  "effects": [{
    "type": "DROP_SHADOW",
    "color": "#00000055",
    "offset": { "x": 0, "y": 12 },
    "blur": 28,
    "spread": -4
  }]
}
```

Effect types: `DROP_SHADOW`, `INNER_SHADOW`, `LAYER_BLUR`, `BACKGROUND_BLUR`, `NOISE`, `TEXTURE`, `GLASS`, and `SHADER`. `SHADER` requires the Figma shader `id` (from `figma.listAvailableShaders()`) and may carry `properties` keyed by property-definition id; values round-trip verbatim. The Figma plugin imports each shader with `figma.importShaderById` before applying it and skips (with a warning) any shader it cannot import. The HTML renderer does not render shaders. Progressive blurs may set `blurType`, `startRadius`, `startOffset`, and `endOffset`. Drop shadows may set `showShadowBehindNode`.

Use `elevation: "NONE|LOW|MEDIUM|HIGH|FLOATING"` for standard presets. Use `shadow` for concise custom shadows:

```json
{ "shadow": { "x": 0, "y": 8, "blur": 24, "spread": -4, "color": "#00000033" } }
```

`shadow` may also be an array for layered shadows and works on text nodes. Set `inner: true` for an inner shadow. Explicit `effects` are appended after preset and shorthand shadows.

Layer fields include `opacity` from 0 to 1, `blendMode`, `visible`, `locked`, `clipsContent`, and `isMask`. Put a mask before the sibling layers it masks.

## Text

```json
{
  "type": "TEXT",
  "w": 600,
  "h": 100,
  "text": "Build better software.",
  "font": { "family": "Arial", "style": "Bold", "size": 48 },
  "fill": "#101828",
  "lineHeight": 1.1,
  "letterSpacing": { "unit": "PIXELS", "value": -1 },
  "align": "CENTER"
}
```

`lineHeight` accepts a multiplier such as `1.2`, a percentage such as `120`, or `{ "unit": "PIXELS|PERCENT|AUTO", "value": number }`. `align` is the only horizontal text-alignment field and accepts `LEFT`, `CENTER`, `RIGHT`, and `JUSTIFIED`. Put text size only in `font.size`; the former top-level `fontSize` and text `alignment` aliases are not part of the current API and are rejected.

Other fields: `verticalAlignment`, `textDecoration`, `paragraphSpacing`, `paragraphIndent`, `textAutoResize`, `textTruncation`, and `maxLines`.

### Rich text runs

Runs apply character-range styling. If top-level `text` is omitted, run text is concatenated in order.

```json
{
  "type": "TEXT",
  "w": 700,
  "h": 80,
  "font": { "family": "Arial", "style": "Regular", "size": 32 },
  "runs": [
    { "text": "Build ", "font": { "family": "Arial", "style": "Regular", "size": 32 }, "fill": "#101828" },
    { "text": "faster", "font": { "family": "Arial", "style": "Bold", "size": 32 }, "fill": "#0019A8", "textDecoration": "UNDERLINE", "link": "https://example.com" }
  ]
}
```

A run supports `text`, `font`, `fill`, `letterSpacing`, `textDecoration`, and `link`. Alternatively, supply explicit zero-based `start` and exclusive `end` indices into top-level text. Ranges must be valid and non-overlapping; sequential run text is safer for LLM output.

Writable whole-node controls also include `textCase`, `listSpacing`, `hangingPunctuation`, `hangingList`, `paragraphIndent`, and `paragraphSpacing`. OpenType feature flags are read-only in Figma's public plugin API and cannot be set.

## Auto Layout, constraints, and responsive sizing

```json
{
  "type": "FRAME",
  "layout": {
    "direction": "HORIZONTAL",
    "itemSpacing": 16,
    "counterAxisSpacing": 16,
    "padding": { "left": 24, "top": 24, "right": 24, "bottom": 24 },
    "primaryAxisAlignItems": "MIN",
    "counterAxisAlignItems": "CENTER",
    "primaryAxisSizingMode": "FIXED",
    "counterAxisSizingMode": "FIXED",
    "wrap": false
  }
}
```

Directions: `HORIZONTAL`, `VERTICAL`, and `GRID`. Auto Layout is applied automatically whenever a node contains `layout`. Omit `layout` when exact manual positioning is required.

Frame axis sizing uses `FIXED` or `HUG`. The importer translates public `HUG` to Figma's low-level `AUTO` enum. `AUTO` is also accepted as an alias, but generated documents should prefer `HUG`.

`primaryAxisAlignItems` accepts `MIN`, `MAX`, `CENTER`, and `SPACE_BETWEEN`. `counterAxisAlignItems` accepts `MIN`, `MAX`, `CENTER`, `BASELINE`, and the compact-language convenience value `STRETCH`. Because Figma implements cross-axis stretching on children rather than the parent, the importer compiles parent `STRETCH` to parent `MIN` and applies `layoutAlign: "STRETCH"` to children that do not specify their own `layoutAlign`.

Auto-layout children support:

- `layoutSizingHorizontal`, `layoutSizingVertical`: `FIXED`, `HUG`, or `FILL`.
- `layoutAlign`, `layoutGrow`, `layoutPositioning`.
- `minWidth`, `maxWidth`, `minHeight`, `maxHeight`: positive numbers or `null` where Figma permits removal.

These properties are applied only when the actual parent uses Auto Layout. Ordinary frame constraints use:

```json
{ "constraints": { "horizontal": "STRETCH", "vertical": "MIN" } }
```

For genuinely different responsive compositions, use multiple canvases rather than expecting Figma to reflow a static frame automatically.

## Polygon, star, and arc

```json
{ "type": "POLYGON", "w": 100, "h": 100, "pointCount": 6, "fill": "#0019A8" }
```

```json
{ "type": "STAR", "w": 100, "h": 100, "pointCount": 5, "innerRadius": 0.45, "fill": "#FFCC00" }
```

```json
{ "type": "ARC", "w": 120, "h": 120, "startingAngle": 0, "endingAngle": 4.71, "innerRadiusRatio": 0.65, "fill": "#DC241F" }
```

Arc angles are radians. Polygon/star point count must be at least 3. Star `innerRadius` and arc `innerRadiusRatio` range from 0 to 1.

## SVG and vector

```json
{ "type": "SVG", "w": 24, "h": 24, "svg": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>...</svg>" }
```

Vectors use `vectorPaths`, an array of Figma-compatible `{ "windingRule": "NONZERO|EVENODD", "data": "..." }` records.

SVG-style comma separators in vector path data are accepted as a convenience and normalized to the whitespace-separated form required by Figma.

## Components and instances

Define components earlier than instances:

```json
{
  "nodes": [
    { "id": "button", "type": "COMPONENT", "w": 160, "h": 48, "children": [] },
    { "type": "INSTANCE", "componentId": "button", "x": 200, "w": 160, "h": 48 }
  ]
}
```

Components accept `componentProperties`, whose entries contain `name`, `type`, `defaultValue`, and optional `options`. Supported authorable types are `TEXT`, `BOOLEAN`, and `INSTANCE_SWAP` (VARIANT axes use `variantAxes` / `variant` on `COMPONENT_SET` instead). Instances use `instanceProperties` to provide overrides.

To make those properties actually drive child layers, set `componentPropertyReferences` on descendants of the COMPONENT (Figma's same field). Keys are the node fields they bind; values are the authored property names:

- `characters` → a `TEXT` property (TEXT nodes only)
- `visible` → a `BOOLEAN` property (any node)
- `mainComponent` → an `INSTANCE_SWAP` property (INSTANCE nodes only)

Referenced properties must exist on the nearest ancestor COMPONENT. Validation stops at a nested INSTANCE or another COMPONENT, so refs cannot cross into a nested instance.

Linked button example:

```json
{
  "nodes": [
    { "id": "icon-star", "type": "COMPONENT", "w": 16, "h": 16, "fill": "#111111" },
    {
      "id": "button",
      "type": "COMPONENT",
      "w": 160,
      "h": 48,
      "componentProperties": [
        { "name": "Label", "type": "TEXT", "defaultValue": "Continue" },
        { "name": "ShowIcon", "type": "BOOLEAN", "defaultValue": true },
        { "name": "Icon", "type": "INSTANCE_SWAP", "defaultValue": "icon-star" }
      ],
      "children": [
        { "id": "button-label", "type": "TEXT", "w": 100, "h": 20, "text": "Continue", "componentPropertyReferences": { "characters": "Label" } },
        { "id": "button-icon", "type": "INSTANCE", "componentId": "icon-star", "w": 16, "h": 16, "componentPropertyReferences": { "visible": "ShowIcon", "mainComponent": "Icon" } }
      ]
    },
    {
      "id": "button-1",
      "type": "INSTANCE",
      "componentId": "button",
      "x": 200,
      "w": 160,
      "h": 48,
      "instanceProperties": { "Label": "Start free", "ShowIcon": false }
    }
  ]
}
```

Instance overrides may use the readable property name declared by the component. The importer resolves it to Figma's generated internal key (Figma appends `#id` suffixes), so `{ "instanceProperties": { "Label": "Start free" } }` works for a component property named `Label`. Export strips those suffixes back to authored names. Without `componentPropertyReferences`, `instanceProperties` change nothing on the canvas.

Use `COMPONENT_SET` with only `COMPONENT` children to create variants. Name variant components using Figma's convention, such as `State=Default, Size=Large`.

For safer structured authoring, declare axes on the set and values on each child. The importer generates Figma's required names:

```json
{
  "type": "COMPONENT_SET",
  "w": 400,
  "h": 200,
  "variantAxes": { "State": ["Default", "Hover"], "Size": ["Small", "Large"] },
  "children": [
    { "type": "COMPONENT", "w": 160, "h": 40, "variant": { "State": "Default", "Size": "Small" } },
    { "type": "COMPONENT", "w": 200, "h": 52, "variant": { "State": "Hover", "Size": "Large" } }
  ]
}
```

Each declared variant value must exist in its axis options. Missing values use the first declared option.

## Prototype interactions

Use a `prototype` array containing modern Figma reactions. Every reaction has one trigger and one or more actions. Destination, variable, and collection references use JSON IDs or names and are resolved after the complete document is created:

```json
{
  "id": "next-button",
  "type": "FRAME",
  "w": 160,
  "h": 48,
  "prototype": [{
    "trigger": { "type": "ON_CLICK" },
    "actions": [{
      "type": "NAVIGATE",
      "destination": "confirmation-screen",
      "transition": { "type": "SMART_ANIMATE", "easing": "EASE_OUT", "duration": 0.3 },
      "resetScrollPosition": true
    }]
  }]
}
```

Triggers:

- Immediate interaction: `ON_CLICK`, `ON_HOVER`, `ON_PRESS`, `ON_DRAG`.
- Timed: `{ "type": "AFTER_TIMEOUT", "timeout": 1.5 }`.
- Mouse: `MOUSE_UP`, `MOUSE_DOWN`, `MOUSE_ENTER`, `MOUSE_LEAVE` with optional `delay`.
- Keyboard/controller: `ON_KEY_DOWN` with `device` and numeric `keyCodes`.
- Media: `ON_MEDIA_HIT` with `mediaHitTime`, or `ON_MEDIA_END`.

Actions:

- Node actions: `NAVIGATE`, `SWAP`, `OVERLAY`, `SCROLL_TO`, and `CHANGE_TO`; provide `destination`.
- History/overlay: `BACK` and `CLOSE`.
- External links: `URL` with `url` and optional `openInNewTab`.
- Media: `UPDATE_MEDIA_RUNTIME` with a media action such as `PLAY`, `PAUSE`, `MUTE`, `SKIP_FORWARD`, or `SKIP_TO`.
- Variables: `SET_VARIABLE`, `SET_VARIABLE_MODE`, and `CONDITIONAL`.

Transitions accept `INSTANT`, `DISSOLVE`, `SMART_ANIMATE`, `SCROLL_ANIMATE`, `MOVE_IN`, `MOVE_OUT`, `PUSH`, `SLIDE_IN`, and `SLIDE_OUT`. Directional transitions also accept `direction` and `matchLayers`. Easing accepts Figma easing names or a native easing object.

Multiple actions execute from one trigger:

```json
{
  "trigger": { "type": "ON_CLICK" },
  "actions": [
    { "type": "SET_VARIABLE", "variable": "has-booked", "value": true },
    { "type": "NAVIGATE", "destination": "confirmation" }
  ]
}
```

Multiple actions and advanced variable/conditional actions depend on the Figma plan used to run the plugin. The public Plugin API exposes them, but Figma may reject them with `You cannot create multiple actions on Reactions with your current plan`. When that happens, the importer automatically retries with one action per reaction. It prioritizes navigation, back/close, and URL actions over state-only actions, then reports every omitted action as an import warning. Use a single action per reaction when creating samples intended to work on every Figma plan.

Conditions use expression functions and variable references:

```json
{
  "type": "CONDITIONAL",
  "blocks": [
    {
      "condition": {
        "function": "EQUALS",
        "arguments": [{ "variable": "menu-open" }, true]
      },
      "actions": [{ "type": "SET_VARIABLE", "variable": "menu-open", "value": false }]
    },
    {
      "actions": [{ "type": "SET_VARIABLE", "variable": "menu-open", "value": true }]
    }
  ]
}
```

Expression functions include arithmetic, comparison, Boolean, negation, and variable-mode lookup operations supported by Figma. The final condition block may omit `condition` to act as `else`.

Scrolling frames also support `overflowDirection` with authored `NONE` / `*_SCROLLING` names or canonical `NONE` / `HORIZONTAL` / `VERTICAL` / `BOTH` (both forms are accepted and normalize to the short set), plus `numberOfFixedChildren`. Figma represents fixed layers as the final children in a scrolling frame.

The plugin uses Figma's current `actions[]` reaction API. Prototype reactions are exported back into the same compact structure. Figma's overlay-position, overlay-background, and click-outside properties are currently read-only in the public Plugin API and therefore cannot be authored by this language.

## Boolean operations

Use `operation: "UNION|SUBTRACT|INTERSECT|EXCLUDE"` and at least one shape child. Child coordinates remain relative to the boolean node.

## Variables, styles, and bindings

Create variables:

```json
{
  "variables": [{
    "name": "Tokens",
    "items": [
      { "id": "brand", "name": "color/brand", "type": "COLOR", "value": { "r": 0, "g": 25, "b": 168, "a": 1 } },
      { "id": "space-md", "name": "space/md", "type": "FLOAT", "value": 16 }
    ]
  }]
}
```

Variable types are `COLOR`, `FLOAT`, `STRING`, and `BOOLEAN`. Their values are strictly typed: a `COLOR` uses an `{r,g,b,a}` colour object, `FLOAT` uses a number, `STRING` uses a string, and `BOOLEAN` uses a Boolean. Bind them to nodes by ID or name:

Collections may declare Figma modes for themes, brands, densities, or breakpoints. Use `values` keyed by the exact mode names:

```json
{
  "variables": [{
    "name": "Theme",
    "modes": ["Light", "Dark"],
    "items": [
      { "id": "surface", "name": "colour/surface", "type": "COLOR", "values": {
        "Light": { "r": 248, "g": 245, "b": 238, "a": 1 },
        "Dark": { "r": 26, "g": 27, "b": 24, "a": 1 }
      } },
      { "id": "page-gap", "name": "spacing/page", "type": "FLOAT", "values": { "Light": 32, "Dark": 32 } }
    ]
  }]
}
```

Select an explicit mode on a canvas or node with `variableModes`; descendants inherit it through Figma:

```json
{ "id": "dark-screen", "type": "FRAME", "w": 390, "h": 844, "variableModes": { "Theme": "Dark" } }
```

If `modes` is omitted, the original single `value` form writes to the collection's default mode. When modes are declared, every `values` object must provide a correctly typed value for each mode.

Figma limits the number of variable modes according to the file's plan. If the Variables API rejects additional modes because of that limit, the Figma adapter imports the available first mode, preserves its bindings, skips unavailable explicit mode selections, and reports which modes were omitted. Other variable or mode errors remain blocking.

```json
{
  "fill": "#0019A8",
  "bindings": {
    "fill": "brand",
    "width": "card-width",
    "cornerRadius": "radius-card"
  }
}
```

`fill` and `stroke` bind the first corresponding paint’s color. Other keys are passed to Figma’s variable-binding API and must be valid bindable fields for that node and variable type.

Create styles:

```json
{
  "styles": [
    { "id": "brand-style", "name": "Brand", "type": "PAINT", "paints": [{ "type": "SOLID", "color": { "r": 0, "g": 25, "b": 168 }, "opacity": 1 }] },
    { "id": "heading", "name": "Heading", "type": "TEXT", "font": { "family": "Arial", "style": "Bold", "size": 40 } }
  ]
}
```

Apply styles with `styleRefs: { "fill": "brand-style", "stroke": "border-style", "text": "heading" }`.

## Layout grids

Square grid:

```json
{ "layoutGrids": [{ "pattern": "GRID", "sectionSize": 8, "color": { "r": 0, "g": 25, "b": 168, "a": 0.1 } }] }
```

Columns or rows:

```json
{ "layoutGrids": [{ "pattern": "COLUMNS", "alignment": "STRETCH", "count": 12, "gutterSize": 20, "offset": 32, "color": { "r": 0, "g": 25, "b": 168, "a": 0.1 } }] }
```

Do not provide `sectionSize` for `STRETCH` rows or columns. It is valid with `MIN`, `MAX`, and `CENTER` alignment.

## Validation and failure behavior

The plugin validates before writing nodes. Errors include JSON paths, such as:

```text
nodes[0].children[2].properties.size: requires width and height greater than zero
```

Validation checks syntax, document shape, geometry, unique IDs, node and paint types, gradient stops, radii, opacity, text/SVG/vector requirements, compound children, point counts, and component references. Up to 30 issues are displayed.

Runtime errors are shown in the status panel. Newly created nodes, styles, and variable collections are removed after a failure. Reused resources updated before failure cannot be restored automatically.

## Limitations

- Remote image fills require a reachable HTTPS image URL whose host permits CORS. Local files and embedded data URLs are also supported. Oversized images are automatically downscaled to Figma's 4096-pixel dimension limit.
- No per-character paragraph alignment or OpenType feature control.
- OpenType feature flags cannot be written through Figma's public plugin API.
- Breakpoints create separate canvases; they do not create runtime-responsive prototypes.
- Variables and styles are reused by collection, name, and type where possible.
- SECTION and SLICE work most reliably as top-level nodes.
- Figma assigns native IDs; JSON IDs are import references only.

## LLM production checklist

1. Output exactly one strict JSON object and nothing else.
2. Use `canvas` or `canvases`, never both.
3. Do not include `version`, `properties`, or legacy node wrappers.
4. Use parent-relative coordinates and positive sizes.
5. Use explicit IDs for components and references.
6. Define components before their instances.
7. Use installed font family/style pairs.
8. Use hex colors for simple solids and paint objects for gradients.
9. Put masks before masked siblings.
10. Use separate canvases for materially different responsive layouts.
11. Include `layout` only on frames deliberately designed for Auto Layout.
12. Validate all rich-text ranges and variable binding types.
