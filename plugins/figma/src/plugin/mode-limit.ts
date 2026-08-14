export function isVariableModeLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /limited to\s+\d+\s+modes?\s+only/i.test(message) || /variable mode limit/i.test(message);
}

export function variableModeLimitWarning(collection: string, available: string[], omitted: string[]): string {
  return `Variable collection '${collection}': Figma limited this file to ${available.length} mode${available.length === 1 ? "" : "s"}. Imported ${available.join(", ") || "the default mode"}; omitted ${omitted.join(", ")}. Upgrade the file's plan or move it to an eligible workspace to retain every mode.`;
}
