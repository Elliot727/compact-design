# Compact Design

Compact Design JSON is an LLM-friendly design language. `@compact-design/core` is the reusable language engine. The Figma plugin and the HTML renderer are reference adapters.

```text
Compact Design JSON
        ↓
@compact-design/core
  schema validation → normalization → semantic validation → lint / patch
        ↓
adapter
        ↓
Figma and HTML/CSS today; other tools can implement the same language independently
```

The dependency direction is deliberate: adapters depend on core; core never depends on Figma, the DOM, or an adapter.

## Repository

```text
packages/core/       reusable @compact-design/core package
packages/html/       HTML + CSS renderer
packages/mcp/        MCP server: validate JSON and import into the Figma plugin
plugins/figma/       Figma adapter, plugin controller, and UI
spec/                authoritative Draft 2020-12 JSON Schema
examples/            maintained Compact Design fixtures
docs/                language and showcase documentation
```

This is one npm-workspaces monorepo and one Git repository. Published packages:

```bash
npm install @compact-design/core
npm install @compact-design/html
npm install @compact-design/mcp
```

The Figma plugin is not an npm package. Import [`plugins/figma/manifest.json`](./plugins/figma/manifest.json) in the Figma desktop app, or publish it from **Plugins → Manage plugins**.

To skip the JSON paste step, run the plugin in Figma Desktop and point your MCP client at `@compact-design/mcp`. The model writes Compact Design JSON; the server validates it and the plugin creates native layers. See [`packages/mcp/README.md`](./packages/mcp/README.md).

## Development

Install and verify everything from the repository root:

```bash
npm install
npm run build
npm test
npm run typecheck
npm run lint
```

`npm run check` runs typechecking, tests, boundary checks, and both builds.

For Figma development, run `npm run build`, then import [`plugins/figma/manifest.json`](./plugins/figma/manifest.json) through **Plugins → Development → Import plugin from manifest…**. Generated plugin files are written to `plugins/figma/dist/`.

To print a document as a web page:

```bash
npm run render -- examples/design-language-showcase.json -o /tmp/northstar.html
```

## Language resources

- [Complete language documentation](./docs/DESIGN-LANGUAGE.md)
- [Showcase guide](./docs/SHOWCASE-GUIDE.md)
- [Authoritative JSON Schema](./spec/compact-design.schema.json)
- [Maintained examples](./examples/README.md)
- [`@compact-design/core` usage](./packages/core/README.md)
- [`@compact-design/html` renderer](./packages/html/README.md)
- [`@compact-design/mcp` server](./packages/mcp/README.md)

The compact authoring syntax remains the public format: hex fills, angle-based gradients, HUG sizing, elevation presets, shorthand shadows, responsive canvases, variables, styles, prototypes, components, images, and patches are normalized into a predictable canonical representation before an adapter consumes them.

## Figma adapter boundary

The Figma package owns native node creation, font loading, Figma styles and variables, component/instance APIs, plugin data, page state, image creation, import rollback, prototype API limitations, and Figma-to-Compact export translation. The HTML package owns CSS layout, paints, and in-page prototype behaviour. These are intentionally absent from core.

## License

Compact Design is licensed under the [Mozilla Public License 2.0](./LICENSE).
