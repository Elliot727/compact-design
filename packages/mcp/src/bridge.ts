import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ImportMode, InternalDocument, InternalPatchDocument } from "@compact-design/core";

export const DEFAULT_BRIDGE_PORT = 18791;

export interface BridgeStatus {
  listening: boolean;
  pluginConnected: boolean;
  port: number;
  lastPollMs: number | null;
}

export interface ImportResult {
  ok: boolean;
  type: string;
  count?: number;
  created?: number;
  replaced?: number;
  warnings?: string[];
  document?: unknown;
  message?: string;
}

interface QueuedJob {
  id: string;
  payload: Record<string, unknown>;
  resolve: (value: ImportResult) => void;
}

const CONNECTED_MS = 12_000;

export class FigmaBridge {
  readonly port: number;
  private server: ReturnType<typeof createServer> | null = null;
  private lastPoll = 0;
  private queue: QueuedJob[] = [];
  private waiters: Array<(job: QueuedJob | null) => void> = [];
  private inflight = new Map<string, QueuedJob>();
  private readonly connectTimeoutMs: number;
  private readonly jobTimeoutMs: number;

  constructor(options: { port?: number; connectTimeoutMs?: number; jobTimeoutMs?: number } = {}) {
    this.port = options.port ?? DEFAULT_BRIDGE_PORT;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 20_000;
    this.jobTimeoutMs = options.jobTimeoutMs ?? 120_000;
  }

  status(): BridgeStatus {
    return {
      listening: Boolean(this.server?.listening),
      pluginConnected: Date.now() - this.lastPoll < CONNECTED_MS,
      port: this.port,
      lastPollMs: this.lastPoll || null
    };
  }

  async listen(): Promise<void> {
    if (this.server?.listening) return;
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, "localhost", () => resolve());
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const waiter of this.waiters) waiter(null);
    this.waiters = [];
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  importDocument(document: InternalDocument, mode: ImportMode): Promise<ImportResult> {
    return this.submit({ type: "import", document, mode });
  }

  applyPatch(patch: InternalPatchDocument): Promise<ImportResult> {
    return this.submit({ type: "patch", patch });
  }

  exportSelection(): Promise<ImportResult> {
    return this.exportDocument();
  }

  exportDocument(options: { scope?: "selection" | "page"; id?: string } = {}): Promise<ImportResult> {
    return this.submit({ type: "export", scope: options.scope ?? "selection", ...(options.id ? { targetId: options.id } : {}) });
  }

  private async submit(payload: Record<string, unknown>): Promise<ImportResult> {
    if (!this.server?.listening) {
      return { ok: false, type: "bridge-error", message: `Figma bridge is not listening on localhost:${this.port}.` };
    }
    const started = Date.now();
    while (!this.status().pluginConnected && Date.now() - started < this.connectTimeoutMs) {
      await delay(250);
    }
    if (!this.status().pluginConnected) {
      return {
        ok: false,
        type: "plugin-disconnected",
        message: `Open the Compact Design plugin in Figma Desktop and keep it running. It polls http://localhost:${this.port}.`
      };
    }
    const id = crypto.randomUUID();
    return await new Promise<ImportResult>((resolve) => {
      const job: QueuedJob = { id, payload: { id, ...payload }, resolve };
      const timer = setTimeout(() => {
        this.inflight.delete(id);
        this.queue = this.queue.filter((item) => item.id !== id);
        resolve({ ok: false, type: "timeout", message: "The Figma plugin did not finish the job in time." });
      }, this.jobTimeoutMs);
      const finish = (value: ImportResult): void => {
        clearTimeout(timer);
        resolve(value);
      };
      job.resolve = finish;
      this.queue.push(job);
      const waiter = this.waiters.shift();
      if (waiter) waiter(this.queue.shift() || null);
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    cors(res);
    if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
    const url = new URL(req.url || "/", `http://localhost:${this.port}`);
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, this.status());
        return;
      }
      if (req.method === "GET" && url.pathname === "/poll") {
        this.lastPoll = Date.now();
        const wait = Math.min(10_000, Math.max(0, Number(url.searchParams.get("wait") || 8000)));
        const existing = this.queue.shift();
        if (existing) {
          this.inflight.set(existing.id, existing);
          json(res, 200, existing.payload);
          return;
        }
        const job = await new Promise<QueuedJob | null>((resolve) => {
          const timer = setTimeout(() => {
            this.waiters = this.waiters.filter((waiter) => waiter !== onJob);
            resolve(null);
          }, wait);
          const onJob = (value: QueuedJob | null): void => {
            clearTimeout(timer);
            resolve(value);
          };
          this.waiters.push(onJob);
        });
        this.lastPoll = Date.now();
        if (!job) { res.statusCode = 204; res.end(); return; }
        this.inflight.set(job.id, job);
        json(res, 200, job.payload);
        return;
      }
      if (req.method === "POST" && url.pathname === "/result") {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as { id?: string; message?: Record<string, unknown> };
        const job = parsed.id ? this.inflight.get(parsed.id) : undefined;
        if (!job) { json(res, 404, { ok: false, message: "Unknown job" }); return; }
        this.inflight.delete(parsed.id!);
        job.resolve(fromPluginMessage(parsed.message || {}));
        json(res, 200, { ok: true });
        return;
      }
      json(res, 404, { ok: false, message: "Not found" });
    } catch (error) {
      json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

function fromPluginMessage(message: Record<string, unknown>): ImportResult {
  const type = String(message.type || "unknown");
  if (type === "import-complete") {
    return { ok: true, type, count: numberField(message.count), created: numberField(message.created), replaced: numberField(message.replaced), warnings: stringArray(message.warnings) };
  }
  if (type === "patch-complete") {
    return { ok: true, type, count: numberField(message.count), warnings: stringArray(message.warnings) };
  }
  if (type === "export-complete") {
    return { ok: true, type, document: message.document, warnings: stringArray(message.warnings) };
  }
  return { ok: false, type, message: String(message.message || "Figma plugin returned an error.") };
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
