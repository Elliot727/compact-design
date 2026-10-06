import { isPatchDocument, lint, validate, type ImportMode } from "@compact-design/core";
import { render } from "@compact-design/html";
import type { FigmaBridge } from "./bridge";
import { LANGUAGE_GUIDE } from "./guide";
import { embedFileImages } from "./images";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolContent {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const DOCUMENT = {
  type: "object",
  description: "Compact Design JSON object, or a string containing that JSON."
};

export const TOOLS: ToolDefinition[] = [
  {
    name: "get_language",
    description: "Compact Design authoring guide. Call this before writing JSON. Do not use Figma primitive drawing APIs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "validate",
    description: "Validate Compact Design JSON. Returns structured issues with path, code, and suggestion. Fix ERRORs before importing.",
    inputSchema: { type: "object", properties: { document: DOCUMENT }, required: ["document"] }
  },
  {
    name: "lint",
    description: "Advisory design-quality lint on a valid Compact Design document (contrast, touch targets, spacing, Auto Layout).",
    inputSchema: { type: "object", properties: { document: DOCUMENT }, required: ["document"] }
  },
  {
    name: "render_html",
    description: "Render a valid Compact Design document to a standalone HTML page. Does not touch Figma.",
    inputSchema: { type: "object", properties: { document: DOCUMENT, title: { type: "string" } }, required: ["document"] }
  },
  {
    name: "figma_status",
    description: "Whether the Compact Design Figma plugin is connected to this MCP bridge.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "figma_import",
    description: "Validate Compact Design JSON and create native Figma layers through the running plugin. Requires the plugin UI to stay open in Figma Desktop.",
    inputSchema: {
      type: "object",
      properties: {
        document: DOCUMENT,
        mode: { type: "string", enum: ["CREATE", "UPDATE", "REPLACE"], description: "CREATE new canvases, UPDATE matching IDs, or REPLACE matching canvases. Default CREATE." }
      },
      required: ["document"]
    }
  },
  {
    name: "figma_patch",
    description: "Apply a Compact Design patch (set/remove/append/insert/move/duplicate/wrap/unwrap) to layers previously imported by this plugin, atomically. May carry top-level variables/styles (upserted before operations; mode 0 never renamed; Figma restores tokens on failure). set changes only the listed keys: layout, layout.padding, font and constraints deep-merge; fill(s), stroke(s), effects/shadow/elevation, runs, layoutGrids, vectorPaths, dashPattern and cornerRadii replace. x/y are parent-relative. Unknown keys, keys that don't apply to the target, and not-yet-patchable keys (componentId, svg) are errors, never ignored. bindings/styleRefs/variableModes/instanceProperties/componentPropertyReferences/componentProperties/variantAxes/variant shallow-merge (null clears where allowed; variantAxes uses explicit {rename,renameOptions}; plain option arrays never rename; variant null rejected; componentProperties is name-keyed upsert). prototype replaces the full reaction list ([] clears; destinations must exist; NAVIGATE/SWAP/OVERLAY destinations must be top-level frames; AFTER_TIMEOUT only on a top-level target); insert places a child at index (clamped); move reparents/reorders with after-removal index semantics and keeps parent-relative x/y; duplicate clones a subtree with idSuffix (optional ids/parent/index; rejects COMPONENT sources and id collisions; same-patch ids are visible); wrap puts siblings into a new FRAME preserving absolute positions (bbox placement; optional w/h; AL direction reflows in Figma); unwrap dissolves a FRAME/GROUP promoting children (WARNING if fills/strokes/effects/clipsContent dropped).",
    inputSchema: { type: "object", properties: { document: DOCUMENT }, required: ["document"] }
  },
  {
    name: "figma_export",
    description: "Export Compact Design JSON from the open Figma file. scope 'page' exports every top-level layer on the current page. id exports one layer by its Compact Design id or Figma id and includes on-page main components so instances stay linked. Omit both to export the current selection.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["selection", "page"], description: "selection (default) or page." },
        id: { type: "string", description: "Compact Design id or Figma node id. Wins over scope." }
      },
      additionalProperties: false
    }
  }
];

export function parseDocumentArg(value: unknown): unknown {
  if (typeof value === "string") {
    try { return JSON.parse(value); }
    catch (error) { throw new Error(error instanceof Error ? error.message : String(error)); }
  }
  return value;
}

function textResult(value: unknown, isError = false): ToolContent {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError };
}

export function createToolRunner(bridge: FigmaBridge, cwd = process.cwd()) {
  return async function runTool(name: string, args: Record<string, unknown>): Promise<ToolContent> {
    switch (name) {
      case "get_language":
        return textResult(LANGUAGE_GUIDE);
      case "validate": {
        const parsed = parseDocumentArg(args.document);
        const result = validate(parsed);
        return textResult({ valid: result.valid, issues: result.issues, patch: Boolean(result.patch) }, !result.valid);
      }
      case "lint": {
        const parsed = parseDocumentArg(args.document);
        const result = validate(parsed);
        if (!result.valid || !result.document) return textResult({ valid: false, issues: result.issues }, true);
        return textResult({ valid: true, issues: lint(result.document) });
      }
      case "render_html": {
        const parsed = parseDocumentArg(args.document);
        try {
          const output = render(parsed, { title: typeof args.title === "string" ? args.title : undefined });
          return textResult({ html: output.html, css: output.css });
        } catch (error) {
          return textResult(error instanceof Error ? error.message : String(error), true);
        }
      }
      case "figma_status":
        return textResult({ ...bridge.status(), hint: bridge.status().pluginConnected ? "Plugin is polling. You can figma_import." : "Open Plugins → Development → Compact Design Importer in Figma Desktop." });
      case "figma_import": {
        const parsed = parseDocumentArg(args.document);
        const result = validate(parsed);
        if (!result.valid || !result.document) return textResult({ imported: false, issues: result.issues }, true);
        if (result.patch) return textResult({ imported: false, message: "This is a patch document. Call figma_patch instead." }, true);
        await embedFileImages(result.document, cwd);
        const mode = (args.mode === "UPDATE" || args.mode === "REPLACE" ? args.mode : "CREATE") as ImportMode;
        const outcome = await bridge.importDocument(result.document, mode);
        return textResult(outcome, !outcome.ok);
      }
      case "figma_patch": {
        const parsed = parseDocumentArg(args.document);
        const result = validate(parsed);
        if (!result.valid) return textResult({ patched: false, issues: result.issues }, true);
        if (!result.patch) {
          if (isPatchDocument(parsed)) return textResult({ patched: false, issues: result.issues }, true);
          return textResult({ patched: false, message: "Expected a patch document with a top-level patch.operations array." }, true);
        }
        await embedFileImages(result.patch, cwd);
        const outcome = await bridge.applyPatch(result.patch);
        return textResult(outcome, !outcome.ok);
      }
      case "figma_export": {
        const scope = args.scope === "page" || args.scope === "selection" ? args.scope : undefined;
        const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : undefined;
        const outcome = await bridge.exportDocument({ scope, id });
        return textResult(outcome, !outcome.ok);
      }
      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  };
}
