# Using the complete showcase

[`examples/design-language-showcase.json`](../examples/design-language-showcase.json) is a large, paste-ready Compact Design JSON document. It is both a visual demo and a practical source file for LLMs.

## Import it

1. Run `npm install` once, then `npm run build`.
2. In Figma desktop, import `plugins/figma/manifest.json` as a development plugin.
3. Run **JSON to Figma**.
4. Drag `examples/design-language-showcase.json` onto the uploader, or paste its contents.
5. Confirm that validation passes, then choose **Create design**.

The import creates one large 1600×1200 canvas containing a finished Northstar analytics dashboard. It is intended to look like a real product screen rather than an API reference board.

## What the file demonstrates

- A complete application canvas with sidebar navigation, toolbar, metric cards, charts, a data table, and activity feed.
- Reusable color, float, string, and boolean variables.
- Paint and text styles, plus real node bindings and style references.
- Manual positioning, constraints, clipping, masks, locking, opacity, and blend modes.
- Horizontal and vertical Auto Layout, padding, gaps, alignment, HUG, FILL, FIXED, and STRETCH shorthand.
- Uniform and individual radii, per-node strokes, dashed lines, gradients by angle, radial gradients, shadows, elevation presets, blur, and layered effects.
- Rich text runs, links, decoration, paragraph spacing, letter spacing, line height, and alignment.
- Rectangles, ellipses, lines, polygons, stars, arcs, inline SVG, boolean operations, sections, and slices.
- Dashboard visualisation primitives including a filled line chart, donut chart, segmented controls, status pills, avatars, and table rows.

## How to author a new file

Start with the document shell:

```json
{
  "variables": [],
  "styles": [],
  "canvases": [
    {
      "id": "desktop",
      "name": "Desktop",
      "width": 1440,
      "height": 1000,
      "fill": "#FFFFFF",
      "nodes": []
    }
  ]
}
```

Add reusable resources first, component definitions next, and instances afterward. Coordinates are relative to the parent. Add `layout` only when the frame should become Auto Layout; its presence is the switch. Prefer `HUG` in JSON—the importer translates it to Figma's internal `AUTO` value.

Every node needs positive `w` and `h`. `type`, `x`, `y`, name, ID, styles, and children can be omitted when their defaults are acceptable. Give explicit unique IDs to anything referenced by an instance, prototype, binding, or style reference.

## Prompt an LLM

Give the model this file together with [`DESIGN-LANGUAGE.md`](./DESIGN-LANGUAGE.md), then use a prompt like:

```text
Create one strict Compact Design JSON object using only the current API in
DESIGN-LANGUAGE.md. Use examples/design-language-showcase.json as a structural reference,
but create an original design for [PRODUCT]. Include desktop and mobile canvases,
define reusable tokens and components before instances, use Arial font styles,
and return JSON only. All node sizes must be positive and every reference ID must
exist earlier in the document.
```

Do not ask the model to copy Figma's REST API. This compact language is the input API. Avoid legacy `properties` wrappers, schema versions, CSS values such as `24px`, and unsupported parent Auto Layout enums.

## Useful editing patterns

Change the palette once by editing variable values, and preserve node bindings. Create a gradient with `angle` and `stops`; a matrix is only needed for precise radial/angular/diamond control. Use `elevation` for standard depth or `shadow` for custom layers. Use separate canvases when the responsive composition changes materially.

The complete field reference, enum values, defaults, validation rules, and limitations remain in [`DESIGN-LANGUAGE.md`](./DESIGN-LANGUAGE.md).
