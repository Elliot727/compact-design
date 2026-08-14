import type { DesignColor, InternalDocument, InternalNode, JsonObject } from "./types";

export interface RepairIssue { severity: "ERROR" | "WARNING" | "INFO"; code: string; path: string; message: string; suggestion?: string; }

function luminance(color: DesignColor): number {
  const channel = (value: number) => { const n = value / 255; return n <= .03928 ? n / 12.92 : Math.pow((n + .055) / 1.055, 2.4); };
  return .2126 * channel(color.r) + .7152 * channel(color.g) + .0722 * channel(color.b);
}
function contrast(a: DesignColor, b: DesignColor): number { const one = luminance(a); const two = luminance(b); return (Math.max(one, two) + .05) / (Math.min(one, two) + .05); }
function solid(node: InternalNode): DesignColor | null { const paint = node.properties.styles.fills[0]; return paint?.type === "SOLID" && paint.color ? paint.color : null; }
function prototypeActions(reaction: JsonObject): JsonObject[] { return Array.isArray(reaction.actions) ? reaction.actions.filter((action): action is JsonObject => typeof action === "object" && action !== null && !Array.isArray(action)) : []; }

export function lintDocument(document: InternalDocument): RepairIssue[] {
  const issues: RepairIssue[] = []; const ids = new Set<string>(); const colorUses = new Map<string, Array<{ node: InternalNode; path: string }>>();
  const add = (issue: RepairIssue) => { if (issues.length < 100) issues.push(issue); };
  const collectIds = (node: InternalNode) => { ids.add(node.id); node.children.forEach(collectIds); }; document.nodes.forEach(collectIds);
  function walk(node: InternalNode, path: string, background: DesignColor | null): void {
    const fill = solid(node); const nextBackground = fill || background; const props = node.properties; const width = props.size?.width || 0; const height = props.size?.height || 0;
    if (fill && !props.bindings?.fill) { const key = `${fill.r},${fill.g},${fill.b},${fill.a ?? 1}`; const values = colorUses.get(key) || []; values.push({ node, path }); colorUses.set(key, values); }
    if (node.type === "TEXT" && fill && background) { const ratio = contrast(fill, background); const size = props.font?.size || 16; if (ratio < (size >= 24 ? 3 : 4.5)) add({ severity: "WARNING", code: "LOW_CONTRAST", path, message: `Text contrast is approximately ${ratio.toFixed(2)}:1.`, suggestion: "Use a lighter/darker text or background colour." }); }
    if ((props.prototype?.length || /button|cta|link|tab|chip/i.test(node.name)) && (width < 44 || height < 44)) add({ severity: "WARNING", code: "SMALL_TOUCH_TARGET", path, message: `Interactive layer is ${width}×${height}; recommended minimum is 44×44.`, suggestion: "Increase the hit frame while retaining the visible control size." });
    if ([props.layout?.itemSpacing, props.layout?.padding?.left, props.layout?.padding?.top, props.layout?.padding?.right, props.layout?.padding?.bottom].some((value) => typeof value === "number" && Number.isFinite(value) && value % 4 !== 0)) add({ severity: "INFO", code: "INCONSISTENT_SPACING", path, message: "Spacing includes values outside a 4px scale.", suggestion: "Bind spacing to tokens or use a consistent spacing scale." });
    if (["FRAME", "COMPONENT"].includes(node.type) && !props.layout && node.children.length >= 3) {
      const xs = node.children.map((child) => child.properties.position?.x); const ys = node.children.map((child) => child.properties.position?.y);
      const rowLike = Math.max(...ys) - Math.min(...ys) < 8; const columnLike = Math.max(...xs) - Math.min(...xs) < 8;
      if (rowLike || columnLike) add({ severity: "INFO", code: "MISSING_AUTO_LAYOUT", path, message: `Children appear ${rowLike ? "horizontal" : "vertical"}, but the container has no Auto Layout.`, suggestion: `Add layout.direction: ${rowLike ? "HORIZONTAL" : "VERTICAL"}.` });
    }
    if (node.type === "TEXT" && props.textAutoResize === "NONE") { const size = props.font?.size || 16; const approximateCapacity = Math.max(1, Math.floor(width / (size * .55)) * Math.floor(height / (size * 1.2))); if ((props.text?.length || 0) > approximateCapacity * 1.25) add({ severity: "WARNING", code: "TEXT_OVERFLOW", path, message: "Text is likely to overflow its fixed bounds.", suggestion: "Use textAutoResize HEIGHT or increase the text box." }); }
    for (const reaction of props.prototype || []) for (const action of prototypeActions(reaction)) if (typeof action.type === "string" && ["NAVIGATE", "SWAP", "OVERLAY", "SCROLL_TO", "CHANGE_TO"].includes(action.type) && typeof action.destination === "string" && !ids.has(action.destination)) add({ severity: "ERROR", code: "BROKEN_PROTOTYPE_DESTINATION", path: `${path}.prototype`, message: `Destination '${action.destination}' does not exist.`, suggestion: "Use an existing explicit node ID." });
    const repeated = new Map<string, number>(); for (const child of node.children) { const key = `${child.type}:${child.name}:${child.properties.size?.width}:${child.properties.size?.height}`; repeated.set(key, (repeated.get(key) || 0) + 1); }
    if ([...repeated.values()].some((count) => count >= 3) && !["COMPONENT_SET", "COMPONENT"].includes(node.type)) {
      add({ severity: "INFO", code: "REPEATED_DETACHED_ELEMENTS", path, message: "Three or more structurally similar children are detached layers.", suggestion: "Turn the repeated element into a component and instances." });
      if (!node.children.some((child) => child.type === "INSTANCE")) add({ severity: "INFO", code: "MISSING_COMPONENT_USAGE", path, message: "A repeated pattern contains no component instances.", suggestion: "Define the repeated item once as a COMPONENT and use INSTANCE nodes." });
    }
    node.children.forEach((child, index) => walk(child, `${path}.children[${index}]`, nextBackground));
  }
  document.nodes.forEach((node, index) => walk(node, `nodes[${index}]`, null));
  for (const uses of colorUses.values()) if (uses.length >= 3) add({ severity: "INFO", code: "DUPLICATE_UNBOUND_COLOUR", path: uses[0].path, message: `The same hard-coded colour is used ${uses.length} times without a variable binding.`, suggestion: "Create a COLOR variable and bind these fills." });
  return issues;
}

export function validationIssues(errors: string[]): RepairIssue[] { return errors.map((message) => { const split = message.indexOf(":"); return { severity: "ERROR", code: "SCHEMA_VALIDATION", path: split < 0 ? "$" : message.slice(0, split), message: split < 0 ? message : message.slice(split + 1).trim(), suggestion: "Use the allowed property type or enum from compact-design.schema.json." }; }); }
