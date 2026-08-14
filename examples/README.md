# Maintained examples

These examples target the current Compact Design JSON schema. Files that include `$schema` reference the authoritative schema in [`../spec/compact-design.schema.json`](../spec/compact-design.schema.json).

| File | Purpose |
|---|---|
| [`design-language-showcase.json`](./design-language-showcase.json) | Broad API and node-type showcase; the best structural reference for LLMs. |
| [`image-fill-sample.json`](./image-fill-sample.json) | Remote images, image sizing and image-fill behaviour. |
| [`local-image-sample.json`](./local-image-sample.json) | Minimal `file:filename.jpg` local-upload workflow. Select a matching local file before importing. |
| [`prototype-basic-sample.json`](./prototype-basic-sample.json) | Three-screen prototype using navigation, back, URL and timed reactions that work with one action per reaction. |
| [`update-patch-theme-sample.json`](./update-patch-theme-sample.json) | Live Light/Dark variable modes, bindings and explicit theme selection. Import this before the patch sample. |
| [`update-patch-sample.json`](./update-patch-sample.json) | Stable-ID `set` and `append` operations targeting the theme sample. |

Run the full project verification before publishing changes:

```bash
npm run check
jq empty examples/*.json spec/compact-design.schema.json
```
