import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};

export async function embedFileImages(value: unknown, cwd: string): Promise<void> {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) await embedFileImages(item, cwd);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "IMAGE" && typeof record.src === "string" && /^file:/i.test(record.src)) {
    const name = decodeURIComponent(record.src.slice(5)).replace(/^\/+/, "");
    const path = isAbsolute(name) ? name : resolve(cwd, name);
    const bytes = await readFile(path);
    const mime = MIME[extname(path).toLowerCase()] || "image/png";
    record.src = `data:${mime};base64,${bytes.toString("base64")}`;
    delete record.bytes;
  }
  for (const nested of Object.values(record)) await embedFileImages(nested, cwd);
}
