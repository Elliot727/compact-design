# Changelog

## Unreleased

### Features

- **feat(core,figma,mcp): patch `wrap` / `unwrap`** — compose siblings into a new FRAME or dissolve a FRAME/GROUP. Absolute-preserving (unlike `move`'s parent-relative keep): wrapper at bbox; omitted `w`/`h` derive from bbox. Auto Layout on the wrapper reflows in Figma; free wrap keeps positions. Unwrap into an AL parent promotes flow items at the wrapper's slot (`layoutPositioning: ABSOLUTE` keeps abs). Under an AL parent, wrap seats the wrapper at `ids[0]`'s slot. Unwrap of a wrapper with fills/strokes/effects/`clipsContent` emits a WARNING (identical in both engines). Top-level wrap/unwrap allowed so end-of-patch #42 checks fire (wrapping a NAVIGATE destination nests it; unwrapping a canvas that splits SCROLL_TO fails). Rotation rejected. Schema `wrapNode`; MCP guide/tools + DESIGN-LANGUAGE.
- **feat(core,figma,mcp): upsert `variables` / `styles` in a patch document** — patch documents may carry top-level tokens; they are upserted before operations so later ops can bind. Shared `applyResourceUpsert` / `matchStyle` / `matchVariable` keep core and Figma in lockstep. Figma snapshots touched tokens (including `compactDesignId`) and restores them on failure. Empty `operations` is allowed when `variables`/`styles` are present (token-only patches). Name-match with a different id, and duplicate ids across collections, are `PATCH_RESOURCE_CONFLICT`. New variables missing a mode value fail in the shared plan (`PATCH_RESOURCE_INVALID`). Unknown mode keys in `values` are `PATCH_RESOURCE_INVALID`. Mode 0 is never renamed by a patch.

## 0.3.0 — 2026-10-06

Published packages: `@compact-design/core`, `@compact-design/html`, `@compact-design/mcp` (Figma plugin is not on npm).

### Breaking (pre-1.0)

- **#36 / insert & move** (`14b6adb`): patch ops `insert` and `move`. **Breaking:** appending into an INSTANCE now errors.
- **#37 / typed merging patch set** (`4706053`, `3c4e8ea`): typed, merging `set` with deep-merge for layout/font/constraints and replace for paint/effect/run arrays. **Breaking:** patch `set` x/y is now **parent-relative** (was absolute in core); unknown `set` keys fail (schema `additionalProperties: false`). Post-patch validation reports only issues the patch introduces.
- **#38 / componentPropertyReferences** (`e2bce8f`): link component properties to child layers (TEXT/BOOLEAN/INSTANCE_SWAP). **Breaking:** `VARIANT` removed from `ComponentPropertyType`; a linked INSTANCE exports without children (structure comes from the main component).
- **#40 / componentProperties, variantAxes, variant** (`858b46e`): name-keyed upsert / explicit renames / merge. **Breaking:** `validateDocument` rejects `variantAxes` options no child COMPONENT carries; renames are explicit (`{ rename, options, renameOptions }` — plain option arrays never rename); `variant: null` on a set child is rejected.
- **#42 / prototype set** (`af53f94`): full-replace `set.prototype` (`[]` clears). **Breaking:** `validateDocument` rejects missing or invalid prototype destinations (was lint-only); patches that remove a linked destination fail; `set.prototype` requires **top-level** destinations for NAVIGATE/SWAP/OVERLAY, and AFTER_TIMEOUT only on top-level nodes (import stays lenient).

### Features

- **#39** (`59d44aa`): patch `set` for `bindings`, `styleRefs`, `variableModes`, `instanceProperties`, and `componentPropertyReferences` (shallow-merge; `null` clears a field or the whole map). Lockstep core/Figma with full rollback.
- **#41** (`f621ef9`): patch `duplicate` op — clone a subtree with required `id` + `idSuffix`, optional `ids`/`parent`/`index`. Prefer `duplicate` for screens/states/one-offs; COMPONENT/INSTANCE for repeats.
- **#42** also: CHANGE_TO→COMPONENT; SCROLL_TO same canvas; Figma `setReactionsAsync` + plan-limit WARNING. `componentId` stays deferred.
- **#40** also: Figma add/edit/delete for `componentProperties`; variantAxes renames rewrite instance VARIANT overrides only for instances of the patched set.
- **#38** also: Figma import/export round-trips authored names ↔ generated `#id` keys; HTML honours TEXT/BOOLEAN overrides when refs are present.
- **#35** (`f47778d`): docs(mcp) — text typography controls and `numberOfFixedChildren` in LANGUAGE_GUIDE.

### Fixes

- fix(figma): patch rollback re-links COMPONENT instances via `getMainComponentAsync`; per-key `instanceProperties: null` resets to the component defaultValue; fill/stroke bindings require a SOLID first paint.
- fix(figma): only remap INSTANCE_SWAP instance/default values from compact ids to Figma ids (TEXT overrides that match a node id stay text).

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
