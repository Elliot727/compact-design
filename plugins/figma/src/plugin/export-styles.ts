/** Pure helpers + Figma-backed collector for exporting paint/text styles and styleRefs. */

export const COMPACT_STYLE_ID_KEY = "compactDesignId";

export function compactStyleExportId(name: string, pluginId?: string, figmaId?: string): string {
  if (pluginId && pluginId.length > 0) return pluginId;
  if (name && name.length > 0) return name;
  return figmaId || name;
}

/** Same collision rule as node / variable export ids: preferred, then preferred-2, … */
export function uniqueStyleExportIds(preferredIds: string[]): string[] {
  const result: string[] = [];
  const used = new Set<string>();
  for (const preferredId of preferredIds) {
    let candidate = preferredId;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${preferredId}-${suffix++}`;
    result.push(candidate);
    used.add(candidate);
  }
  return result;
}

export function isUsableStyleId(value: unknown, mixed: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== mixed;
}

/** Map node style IDs to Compact styleRefs keys using a resolve callback. */
export function styleRefsFromNodeIds(
  ids: { fillStyleId?: unknown; strokeStyleId?: unknown; textStyleId?: unknown },
  resolveKey: (figmaStyleId: string) => string | undefined,
  mixed: unknown
): Record<string, string> | undefined {
  const refs: Record<string, string> = {};
  if (isUsableStyleId(ids.fillStyleId, mixed)) {
    const key = resolveKey(ids.fillStyleId);
    if (key) refs.fill = key;
  }
  if (isUsableStyleId(ids.strokeStyleId, mixed)) {
    const key = resolveKey(ids.strokeStyleId);
    if (key) refs.stroke = key;
  }
  if (isUsableStyleId(ids.textStyleId, mixed)) {
    const key = resolveKey(ids.textStyleId);
    if (key) refs.text = key;
  }
  return Object.keys(refs).length ? refs : undefined;
}

/** Collect raw Figma style ids from a node shape (no tree walk). */
export function collectStyleIdsFromNode(
  node: { fillStyleId?: unknown; strokeStyleId?: unknown; textStyleId?: unknown; type?: string },
  mixed: unknown
): string[] {
  const ids: string[] = [];
  if (isUsableStyleId(node.fillStyleId, mixed)) ids.push(node.fillStyleId);
  if (isUsableStyleId(node.strokeStyleId, mixed)) ids.push(node.strokeStyleId);
  if (node.type === "TEXT" && isUsableStyleId(node.textStyleId, mixed)) ids.push(node.textStyleId);
  return ids;
}

type CompactPaintFn = (values: readonly Paint[] | PluginAPI["mixed"]) => Promise<unknown[]>;

/** Collects local paint/text style refs while compacting nodes, then builds document `styles`. */
export class StyleExportContext {
  readonly warnings: string[] = [];
  private readonly keyByFigmaId = new Map<string, string>();
  private readonly referencedStyleIds = new Set<string>();
  private readonly droppedStyleIds = new Set<string>();
  private readonly styleCache = new Map<string, PaintStyle | TextStyle>();
  private built = false;

  noteReference(figmaStyleId: string): void {
    this.referencedStyleIds.add(figmaStyleId);
  }

  async collectRefsFromNode(node: SceneNode): Promise<void> {
    for (const id of collectStyleIdsFromNode(node, figma.mixed)) this.noteReference(id);
    if ("children" in node) {
      for (const child of node.children) {
        if ("x" in child) await this.collectRefsFromNode(child as SceneNode);
      }
    }
  }

  resolveKey(figmaStyleId: string): string | undefined {
    if (this.keyByFigmaId.has(figmaStyleId)) return this.keyByFigmaId.get(figmaStyleId);
    if (this.droppedStyleIds.has(figmaStyleId)) return undefined;
    return undefined;
  }

  styleRefsForNode(node: SceneNode): Record<string, string> | undefined {
    if (!this.built) return undefined;
    return styleRefsFromNodeIds(
      {
        fillStyleId: "fillStyleId" in node ? node.fillStyleId : undefined,
        strokeStyleId: "strokeStyleId" in node ? node.strokeStyleId : undefined,
        textStyleId: node.type === "TEXT" ? node.textStyleId : undefined
      },
      (id) => this.resolveKey(id),
      figma.mixed
    );
  }

  private async loadStyle(styleId: string): Promise<PaintStyle | TextStyle | undefined> {
    if (this.styleCache.has(styleId)) return this.styleCache.get(styleId);
    const style = await figma.getStyleByIdAsync(styleId);
    if (!style || (style.type !== "PAINT" && style.type !== "TEXT")) return undefined;
    if (style.remote) return undefined;
    this.styleCache.set(styleId, style);
    return style;
  }

  async buildStylesArray(compactPaints: CompactPaintFn): Promise<Record<string, unknown>[]> {
    if (!this.referencedStyleIds.size) {
      this.built = true;
      return [];
    }

    const entries: Array<{ figmaId: string; preferredId: string; style: PaintStyle | TextStyle }> = [];
    for (const styleId of this.referencedStyleIds) {
      const style = await this.loadStyle(styleId);
      if (!style) {
        this.warnings.push(`Could not resolve local style '${styleId}' (missing or remote).`);
        this.droppedStyleIds.add(styleId);
        continue;
      }
      const preferredId = compactStyleExportId(
        style.name,
        style.getPluginData(COMPACT_STYLE_ID_KEY) || undefined,
        style.id
      );
      entries.push({ figmaId: styleId, preferredId, style });
    }

    const uniqueIds = uniqueStyleExportIds(entries.map((entry) => entry.preferredId));
    entries.forEach((entry, index) => this.keyByFigmaId.set(entry.figmaId, uniqueIds[index]));

    const styles: Record<string, unknown>[] = [];
    for (const [index, entry] of entries.entries()) {
      const id = uniqueIds[index];
      if (entry.style.type === "PAINT") {
        const paints = await compactPaints(entry.style.paints);
        styles.push({ id, name: entry.style.name, type: "PAINT", paints });
      } else {
        styles.push({
          id,
          name: entry.style.name,
          type: "TEXT",
          font: {
            family: entry.style.fontName.family,
            style: entry.style.fontName.style,
            size: entry.style.fontSize
          }
        });
      }
    }

    this.built = true;
    return styles;
  }
}
