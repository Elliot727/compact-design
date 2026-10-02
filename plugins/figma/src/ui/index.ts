import { isPatchDocument, lint, normalize, normalizePatch, parse, validate, type RepairIssue } from "@compact-design/core";
import { completeMcpJob, startMcpPoll, type McpJob, type McpState } from "./bridge";
import { prepareImages, requiredLocalAssets } from "./images";
import type { ImportMode, InternalDocument, InternalNode, InternalPatchDocument } from "@compact-design/core";

const input = document.querySelector<HTMLTextAreaElement>("#input")!;
const button = document.querySelector<HTMLButtonElement>("#import")!;
const status = document.querySelector<HTMLDivElement>("#status")!;
const modePicker = document.querySelector<HTMLDivElement>("#mode")!;
const lintToggle = document.querySelector<HTMLInputElement>("#lint")!;
const fileInput = document.querySelector<HTMLInputElement>("#file")!;
const browse = document.querySelector<HTMLButtonElement>("#browse")!;
const dropzone = document.querySelector<HTMLDivElement>("#dropzone")!;
const summary = document.querySelector<HTMLDivElement>("#summary")!;
const format = document.querySelector<HTMLButtonElement>("#format")!;
const clear = document.querySelector<HTMLButtonElement>("#clear")!;
const copy = document.querySelector<HTMLButtonElement>("#copy")!;
const download = document.querySelector<HTMLButtonElement>("#download")!;
const exportButton = document.querySelector<HTMLButtonElement>("#export")!;
const assetInput = document.querySelector<HTMLInputElement>("#asset-files")!;
const addAssets = document.querySelector<HTMLButtonElement>("#add-assets")!;
const assetDetail = document.querySelector<HTMLDivElement>("#asset-detail")!;
const preview = document.querySelector<HTMLDivElement>("#preview")!;
const previewStats = document.querySelector<HTMLDivElement>("#preview-stats")!;
const issuesElement = document.querySelector<HTMLDivElement>("#issues")!;
const copyRepair = document.querySelector<HTMLButtonElement>("#copy-repair")!;
const localAssets = new Map<string, File>();
const mcp = document.querySelector<HTMLDivElement>("#mcp")!;
const mcpLabel = document.querySelector<HTMLSpanElement>("#mcp-label")!;
let currentPayload: InternalDocument | null = null;
let currentPatch: InternalPatchDocument | null = null;
let currentIssues: RepairIssue[] = [];
let updateTimer = 0;
let pluginWaiter: ((message: Record<string, unknown>) => void) | null = null;

function setMcpState(state: McpState): void {
  mcp.className = `mcp ${state}`;
  mcpLabel.textContent = state === "online" ? "MCP connected · AI can import directly" : state === "busy" ? "MCP importing…" : "MCP idle · start @compact-design/mcp";
}

function waitForPlugin(): Promise<Record<string, unknown>> {
  return new Promise((resolve) => { pluginWaiter = resolve; });
}
function selectedMode(): ImportMode { return (modePicker.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value || "CREATE") as ImportMode; }

async function copyText(value: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(value); return true; } catch {}
  const helper = document.createElement("textarea"); helper.value = value; helper.setAttribute("readonly", ""); helper.style.position = "fixed"; helper.style.opacity = "0"; helper.style.pointerEvents = "none"; document.body.appendChild(helper); helper.select(); helper.setSelectionRange(0, helper.value.length);
  let copied = false; try { copied = document.execCommand("copy"); } catch {} helper.remove(); return copied;
}

function updateAssetDetail(required: string[] = currentPayload ? requiredLocalAssets(currentPayload) : []): void {
  const missing = required.filter((name) => !localAssets.has(name) && !localAssets.has(name.split("/").pop() || ""));
  if (missing.length) assetDetail.textContent = `${localAssets.size} selected · missing: ${missing.join(", ")}`;
  else if (required.length) assetDetail.textContent = `${localAssets.size} selected · all ${required.length} local reference${required.length === 1 ? "" : "s"} matched`;
  else assetDetail.textContent = localAssets.size ? `${localAssets.size} image${localAssets.size === 1 ? "" : "s"} ready` : "Use file:photo.jpg in image fills, then add the matching files.";
}

