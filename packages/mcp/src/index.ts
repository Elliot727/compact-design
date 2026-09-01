import { FigmaBridge, DEFAULT_BRIDGE_PORT } from "./bridge";
import { handleRpc } from "./protocol";
import { readStdioMessages, writeStdioMessage } from "./stdio";
import { createToolRunner } from "./tools";

export { FigmaBridge, DEFAULT_BRIDGE_PORT } from "./bridge";
export { handleRpc } from "./protocol";
export { TOOLS, createToolRunner } from "./tools";
export { LANGUAGE_GUIDE } from "./guide";

export async function startServer(options: { port?: number } = {}): Promise<void> {
  const bridge = new FigmaBridge({ port: options.port ?? Number(process.env.COMPACT_DESIGN_MCP_PORT || DEFAULT_BRIDGE_PORT) });
  await bridge.listen();
  const runTool = createToolRunner(bridge);
  console.error(`Compact Design MCP ready. Figma plugin bridge: http://localhost:${bridge.port}`);
  await readStdioMessages(async (message) => {
    const response = await handleRpc(message, { runTool });
    if (response) writeStdioMessage(response);
  });
  await bridge.close();
}
