export const FALLBACK_FONT: FontName = { family: "Arial", style: "Regular" };
export const finite = (value: unknown, fallback: number): number => typeof value === "number" && Number.isFinite(value) ? value : fallback;
export const clamp = (value: unknown, min: number, max: number): number => Math.max(min, Math.min(max, finite(value, min)));
export function color(value: unknown): RGB {
  const channels = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const channel = (input: unknown) => { const n = finite(input, 0); return clamp(n > 1 ? n / 255 : n, 0, 1); };
  return { r: channel(channels.r), g: channel(channels.g), b: channel(channels.b) };
}
