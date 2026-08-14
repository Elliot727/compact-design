export function parseDocument(source: string): unknown {
  if (!source.trim()) throw new Error("Paste a Compact Design JSON document first.");
  try { return JSON.parse(source); }
  catch (error) { throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}
