# Compact Design

Compact Design JSON is an LLM-friendly design language. `@compact-design/core` is the reusable language engine, and the Figma plugin is its first reference adapter.

```text
Compact Design JSON
        ↓
@compact-design/core
  schema validation → normalization → semantic validation → lint / patch
        ↓
adapter
        ↓
Figma today; other tools can implement the same language independently
```

The dependency direction is deliberate: the Figma plugin depends on core; core never depends on Figma or its plugin API.

## Repository

```text
packages/core/       reusable @compact-design/core package
plugins/figma/       Figma adapter, plugin controller, and UI
spec/                authoritative Draft 2020-12 JSON Schema
examples/            maintained Compact Design fixtures
docs/                language and showcase documentation
```

This is one npm-workspaces monorepo and one Git repository. No package is published by this project setup.

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

## Language resources

- [Complete language documentation](./docs/DESIGN-LANGUAGE.md)
- [Showcase guide](./docs/SHOWCASE-GUIDE.md)
- [Authoritative JSON Schema](./spec/compact-design.schema.json)
- [Maintained examples](./examples/README.md)
- [`@compact-design/core` usage](./packages/core/README.md)

The compact authoring syntax remains the public format: hex fills, angle-based gradients, HUG sizing, elevation presets, shorthand shadows, responsive canvases, variables, styles, prototypes, components, images, and patches are normalized into a predictable canonical representation before an adapter consumes them.

## Figma adapter boundary

The Figma package owns native node creation, font loading, Figma styles and variables, component/instance APIs, plugin data, page state, image creation, import rollback, prototype API limitations, and Figma-to-Compact export translation. These are intentionally absent from core.

## License

Compact Design is licensed under the [Mozilla Public License 2.0](./LICENSE).
