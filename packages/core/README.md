# `@compact-design/core`

Reusable Compact Design JSON language tooling with no dependency on Figma or the Figma Plugin API.

```bash
npm install @compact-design/core
```

In this monorepo the Figma adapter and HTML renderer consume it through npm workspaces.

## Public API

```ts
import {
  validate,
  normalize,
  lint,
  normalizePatch,
  applyPatch,
  indexDocument,
  schema
} from "@compact-design/core";
```

### Validate

`validate` runs the authoritative Draft 2020-12 schema and the semantic checks needed for cross-node rules.

```ts
const result = validate(input);

if (!result.valid) {
  console.log(result.issues);
} else if (result.document) {
  console.log(result.document.nodes);
}
```

Issues contain `severity`, `code`, `path`, `message`, and an optional `suggestion`.

### Normalize

```ts
const document = normalize({
  canvas: { width: 320, height: 240 },
  nodes: [{ type: "RECTANGLE", w: 100, h: 40, fill: "#6C5CFF" }]
});
```

Normalization retains the concise authoring language and expands defaults and shorthands into the canonical adapter-facing representation.

### Lint

```ts
const findings = lint(document);
```

Lint findings are advisory checks for contrast, touch targets, spacing, missing Auto Layout, repeated detached elements, token usage, text overflow, component usage, and broken prototype destinations.

### Patch

```ts
const patch = normalizePatch({
  patch: { operations: [{ op: "set", id: "title", set: { text: "Updated" } }] }
});

const { document: updated, affectedIds } = applyPatch(document, patch);
```

Core patching returns a new canonical document. Adapter-specific transactional behavior—such as cloning and rolling back native Figma nodes—belongs to the adapter.

### Schema

```ts
console.log(schema.$schema); // Draft 2020-12
```

The sole source schema is [`spec/compact-design.schema.json`](https://github.com/Elliot727/compact-design/blob/main/spec/compact-design.schema.json). The package build generates its programmatic module from that file, preventing a hand-maintained second copy.

## Package boundary

Core contains no `figma.*` calls, Figma ambient node types, Figma runtime state, or `@figma/plugin-typings` dependency. Its canonical types are owned by Compact Design and use ordinary TypeScript structures.

## License

Mozilla Public License 2.0. The package build includes the repository's canonical `LICENSE` file in the npm package.
