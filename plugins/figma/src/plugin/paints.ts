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

function effect(value: DesignEffect): Effect | null {
  if (["DROP_SHADOW", "INNER_SHADOW"].includes(value?.type)) return {
    type: value.type, color: { ...color(value.color), a: clamp(finite(value.color?.a, 1), 0, 1) },
    offset: { x: finite(value.offset?.x, 0), y: finite(value.offset?.y, 4) }, radius: Math.max(0, finite(value.radius, 8)),
    spread: finite(value.spread, 0), visible: value.visible !== false, blendMode: value.blendMode || "NORMAL"
  } as DropShadowEffect;
  if (["LAYER_BLUR", "BACKGROUND_BLUR"].includes(value?.type)) return { type: value.type, radius: Math.max(0, finite(value.radius, 8)), visible: value.visible !== false } as BlurEffect;
  return null;
}

export async function applyAppearance(node: SceneNode, props: DesignProperties, isText: boolean): Promise<void> {
  const styles = props.styles || {};
  if ("fills" in node) node.fills = styles.fills !== undefined ? await paints(styles.fills) : (isText ? [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }] : []);
  if ("strokes" in node) node.strokes = await paints(styles.strokes || []);
  if ("effects" in node) node.effects = (styles.effects || []).map(effect).filter(Boolean) as Effect[];
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
