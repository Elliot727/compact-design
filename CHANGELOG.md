# Changelog

## Unreleased

**Breaking (pre-1.0): patch `set` now has a typed contract.**

- Unknown `set` keys now fail. The schema's new `$defs.patchSet` (`additionalProperties: false`), `normalizePatch`, `validatePatch`, and the Figma plugin all reject them. Previously, typos validated and then did nothing. `validate()` no longer reports every patch document as valid.
- **Existing patches that use absolute x/y will now land in a different place.** Patch `set` x/y are now parent-relative in core, as authoring and the Figma plugin already were. Before this change, core treated them as absolute canvas coordinates. `insert`/`append` node coordinates are parent-relative in core too, and `move` now keeps a node's parent-relative offset in core, as Figma does. Rewrite such patches with coordinates relative to the target's parent.
- `layout`, `layout.padding`, `font`, and `constraints` deep-merge. Paint, effect, run, grid, path, dash, and corner-radii arrays replace. `{ "font": { "size": 32 } }` no longer resets the family to Arial, and a partial layout no longer wipes padding or alignment. A set adds no defaults (no TEXT fill injection).
- Keys that cannot be applied are errors in both core and Figma: `bindings`, `styleRefs`, `variableModes`, `prototype`, `componentId`, `componentProperties`, `instanceProperties`, `variantAxes`, `variant`, `svg`, keys that do not apply to the target type, and Auto Layout or text-styling conflicts (see DESIGN-LANGUAGE.md). Previously, Figma silently ignored about half of the node keys.
- New core exports: `PATCH_SET_KEYS`, `PATCH_SET_SEMANTICS`, `PATCH_SET_APPLIES_TO`, `patchSetTargetIssues`, `validatePatch(document, patch)`, and `PatchError`. `applyPatch` now validates the patched document and throws `PatchError`. `PatchOperation.normalized` is now a type-agnostic `PatchSetValues` with only the authored keys.
- Figma: patch rollback now replays an ordered undo log with backups kept in a hidden holder frame. This fixes stale backups when a `set` follows a `move` of the same node, or when an ancestor is set after its children. After updating, reload the Figma plugin from `plugins/figma/manifest.json`.

## 0.2.0 — 2026-10-06

Published packages: `@compact-design/core`, `@compact-design/html`, `@compact-design/mcp` (Figma plugin is not on npm).

- fix(html): emit fill="none" for VECTOR paths with windingRule NONE (#33) (998be47)
- feat(html): route ARC strokes through svgPaintStrokeAttrs (#32) (cb89bfb)
- feat(core,figma): round-trip SHADER effects via importShaderById (#31) (cb1ff65)
- feat(html): emit SVG strokes for VECTOR, POLYGON, and STAR (#30) (1251504)
- feat(html): map SMALL_CAPS and hangingPunctuation text chrome (#29) (90e60f6)
- feat(mcp): document effect types and BOOLEAN_OPERATION operation (#28) (87e6690)
- feat(html): paint layoutGrids as non-interactive CSS overlays (#27) (5e962df)
- feat(core,figma): round-trip NOISE, TEXTURE, and GLASS effects (#26) (a6894ba)
- feat(core): require valid BOOLEAN_OPERATION operation enum (#25) (3bc0b5f)
- fix(figma): strip node-only props from exported canvas (#24) (81314e6)
- feat(html): honour numberOfFixedChildren as sticky scroll chrome (#23) (cc635c3)
- fix(figma): Export selection dynamic-page getMainComponentAsync crash (#22) (778c726)
- feat(core): accept both overflowDirection name forms (#21) (6d4263c)
- feat(figma): export overflowDirection and numberOfFixedChildren (#20) (fa2f947)
- feat(html): honour paragraphSpacing between TEXT paragraphs (#19) (a0bd1ae)
- feat(figma): export textCase, paragraphIndent, listSpacing, hangingPunctuation, hangingList (#18) (9c012c5)
- feat(html): honour strokeAlign for CSS strokes (#17) (4c732ff)
- feat(mcp): catch up LANGUAGE_GUIDE for styles, grids, strokes, isMask (#16) (63fa766)
- feat(html): honour isMask sibling masks (#15) (d0bfad2)
- feat(core): validate styleRefs against document.styles (#14) (1d68c85)
- ci(release): npm Trusted Publishing (OIDC) for batch-release (#12) (1618f7d)
- feat(figma): export paint/text styles and styleRefs (#13) (c8fb150)
- feat(figma): export strokeAlign, strokeCap, strokeJoin (#11) (c36234f)
- feat(html): render LINE nodes as SVG strokes (#10) (20dc3fc)
- feat(figma): export layoutGrids on frames (#9) (2764c0a)
- feat(mcp): expand get_language guide for variables and bindings (e92d1fb)
- ci: batch-release label workflow for npm packages (6135bb9)
- feat(core): validate bindings and variableModes references (b871af9)
- feat(figma): export variables, bindings, and variableModes (91b1dea)
- feat(html): live theme switching via SET_VARIABLE_MODE (8881665)
- feat(html): render ARC nodes as SVG paths (bf5d9fb)
- feat(html): emit text-shadow for TEXT drop shadows (d31c129)
- feat(html): emit link, textDecoration, letterSpacing on text runs (e78b1ef)
- Export a Figma page or one layer by id. (1e00347)
- Fix Figma export of instances, prototypes, and HUG sizing (d6cfee8)
- Fix Figma export validation errors (9f1ce40)
- Add MCP server and Figma bridge (df973d0)
- Add HTML renderer and prepare core/html for npm. (ed0533d)
- Point every example at the current Compact Design schema (37cafda)
- Initial commit: Compact Design language, core, and Figma adapter (b87dcfc)

Release notes for `@compact-design/core`, `@compact-design/html`, and `@compact-design/mcp` are prepended here by `scripts/prepare-batch-release.mjs` when a batch release is prepared. The Figma plugin is not published to npm.
