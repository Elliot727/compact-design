import { clamp, color, finite } from "./value";
import type { DesignEffect, DesignPaint, DesignProperties } from "@compact-design/core";

export async function paintFromData(value: DesignPaint): Promise<Paint | null> {
  if (!value?.type) return null;
  if (value.type === "SOLID") return { type: "SOLID", color: color(value.color), opacity: clamp(finite(value.opacity, 1), 0, 1) };
  if (["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"].includes(value.type)) {
    return {
      type: value.type,
      gradientTransform: Array.isArray(value.gradientTransform) ? value.gradientTransform : [[1, 0, 0], [0, 1, 0]],
      gradientStops: (value.gradientStops || []).map((stop) => ({ position: clamp(stop.position, 0, 1), color: { ...color(stop.color), a: clamp(finite(stop.color?.a, 1), 0, 1) } }))
    } as GradientPaint;
  }
  if (value.type === "IMAGE") {
    try {
      if (!value.bytes && !value.src) throw new Error("IMAGE paint requires src or bytes");
      const image = value.bytes ? figma.createImage(value.bytes instanceof Uint8Array ? value.bytes : new Uint8Array(value.bytes)) : await figma.createImageAsync(value.src as string);
      const scaleMode: ImagePaint["scaleMode"] = value.scaleMode && ["FILL", "FIT", "CROP", "TILE"].includes(value.scaleMode) ? value.scaleMode as ImagePaint["scaleMode"] : "FILL";
      const result: ImagePaint = {
        type: "IMAGE",
        imageHash: image.hash,
        scaleMode,
        opacity: clamp(finite(value.opacity, 1), 0, 1),
        ...(scaleMode === "CROP" && Array.isArray(value.imageTransform) ? { imageTransform: value.imageTransform } : {})
      };
      return result;
    } catch (error) {
      throw new Error(`Could not load image '${value.src}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}

export async function paints(values: DesignPaint[]): Promise<Paint[]> {
  const result: Paint[] = [];
  for (const value of values || []) {
    const resolved = await paintFromData(value);
    if (resolved) result.push(resolved);
  }
  return result;
}

function rgbaColor(value: DesignEffect["color"]): RGBA {
  return { ...color(value), a: clamp(finite(value?.a, 1), 0, 1) };
}

/** Warnings collected while applying effects (e.g. shaders that could not be imported). */
export const effectWarnings = new Set<string>();
const shaderImports = new Map<string, Promise<string | null>>();
export function clearEffectWarnings(): void { effectWarnings.clear(); shaderImports.clear(); }

export type ShaderImporter = (id: string) => Promise<unknown>;
const figmaShaderImporter: ShaderImporter = (id) => figma.importShaderById(id);

/** Import a shader once per import run; resolves to an error message, or null on success. */
function ensureShader(id: string, importShader: ShaderImporter): Promise<string | null> {
  let pending = shaderImports.get(id);
  if (!pending) {
    pending = importShader(id).then(() => null, (error: unknown) => error instanceof Error ? error.message : String(error));
    shaderImports.set(id, pending);
  }
  return pending;
}

/**
 * Map Compact DesignEffect → Figma Effect. SHADER effects are mapped
 * structurally here; use effectsFromData so the shader is imported with
 * figma.importShaderById before it is applied.
 */
export function effectFromData(value: DesignEffect): Effect | null {
  if (!value?.type) return null;
  if (value.type === "SHADER") {
    if (typeof value.id !== "string" || !value.id) return null;
    const properties = value.properties && typeof value.properties === "object" && !Array.isArray(value.properties) ? value.properties : undefined;
    return {
      type: "SHADER",
      id: value.id,
      visible: value.visible !== false,
      ...(properties ? { properties: properties as ShaderEffect["properties"] } : {})
    } as ShaderEffect;
  }
  if (value.type === "DROP_SHADOW" || value.type === "INNER_SHADOW") {
    const shadow = {
      type: value.type,
      color: rgbaColor(value.color),
      offset: { x: finite(value.offset?.x, 0), y: finite(value.offset?.y, 4) },
      radius: Math.max(0, finite(value.radius, 8)),
      spread: finite(value.spread, 0),
      visible: value.visible !== false,
      blendMode: (value.blendMode || "NORMAL") as BlendMode
    };
    if (value.type === "DROP_SHADOW" && typeof value.showShadowBehindNode === "boolean") {
      return { ...shadow, showShadowBehindNode: value.showShadowBehindNode } as DropShadowEffect;
    }
    return shadow as DropShadowEffect | InnerShadowEffect;
  }
  if (value.type === "LAYER_BLUR" || value.type === "BACKGROUND_BLUR") {
    const radius = Math.max(0, finite(value.radius, 8));
    const visible = value.visible !== false;
    if (value.blurType === "PROGRESSIVE") {
      return {
        type: value.type,
        blurType: "PROGRESSIVE",
        radius,
        visible,
        startRadius: Math.max(0, finite(value.startRadius, 0)),
        startOffset: { x: finite(value.startOffset?.x, 0), y: finite(value.startOffset?.y, 0) },
        endOffset: { x: finite(value.endOffset?.x, 0), y: finite(value.endOffset?.y, 1) }
      } as BlurEffect;
    }
    return {
      type: value.type,
      radius,
      visible,
      ...(value.blurType === "NORMAL" ? { blurType: "NORMAL" as const } : {})
    } as BlurEffect;
  }
  if (value.type === "NOISE") {
    const noiseType = (value.noiseType === "DUOTONE" || value.noiseType === "MULTITONE" ? value.noiseType : "MONOTONE") as NoiseEffect["noiseType"];
    const base = {
      type: "NOISE" as const,
      color: rgbaColor(value.color),
      visible: value.visible !== false,
      blendMode: (value.blendMode || "NORMAL") as BlendMode,
      noiseSize: Math.max(0, finite(value.noiseSize, 1)),
      density: clamp(finite(value.density, 1), 0, 1),
      noiseType
    };
    if (noiseType === "DUOTONE") return { ...base, noiseType, secondaryColor: rgbaColor(value.secondaryColor) } as NoiseEffect;
    if (noiseType === "MULTITONE") return { ...base, noiseType, opacity: clamp(finite(value.opacity, 1), 0, 1) } as NoiseEffect;
    return { ...base, noiseType: "MONOTONE" } as NoiseEffect;
  }
  if (value.type === "TEXTURE") {
    return {
      type: "TEXTURE",
      visible: value.visible !== false,
      noiseSize: Math.max(0, finite(value.noiseSize, 1)),
      radius: Math.max(0, finite(value.radius, 0)),
      clipToShape: value.clipToShape !== false
    } as TextureEffect;
  }
  if (value.type === "GLASS") {
    return {
      type: "GLASS",
      visible: value.visible !== false,
      lightIntensity: clamp(finite(value.lightIntensity, 0.5), 0, 1),
      lightAngle: finite(value.lightAngle, -45),
      refraction: clamp(finite(value.refraction, 0.5), 0, 1),
      depth: Math.max(1, finite(value.depth, 1)),
      dispersion: clamp(finite(value.dispersion, 0.1), 0, 1),
      radius: Math.max(0, finite(value.radius, 0))
    } as GlassEffect;
  }
  return null;
}

/**
 * Resolve Compact effects into Figma effects, importing each SHADER with
 * figma.importShaderById first. A shader that cannot be imported is skipped
 * and recorded in effectWarnings instead of failing the whole import.
 */
export async function effectsFromData(values: DesignEffect[], label = "node", importShader: ShaderImporter = figmaShaderImporter): Promise<Effect[]> {
  const result: Effect[] = [];
  for (const value of values || []) {
    if (value?.type === "SHADER") {
      if (typeof value.id !== "string" || !value.id) {
        effectWarnings.add(`${label}: skipped a SHADER effect without an id.`);
        continue;
      }
      const failure = await ensureShader(value.id, importShader);
      if (failure !== null) {
        effectWarnings.add(`${label}: skipped SHADER '${value.id}' because it could not be imported (${failure}).`);
        continue;
      }
    }
    const resolved = effectFromData(value);
    if (resolved) result.push(resolved);
  }
  return result;
}

function applyEffects(node: SceneNode & BlendMixin, effects: Effect[]): void {
  try {
    node.effects = effects;
  } catch (error) {
    if (!effects.some((effect) => effect.type === "SHADER")) throw error;
    // A shader can import but still reject stale property assignments; keep
    // the rest of the node's effects rather than failing the import.
    node.effects = effects.filter((effect) => effect.type !== "SHADER");
    effectWarnings.add(`${node.name}: dropped SHADER effect(s) Figma rejected (${error instanceof Error ? error.message : String(error)}).`);
  }
}

export async function applyAppearance(node: SceneNode, props: DesignProperties, isText: boolean): Promise<void> {
  const styles = props.styles || {};
  if ("fills" in node) node.fills = styles.fills !== undefined ? await paints(styles.fills) : (isText ? [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }] : []);
  if ("strokes" in node) node.strokes = await paints(styles.strokes || []);
  if ("effects" in node) applyEffects(node, await effectsFromData(styles.effects || [], node.name));
  if ("strokeWeight" in node && typeof props.strokeWeight === "number" && Number.isFinite(props.strokeWeight)) node.strokeWeight = Math.max(0, props.strokeWeight);
  if ("strokeAlign" in node && props.strokeAlign) node.strokeAlign = props.strokeAlign;
  if ("strokeCap" in node && props.strokeCap) node.strokeCap = props.strokeCap as unknown as typeof node.strokeCap;
  if ("strokeJoin" in node && props.strokeJoin) node.strokeJoin = props.strokeJoin;
  if ("dashPattern" in node && Array.isArray(props.dashPattern)) node.dashPattern = props.dashPattern;
  const writable = node as unknown as Record<string, unknown>;
  for (const key of ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"] as const) if (key in node && Number.isFinite(props[key])) writable[key] = props[key];
  if ("cornerRadius" in node && Number.isFinite(props.cornerRadius)) writable.cornerRadius = props.cornerRadius;
  if ("topLeftRadius" in node && Array.isArray(props.cornerRadii)) [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius] = props.cornerRadii;
  if ("opacity" in node && Number.isFinite(props.opacity)) node.opacity = clamp(props.opacity, 0, 1);
  if ("blendMode" in node && props.blendMode) node.blendMode = props.blendMode;
  if (typeof props.visible === "boolean") node.visible = props.visible;
  if (typeof props.locked === "boolean") node.locked = props.locked;
  if ("isMask" in node && typeof props.isMask === "boolean") node.isMask = props.isMask;
  if ("clipsContent" in node && typeof props.clipsContent === "boolean") node.clipsContent = props.clipsContent;
}
