# Changelog

## Unreleased

- feat(core,figma,mcp): enable patch `set` for `prototype` (full replace; `[]` clears). Destinations checked eagerly and at end of patch. NAVIGATE/SWAP/OVERLAY destinations must be top-level frames (no remapping in set; import stays lenient). AFTER_TIMEOUT only on a top-level target. CHANGE_TO→COMPONENT; SCROLL_TO same canvas. Figma `setReactionsAsync` + plan-limit WARNING. `componentId` stays deferred.
- **Breaking:** `validateDocument` now rejects any document (authored or patched) whose prototype destinations are missing or violate CHANGE_TO/SCROLL_TO rules. Previously those were lint-only (`BROKEN_PROTOTYPE_DESTINATION`).
- feat(core,figma,mcp): add patch `duplicate` op — clone a subtree with required `id` + `idSuffix`, optional `ids`/`parent`/`index`. Lockstep core/Figma: same-patch visibility for created ids (incl. every duplicated layer), plugin-data rewrite on clone, prototype re-point inside the subtree, create-log rollback, and pre-existing-issue exemption via id-map. Rejects COMPONENT/COMPONENT_SET sources, INSTANCE parents, collisions, and `ids` keys outside the source subtree. Prefer `duplicate` for screens/states/one-offs; COMPONENT/INSTANCE for repeats.
- feat(core,figma,mcp): enable patch `set` for `componentProperties`, `variantAxes`, and `variant` in lockstep. `componentProperties` is a name-keyed upsert on COMPONENT (null deletes; type immutable; Figma add/edit/delete only). `variantAxes` shallow-merges on COMPONENT_SET with **explicit** renames (`{ rename, options, renameOptions }`); plain option arrays never rename. Every declared option must be carried by a child (Figma derives options from child names). Renames rewrite instance VARIANT overrides only for instances of the patched set. `variant`/`variant: null` clearing is rejected. COMPONENT rollback loads all pages before `findAllWithCriteria`. Still deferred: `prototype`, `componentId`.
- **Breaking:** `validateDocument` now rejects any authored document (not only patched ones) that declares a `variantAxes` option no child COMPONENT carries. Figma derives variant options from child names; Compact keeps the same rule so core and Figma stay in lockstep.


- fix(figma): patch rollback re-links COMPONENT instances via `getMainComponentAsync` (no sync `mainComponent` under dynamic-page); per-key `instanceProperties: null` resets to the component defaultValue in lockstep with core; fill/stroke bindings require a SOLID first paint (clear error).

- feat(core,figma,mcp): enable patch `set` for `bindings`, `styleRefs`, `variableModes`, `instanceProperties`, and `componentPropertyReferences` (shallow-merge; `null` clears a field or the whole map). Core and Figma apply in lockstep with full rollback; INSTANCE_SWAP values use the type-aware remap path; setting raw fill/font on a bound/styled node detaches with a WARNING. Still deferred at the time: `prototype`, `componentId` (destination/main remapping), `componentProperties`/`variantAxes`/`variant` (enabled in the feat above).

- feat(core,figma,html,mcp): link component properties to child layers via `componentPropertyReferences` (TEXT `characters`, BOOLEAN `visible`, INSTANCE_SWAP `mainComponent`). Validates against the nearest ancestor COMPONENT; Figma import/export round-trips authored names ↔ generated `#id` keys; HTML honours TEXT/BOOLEAN overrides when refs are present. VARIANT stays on `variantAxes`/`variant` (removed from authorable `componentProperties` types). Patching of `componentProperties`/`variantAxes`/`variant` is enabled in the Unreleased feat above.
- fix(figma): only remap INSTANCE_SWAP instance/default values from compact ids to Figma ids (TEXT overrides that match a node id stay text). Core validates INSTANCE_SWAP targets are COMPONENT ids; Figma throws a clear missing-component error instead of passing a raw id through.
- Export of a linked INSTANCE no longer includes its children (structure comes from the main component), matching import which already ignored them.

**Breaking (pre-1.0): patch `set` now has a typed contract.**

- Unknown `set` keys now fail. The schema's new `$defs.patchSet` (`additionalProperties: false`), `normalizePatch`, `validatePatch`, and the Figma plugin all reject them. Previously, typos validated and then did nothing. `validate()` no longer reports every patch document as valid.
- **Existing patches that use absolute x/y will now land in a different place.** Patch `set` x/y are now parent-relative in core, as authoring and the Figma plugin already were. Before this change, core treated them as absolute canvas coordinates. `insert`/`append` node coordinates are parent-relative in core too, and `move` now keeps a node's parent-relative offset in core, as Figma does. Rewrite such patches with coordinates relative to the target's parent.
- `layout`, `layout.padding`, `font`, and `constraints` deep-merge. Paint, effect, run, grid, path, dash, and corner-radii arrays replace. `{ "font": { "size": 32 } }` no longer resets the family to Arial, and a partial layout no longer wipes padding or alignment. A set adds no defaults (no TEXT fill injection).
- Keys that cannot be applied are errors in both core and Figma: deferred keys (`prototype`, `componentId`), `svg`, keys that do not apply to the target type, and Auto Layout or text-styling conflicts (see DESIGN-LANGUAGE.md). `bindings`/`styleRefs`/`variableModes`/`instanceProperties`/`componentPropertyReferences` are now patchable (see Unreleased feat above). Previously, Figma silently ignored about half of the node keys.
- New core exports: `PATCH_SET_KEYS`, `PATCH_SET_SEMANTICS`, `PATCH_SET_APPLIES_TO`, `patchSetTargetIssues`, `validatePatch(document, patch)`, `newDocumentIssues(before, after)`, and `PatchError`. `applyPatch` now validates the patched document and throws `PatchError`. `PatchOperation.normalized` is now a type-agnostic `PatchSetValues` with only the authored keys. Only issues the patch introduces fail it. Issues already in the input document, compared by node id and property path rather than array index, never block a patch.
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
