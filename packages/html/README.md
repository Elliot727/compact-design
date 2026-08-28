# `@compact-design/html`

HTML and CSS renderer for Compact Design JSON. The second reference adapter: same language as the Figma plugin, a browser as the surface.

This package owns only web output. Parsing, schema validation, normalization, semantic checks, and patches stay in `@compact-design/core`.

```bash
npm install @compact-design/html
```

In this monorepo it consumes core through npm workspaces.

## Public API

```ts
import { render, renderDocument, RenderError } from "@compact-design/html";

const { html, css, body } = render(input);
```

`render` validates with core, then prints a complete HTML document. `renderDocument` accepts an already-normalized `InternalDocument`. Patch documents throw `RenderError`.

Layout maps Auto Layout to flex or grid. Manual frames keep parent-relative coordinates. Variables and bindings resolve to CSS colours. `ON_CLICK` navigation becomes in-page links; `AFTER_TIMEOUT` and `BACK` use a small runtime script.

## CLI

```bash
npx compact-design-html document.json -o out.html
```

From this repository, after `npm run build`:

```bash
npm run render -- examples/design-language-showcase.json -o /tmp/northstar.html
```

Open the file in a browser. Fonts that are not web-safe are loaded from Google Fonts.

## Development

```bash
npm run build -w @compact-design/html
npm run test -w @compact-design/html
```
