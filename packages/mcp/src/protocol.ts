import { schema } from "@compact-design/core";
import { LANGUAGE_GUIDE } from "./guide";
import { TOOLS, type ToolContent } from "./tools";

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ServerContext {
  runTool: (name: string, args: Record<string, unknown>) => Promise<ToolContent>;
}

const PROTOCOL = "2025-03-26";
const SERVER_INFO = { name: "compact-design", version: "0.1.0" };

export async function handleRpc(message: JsonRpcRequest, context: ServerContext): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const method = message.method || "";
  if (message.id === undefined && method.startsWith("notifications/")) return null;
  try {
    const result = await dispatch(method, message.params, context);
    if (id === null && message.id === undefined) return null;
    return { jsonrpc: "2.0", id, result };
  } catch (error) {
    if (id === null && message.id === undefined) return null;
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : -32603;
    return { jsonrpc: "2.0", id, error: { code, message: error instanceof Error ? error.message : String(error) } };
  }
}

async function dispatch(method: string, params: unknown, context: ServerContext): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: SERVER_INFO
      };
    case "ping":
    case "logging/setLevel":
    case "notifications/initialized":
    case "notifications/cancelled":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const call = asObject(params);
      const name = String(call.name || "");
      const args = asObject(call.arguments);
      return await context.runTool(name, args);
    }
    case "resources/list":
      return {
        resources: [
          { uri: "compact-design://guide", name: "Authoring guide", mimeType: "text/markdown" },
          { uri: "compact-design://schema", name: "JSON Schema", mimeType: "application/schema+json" }
        ]
      };
    case "resources/read": {
      const uri = String(asObject(params).uri || "");
      if (uri === "compact-design://guide") return textResource(uri, LANGUAGE_GUIDE);
      if (uri === "compact-design://schema") return textResource(uri, JSON.stringify(schema, null, 2));
      throw new Error(`Unknown resource: ${uri}`);
    }
    case "prompts/list":
      return {
        prompts: [{
          name: "design_to_figma",
          description: "Author Compact Design JSON and import it into the open Figma file."
        }]
      };
    case "prompts/get":
      return {
        description: "Author Compact Design JSON and import it into Figma.",
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: "Call get_language, write Compact Design JSON for the user's request, validate it, then figma_import. If the plugin is disconnected, tell the user to open the Compact Design plugin in Figma Desktop and retry. Do not paste JSON for a human to import unless Figma is unavailable."
          }
        }]
      };
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textResource(uri: string, text: string): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
  return { contents: [{ uri, mimeType: uri.endsWith("schema") ? "application/schema+json" : "text/markdown", text }] };
}
