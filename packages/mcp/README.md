# `@compact-design/mcp`

MCP server for Compact Design. The model writes Compact Design JSON; this server validates it and, if the Figma plugin is open, imports it as native layers.

```text
AI  →  Compact Design JSON  →  @compact-design/mcp  →  localhost bridge  →  Figma plugin  →  Figma file
```

This does **not** wrap Figma’s plugin API as a pile of `create_rectangle` tools. The language stays Compact Design. The Figma plugin is still the only place that calls `figma.*`.

## Install

```bash
npm install -g @compact-design/mcp
```

The Compact Design Figma plugin must be running in **Figma Desktop** (the UI iframe polls `http://localhost:18791`). Browser Figma cannot reach localhost.

## Claude / Cursor

```json
{
  "mcpServers": {
    "compact-design": {
      "command": "npx",
      "args": ["-y", "@compact-design/mcp"]
    }
  }
}
```

## Grok

```toml
[mcp_servers.compact-design]
command = "npx"
args = ["-y", "@compact-design/mcp"]
```

From this repository after `npm run build`:

```toml
[mcp_servers.compact-design]
command = "node"
args = ["packages/mcp/scripts/cli.mjs"]
```

## Workflow

1. Run the Compact Design plugin in a Figma file.
2. Ask the model to design something.
3. It should call `get_language` → write JSON → `validate` → `figma_import`.

Paste-into-the-plugin still works. MCP is the same importer without the clipboard.

## Tools

| Tool | Figma required |
|---|---|
| `get_language` | no |
| `validate` | no |
| `lint` | no |
| `render_html` | no |
| `figma_status` | no |
| `figma_import` | yes |
| `figma_patch` | yes |
| `figma_export` | yes. `scope: "page"` reads the current page. `id` reads one layer and keeps on-page main components linked. The default is the current selection. |

Override the bridge port with `COMPACT_DESIGN_MCP_PORT` (default `18791`). The plugin currently expects the default port.

## Development

```bash
npm run build -w @compact-design/mcp
npm run test -w @compact-design/mcp
```
