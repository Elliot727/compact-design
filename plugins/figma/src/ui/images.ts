import type { DesignPaint, InternalDocument, InternalNode } from "@compact-design/core";

const FIGMA_MAX_IMAGE_DIMENSION = 4096;

async function loadRemoteBitmap(url: string): Promise<ImageBitmap> {
  let response: Response;
  try { response = await fetch(url, { mode: "cors" }); }
  catch (error) { throw new Error(`Could not inspect image '${url}': ${error instanceof Error ? error.message : String(error)}`); }
  if (!response.ok) throw new Error(`Could not inspect image '${url}': HTTP ${response.status}`);
  try { return await createImageBitmap(await response.blob()); }
  catch (error) { throw new Error(`Could not decode image '${url}': ${error instanceof Error ? error.message : String(error)}`); }
}

function localAssetName(source: string): string | null {
  return /^file:/i.test(source) ? decodeURIComponent(source.slice(5)).replace(/^\/+/, "") : null;
}

async function resizePaint(paint: DesignPaint, localAssets: Map<string, File>): Promise<void> {
  if (paint?.type !== "IMAGE" || typeof paint.src !== "string") return;
  const assetName = localAssetName(paint.src);
  const embedded = /^data:image\//i.test(paint.src);
  const localFile = assetName === null ? null : localAssets.get(assetName) || localAssets.get(assetName.split("/").pop() || "");
  if (assetName !== null && !localFile) throw new Error(`Missing local image '${assetName}'. Choose Add images and select that file.`);
  let bitmap: ImageBitmap;
  try { bitmap = localFile ? await createImageBitmap(localFile) : await loadRemoteBitmap(paint.src); }
  catch (error) { throw new Error(`Could not decode image '${assetName || paint.src}': ${error instanceof Error ? error.message : String(error)}`); }
  try {
    paint.sourceWidth = bitmap.width;
    paint.sourceHeight = bitmap.height;
    if ((localFile || embedded) && bitmap.width <= FIGMA_MAX_IMAGE_DIMENSION && bitmap.height <= FIGMA_MAX_IMAGE_DIMENSION) {
      if (embedded) {
        const response = await fetch(paint.src);
        paint.bytes = new Uint8Array(await response.arrayBuffer());
        return;
      }
      paint.bytes = new Uint8Array(await localFile!.arrayBuffer());
      return;
    }
    if (!localFile && !embedded && bitmap.width <= FIGMA_MAX_IMAGE_DIMENSION && bitmap.height <= FIGMA_MAX_IMAGE_DIMENSION) return;
    const scale = Math.min(FIGMA_MAX_IMAGE_DIMENSION / bitmap.width, FIGMA_MAX_IMAGE_DIMENSION / bitmap.height);
    const width = Math.max(1, Math.floor(bitmap.width * scale));
    const height = Math.max(1, Math.floor(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(`Could not resize image '${assetName || paint.src}': Canvas 2D is unavailable`);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Canvas encoding failed")), "image/jpeg", 0.9));
    paint.bytes = new Uint8Array(await blob.arrayBuffer());
    paint.resizedWidth = width;
    paint.resizedHeight = height;
  } finally {
    bitmap.close();
  }
}

function collectNodePaints(node: InternalNode, result: DesignPaint[]): void {
  result.push(...(node.properties.styles?.fills || []), ...(node.properties.styles?.strokes || []));
  for (const child of node.children) collectNodePaints(child, result);
}

export function requiredLocalAssets(documentValue: InternalDocument): string[] {
  const paints: DesignPaint[] = [];
  for (const node of documentValue.nodes) collectNodePaints(node, paints);
  for (const style of documentValue.styles || []) paints.push(...(style.paints || []));
  return [...new Set(paints.filter((paint) => paint.type === "IMAGE" && typeof paint.src === "string").map((paint) => localAssetName(paint.src as string)).filter((name): name is string => Boolean(name)))];
}

export async function prepareImages(documentValue: InternalDocument, localAssets: Map<string, File>, onProgress?: (message: string) => void): Promise<void> {
  const paints: DesignPaint[] = [];
  for (const node of documentValue.nodes) collectNodePaints(node, paints);
  for (const style of documentValue.styles || []) paints.push(...(style.paints || []));
  const images = paints.filter((paint) => paint?.type === "IMAGE");
  for (let index = 0; index < images.length; index++) {
    onProgress?.(`Checking image ${index + 1} of ${images.length}…`);
    await resizePaint(images[index], localAssets);
  }
}
