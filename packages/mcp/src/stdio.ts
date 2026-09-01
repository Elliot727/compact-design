import type { JsonRpcRequest, JsonRpcResponse } from "./protocol";

const decoder = new TextDecoder();

type Bytes = Uint8Array<ArrayBufferLike>;

export async function readStdioMessages(onMessage: (message: JsonRpcRequest) => void | Promise<void>): Promise<void> {
  let buffer: Bytes = new Uint8Array();
  for await (const chunk of process.stdin) {
    buffer = concat(buffer, chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk));
    while (true) {
      const framed = takeFramed(buffer);
      if (!framed) break;
      buffer = framed.rest;
      await onMessage(JSON.parse(framed.body) as JsonRpcRequest);
    }
  }
}

function concat(left: Bytes, right: Bytes): Bytes {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function indexOf(buffer: Bytes, value: string): number {
  const needle = new TextEncoder().encode(value);
  outer: for (let i = 0; i <= buffer.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (buffer[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function takeFramed(buffer: Bytes): { body: string; rest: Bytes } | null {
  const headerEnd = indexOf(buffer, "\r\n\r\n");
  if (headerEnd !== -1) {
    const header = decoder.decode(buffer.subarray(0, headerEnd));
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) return { body: "{}", rest: buffer.subarray(headerEnd + 4) };
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return null;
    return { body: decoder.decode(buffer.subarray(start, start + length)), rest: buffer.subarray(start + length) };
  }
  const newline = indexOf(buffer, "\n");
  if (newline === -1) return null;
  const line = decoder.decode(buffer.subarray(0, newline)).trim();
  const rest = buffer.subarray(newline + 1);
  if (!line.startsWith("{")) return { body: "{}", rest };
  return { body: line, rest };
}

export function encodeStdioMessage(message: JsonRpcResponse): string {
  return JSON.stringify(message) + "\n";
}

export function writeStdioMessage(message: JsonRpcResponse): void {
  process.stdout.write(encodeStdioMessage(message));
}
