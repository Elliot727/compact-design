export const MCP_BRIDGE = "http://localhost:18791";

export type McpState = "offline" | "online" | "busy";

export interface McpJob {
  id: string;
  type: string;
  document?: unknown;
  patch?: unknown;
  mode?: string;
}

export async function completeMcpJob(id: string, message: Record<string, unknown>): Promise<void> {
  await fetch(`${MCP_BRIDGE}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, message })
  });
}

export function startMcpPoll(onJob: (job: McpJob) => Promise<void>, onState: (state: McpState) => void): void {
  const loop = async (): Promise<void> => {
    while (true) {
      try {
        const response = await fetch(`${MCP_BRIDGE}/poll?wait=8000`);
        if (response.status === 204) {
          onState("online");
          continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const job = await response.json() as McpJob;
        onState("busy");
        await onJob(job);
        onState("online");
      } catch {
        onState("offline");
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  };
  void loop();
}
