import type { ImportMode, InternalDocument, InternalPatchDocument } from "@compact-design/core";
import { importDocument } from "./importer";
import { exportSelection } from "./exporter";
import { applyPatch } from "./patch";
import { createResources } from "./resources";

figma.showUI(__html__, { width: 560, height: 780, themeColors: true });

figma.ui.onmessage = async (message: { type?: string; document?: InternalDocument; patch?: InternalPatchDocument; mode?: ImportMode }) => {
  if (message.type === "export-selection") {
    try {
      const result = await exportSelection(figma.currentPage.selection);
      figma.ui.postMessage({ type: "export-complete", document: result.document, warnings: result.warnings });
      figma.notify(`Exported ${figma.currentPage.selection.length} selected layer${figma.currentPage.selection.length === 1 ? "" : "s"}`);
    } catch (error) { figma.ui.postMessage({ type: "export-error", message: error instanceof Error ? error.message : String(error) }); }
    return;
  }
  if (message.type === "preview-import" && message.document) {
    try {
      const existing = new Set(figma.currentPage.findAll().map((node) => node.getPluginData("compactDesignId")).filter(Boolean));
      const matched = message.document.nodes.filter((node) => existing.has(node.id)).length;
      figma.ui.postMessage({ type: "preview-complete", matched, create: message.document.nodes.length - matched, totalExisting: existing.size });
    } catch (error) { figma.ui.postMessage({ type: "preview-error", message: error instanceof Error ? error.message : String(error) }); }
    return;
  }
  if (message.type === "apply-patch" && message.patch) {
    const resources = await createResources({ nodes: [], styles: [], variables: [] });
    const context = { sourceNodes: new Map<string, SceneNode>(), componentPropertyKeys: new Map<string, Map<string, string>>(), resources, createdNodes: [] as SceneNode[] };
    try {
      const { affected, warnings } = await applyPatch(message.patch, context);
      figma.currentPage.selection = affected; if (affected.length) figma.viewport.scrollAndZoomIntoView(affected);
      figma.ui.postMessage({ type: "patch-complete", count: affected.length, warnings });
    } catch (error) { for (const node of [...context.createdNodes].reverse()) if (!node.removed) node.remove(); figma.ui.postMessage({ type: "import-error", message: error instanceof Error ? error.message : String(error) }); }
    return;
  }
  if (message.type !== "import-json" || !message.document) return;
  try {
    const { roots, warnings, created, replaced } = await importDocument(message.document, message.mode || "CREATE");
    figma.currentPage.selection = roots;
    figma.viewport.scrollAndZoomIntoView(roots);
    figma.ui.postMessage({ type: "import-complete", count: roots.length, warnings, created, replaced });
    figma.notify(`Imported ${roots.length} canvas${roots.length === 1 ? "" : "es"}`);
  } catch (error) {
    figma.ui.postMessage({ type: "import-error", message: error instanceof Error ? error.message : String(error) });
  }
};