function countNodes(nodes: InternalNode[]): number { return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0); }
function countImages(nodes: InternalNode[]): number { return nodes.reduce((total, node) => total + node.properties.styles.fills.filter((paint) => paint.type === "IMAGE").length + countImages(node.children), 0); }
function setStatus(message = "", kind: "" | "error" | "success" = ""): void {
  status.className = message ? `visible ${kind}`.trim() : "";
  status.textContent = message;
}

function renderIssues(values: RepairIssue[]): void {
  issuesElement.innerHTML = "";
  for (const issue of values.slice(0, 30)) { const row = document.createElement("div"); row.className = `issue ${issue.severity}`; const code = document.createElement("div"); code.className = "issue-code"; code.textContent = `${issue.severity} · ${issue.code} · ${issue.path}`; const message = document.createElement("div"); message.textContent = issue.message; row.append(code, message); issuesElement.append(row); }
}
function renderPreview(payload: InternalDocument | null, patch: InternalPatchDocument | null): void {
  preview.classList.add("visible");
  renderIssues(currentIssues);
}

function updateSummary(): void {
  const source = input.value.trim();
  currentPayload = null;
  currentPatch = null; currentIssues = [];
  button.disabled = true;
  if (!source) {
    preview.classList.remove("visible");
    summary.className = "summary empty";
    summary.innerHTML = '<div class="summary-icon">i</div><div class="summary-text"><div class="summary-title">Waiting for a document</div><div class="summary-detail">Paste JSON or choose a file to begin.</div></div>';
    return;
  }
  try {
    const parsed = parse(source);
    if (isPatchDocument(parsed)) {
      currentPatch = normalizePatch(parsed); currentIssues = [];
      summary.className = "summary valid"; summary.innerHTML = `<div class="summary-icon">✓</div><div class="summary-text"><div class="summary-title">Patch ready</div><div class="summary-detail">${currentPatch.patch.operations.length} validated operation${currentPatch.patch.operations.length === 1 ? "" : "s"}</div></div>`;
      renderPreview(null, currentPatch); previewStats.textContent = "Targets are checked in Figma before any patch operation is applied."; button.textContent = "Apply JSON patch"; button.disabled = false; return;
    }
    const validation = validate(parsed);
    if (!validation.valid || !validation.document) { currentIssues = validation.issues; throw new Error(validation.issues[0]?.message || "Invalid Compact Design document"); }
    const payload = validation.document;
    currentIssues = [...validation.issues, ...(lintToggle.checked ? lint(payload) : [])];
    currentPayload = payload;
    updateAssetDetail(requiredLocalAssets(payload));
    const nodeCount = countNodes(payload.nodes);
    const imageCount = countImages(payload.nodes);
    summary.className = "summary valid";
    summary.innerHTML = `<div class="summary-icon">✓</div><div class="summary-text"><div class="summary-title">Ready to import</div><div class="summary-detail">${payload.nodes.length} canvas${payload.nodes.length === 1 ? "" : "es"} · ${nodeCount} layer${nodeCount === 1 ? "" : "s"} · ${imageCount} image${imageCount === 1 ? "" : "s"}</div></div>`;
    renderPreview(payload, null); previewStats.textContent = `${currentIssues.length} lint finding${currentIssues.length === 1 ? "" : "s"} · checking matching IDs…`;
    parent.postMessage({ pluginMessage: { type: "preview-import", document: payload, mode: selectedMode() } }, "*");
    button.textContent = selectedMode() === "CREATE" ? "Create Figma design" : selectedMode() === "UPDATE" ? "Update matching design" : "Replace matching canvases";
    button.disabled = false;
  } catch (error) {
    if (!currentIssues.length) currentIssues = [{ severity: "ERROR", code: "PARSE_OR_NORMALIZE", path: "$", message: error instanceof Error ? error.message : String(error), suggestion: "Correct the JSON syntax or use only fields from compact-design.schema.json." }];
    summary.className = "summary invalid";
    summary.innerHTML = `<div class="summary-icon">!</div><div class="summary-text"><div class="summary-title">Document needs attention</div><div class="summary-detail"></div></div>`;
    summary.querySelector<HTMLElement>(".summary-detail")!.textContent = error instanceof Error ? error.message : String(error);
    renderPreview(currentPayload, currentPatch); renderIssues(currentIssues);
  }
}

