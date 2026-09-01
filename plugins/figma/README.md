# Compact Design Figma plugin

The first reference adapter for Compact Design JSON. It consumes `@compact-design/core` for parsing, schema and semantic validation, normalization, linting, structured issues, and patch definitions.

This package owns only Figma-specific behavior: native node/resource creation, fonts, images, prototypes, page state, rollback, plugin data, and Figma export translation.

From the repository root:

```bash
npm run build -w @compact-design/figma-plugin
```

Then import [`manifest.json`](./manifest.json) in the Figma desktop app.

To let an AI import without pasting JSON, keep this plugin open and run `@compact-design/mcp`. The plugin UI polls `http://localhost:18791`.