function scheduleSummary(): void { window.clearTimeout(updateTimer); updateTimer = window.setTimeout(updateSummary, 180); }
async function loadFile(file: File): Promise<void> {
  if (!file.name.toLowerCase().endsWith(".json") && file.type !== "application/json") throw new Error("Choose a .json file.");
  input.value = await file.text();
  setStatus();
  updateSummary();
}

input.addEventListener("input", scheduleSummary);
modePicker.addEventListener("change", updateSummary); lintToggle.addEventListener("change", updateSummary);
browse.onclick = () => fileInput.click();
addAssets.onclick = () => assetInput.click();
assetInput.onchange = () => {
  for (const file of Array.from(assetInput.files || [])) localAssets.set(file.name, file);
  assetInput.value = "";
  updateAssetDetail();
  updateSummary();
};
fileInput.onchange = async () => { if (fileInput.files?.[0]) try { await loadFile(fileInput.files[0]); } catch (error) { setStatus(error instanceof Error ? error.message : String(error), "error"); } finally { fileInput.value = ""; } };
for (const eventName of ["dragenter", "dragover"]) dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.add("dragging"); });
for (const eventName of ["dragleave", "drop"]) dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.remove("dragging"); });
dropzone.addEventListener("drop", async (event) => { const file = event.dataTransfer?.files[0]; if (file) try { await loadFile(file); } catch (error) { setStatus(error instanceof Error ? error.message : String(error), "error"); } });
dropzone.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") fileInput.click(); });
format.onclick = () => { try { input.value = JSON.stringify(parse(input.value), null, 2); updateSummary(); } catch (error) { setStatus(error instanceof Error ? error.message : String(error), "error"); } };
copy.onclick = async () => { if (!input.value.trim()) return; const copied = await copyText(input.value); if (!copied) { input.focus(); input.select(); } setStatus(copied ? "Copied JSON to clipboard." : "Copy was blocked by Figma. The JSON editor is selected—press ⌘C or Ctrl+C.", copied ? "success" : "error"); };
download.onclick = () => {
  if (!input.value.trim()) return;
  const blob = new Blob([input.value], { type: "application/json" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob); anchor.download = "figma-design.json"; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
};
clear.onclick = () => { input.value = ""; localAssets.clear(); updateAssetDetail([]); setStatus(); updateSummary(); input.focus(); };
copyRepair.onclick = async () => { const repair = JSON.stringify({ valid: !currentIssues.some((issue) => issue.severity === "ERROR"), issues: currentIssues }, null, 2); const copied = await copyText(repair); setStatus(copied ? "Copied structured repair JSON." : "Copy was blocked by Figma. Select and copy the repair output manually.", copied ? "success" : "error"); };
exportButton.onclick = () => { exportButton.disabled = true; exportButton.textContent = "Exporting…"; setStatus("Reading selected Figma layers…"); parent.postMessage({ pluginMessage: { type: "export-selection" } }, "*"); };

button.onclick = async () => {
  setStatus();
  try {
    if (currentPatch) {
      button.disabled = true; button.textContent = "Applying patch…";
      const patchImages: InternalDocument = { nodes: currentPatch.patch.operations.flatMap((operation, index) => operation.node ? [operation.node] : operation.normalized ? [{ id: `patch-image-${index}`, name: "Patch image", type: "FRAME", properties: operation.normalized, children: [] }] : []), styles: [], variables: [] };
      await prepareImages(patchImages, localAssets, (message) => setStatus(message));
      parent.postMessage({ pluginMessage: { type: "apply-patch", patch: currentPatch } }, "*"); return;
    }
    const validation = validate(parse(input.value));
    if (!validation.valid || !validation.document) throw new Error(`Validation failed (${validation.issues.length}):\n${validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`);
    const payload = currentPayload || validation.document;
    button.disabled = true;
    button.textContent = "Preparing design…";
    await prepareImages(payload, localAssets, (message) => setStatus(message));
    setStatus(`Creating ${payload.nodes.length} canvas${payload.nodes.length === 1 ? "" : "es"}…`);
    parent.postMessage({ pluginMessage: { type: "import-json", document: payload, mode: selectedMode() } }, "*");
  } catch (error) {
    button.disabled = false;
    button.textContent = "Create Figma design";
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
};

document.addEventListener("keydown", (event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !button.disabled) button.click(); });
window.onmessage = (event) => {
  const message = event.data.pluginMessage;
  if (!message) return;
  if (pluginWaiter) { pluginWaiter(message); pluginWaiter = null; }
  if (message.type === "export-complete") {
    exportButton.disabled = false; exportButton.textContent = "Export selection";
    input.value = JSON.stringify(message.document, null, 2); updateSummary();
    const warningText = message.warnings?.length ? `\n${message.warnings.join("\n")}` : "";
    setStatus(`Selection exported to Compact Design JSON.${warningText}`, "success");
    return;
  }
  if (message.type === "export-error") {
    exportButton.disabled = false; exportButton.textContent = "Export selection";
    setStatus(message.message, "error"); return;
  }
  if (message.type === "preview-complete") { previewStats.textContent = `${message.create} new · ${message.matched} matching IDs · ${currentIssues.length} lint finding${currentIssues.length === 1 ? "" : "s"}`; return; }
  if (message.type === "preview-error") { previewStats.textContent = `Figma ID comparison failed: ${message.message}`; return; }
  if (message.type === "patch-complete") { button.disabled = false; button.textContent = "Apply JSON patch"; setStatus(`Patch applied — ${message.count} layer${message.count === 1 ? "" : "s"} affected.`, "success"); return; }
  button.disabled = false;
  button.textContent = "Create Figma design";
  const warningText = message.warnings?.length ? `\nImport warnings:\n${message.warnings.join("\n")}` : "";
  setStatus(message.type === "import-complete" ? `Done — imported ${message.count} canvas${message.count === 1 ? "" : "es"}.${warningText}` : message.message, message.type === "import-error" ? "error" : "success");
};

startMcpPoll(async (job: McpJob) => {
  try {
    if (job.type === "import") {
      const documentValue = job.document as InternalDocument;
      await prepareImages(documentValue, localAssets, (message) => setStatus(message));
      parent.postMessage({ pluginMessage: { type: "import-json", document: documentValue, mode: (job.mode as ImportMode) || "CREATE" } }, "*");
      await completeMcpJob(job.id, await waitForPlugin());
      return;
    }
    if (job.type === "patch") {
      const patch = job.patch as InternalPatchDocument;
      const patchImages: InternalDocument = { nodes: patch.patch.operations.flatMap((operation, index) => operation.node ? [operation.node] : operation.normalized ? [{ id: `patch-image-${index}`, name: "Patch image", type: "FRAME", properties: operation.normalized, children: [] }] : []), styles: [], variables: [] };
      await prepareImages(patchImages, localAssets, (message) => setStatus(message));
      parent.postMessage({ pluginMessage: { type: "apply-patch", patch } }, "*");
      await completeMcpJob(job.id, await waitForPlugin());
      return;
    }
    if (job.type === "export") {
      parent.postMessage({ pluginMessage: { type: "export", scope: job.scope, targetId: job.targetId } }, "*");
      await completeMcpJob(job.id, await waitForPlugin());
    }
  } catch (error) {
    await completeMcpJob(job.id, { type: "import-error", message: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
  }
}, setMcpState);
