import { lintDocument, validationIssues, type RepairIssue } from "./lint";
import { isPatchDocument, normalizeDocument, normalizePatchDocument } from "./normalize";
import { applyDocumentPatch, PatchError, type PatchResult } from "./patch";
import { parseDocument } from "./parser";
import { schema } from "./schema";
import { validateSchema } from "./schema-validation";
import { patchSetShapeIssues } from "./patch-keys";
import type { InternalDocument, InternalPatchDocument, JsonObject } from "./types";
import { validateDocument } from "./validate";

export interface ValidationResult { valid: boolean; issues: RepairIssue[]; document?: InternalDocument; patch?: InternalPatchDocument; }

function parseIssue(error: unknown, code = "PARSE_OR_NORMALIZE"): RepairIssue {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^(patch\.operations\[\d+\](?:\.[^:\s]+)?): (.*)$/s.exec(message);
  return { severity: "ERROR", code, path: match ? match[1] : "$", message: match ? match[2] : message, suggestion: "Correct the document using the Compact Design schema." };
}

export function parse(source: string): unknown { return parseDocument(source); }
export function normalize(value: unknown): InternalDocument { return normalizeDocument(value); }
export function normalizePatch(value: unknown): InternalPatchDocument { return normalizePatchDocument(value); }

/**
 * Validate a full document or a patch document. Patch documents are checked
 * against the schema ($defs.patchSet rejects unknown keys) and by core's
 * patch normalizer (deferred keys, conflicting keys). Rules that depend on the
 * target node run in validatePatch / applyPatch.
 */
export function validate(value: unknown): ValidationResult {
  try {
    const schemaIssues = validateSchema(value);
    if (schemaIssues.length) return { valid: false, issues: isPatchDocument(value) ? [...patchKeyIssues(value), ...schemaIssues] : schemaIssues };
    if (isPatchDocument(value)) {
      try { return { valid: true, issues: [], patch: normalizePatchDocument(value) }; }
      catch (error) { return { valid: false, issues: [parseIssue(error, "PATCH_SET_UNSUPPORTED")] }; }
    }
    const document = normalizeDocument(value);
    const issues = validationIssues(validateDocument(document));
    return { valid: issues.length === 0, issues, document };
  } catch (error) {
    return { valid: false, issues: [parseIssue(error)] };
  }
}

/** Precise per-key issues for set operations, so a schema failure still names the offending key. */
function patchKeyIssues(value: unknown): RepairIssue[] {
  const operations = (value as { patch?: { operations?: unknown } }).patch?.operations;
  if (!Array.isArray(operations)) return [];
  const issues: RepairIssue[] = [];
  operations.forEach((operation, index) => {
    if (!operation || typeof operation !== "object") return;
    const { op, set } = operation as { op?: unknown; set?: unknown };
    if (op !== "set" || !set || typeof set !== "object" || Array.isArray(set)) return;
    for (const issue of patchSetShapeIssues(set as JsonObject)) {
      const split = issue.indexOf(": ");
      const key = split > 0 ? issue.slice(0, split) : "";
      issues.push({ severity: "ERROR", code: "PATCH_SET_UNSUPPORTED", path: `patch.operations[${index}].set${key ? `.${key}` : ""}`, message: split > 0 ? issue.slice(split + 2) : issue, suggestion: "Use only the settable keys listed in PATCH_SET_KEYS / DESIGN-LANGUAGE.md (Patch set semantics)." });
    }
  });
  return issues;
}

export interface PatchValidationResult { valid: boolean; issues: RepairIssue[]; patch?: InternalPatchDocument; document?: InternalDocument; affectedIds?: string[]; warnings?: string[]; }

/**
 * Validate a raw patch against the document it will be applied to: schema,
 * key rules, target-type rules, and validateDocument on the patched result
 * (bindings, styleRefs, variants, sizes, ...). Only issues the patch
 * introduces are reported; issues already in the input document never block.
 * Returns the patched document when valid. Never throws.
 */
export function validatePatch(document: InternalDocument, patch: unknown): PatchValidationResult {
  const checked = validate(patch);
  if (!checked.valid) return { valid: false, issues: checked.issues };
  if (!checked.patch) return { valid: false, issues: [{ severity: "ERROR", code: "PATCH_EXPECTED", path: "$", message: "Expected a patch document with a top-level patch.operations array.", suggestion: "Wrap operations in { \"patch\": { \"operations\": [...] } }." }] };
  try {
    const result = applyDocumentPatch(document, checked.patch);
    return { valid: true, issues: [], patch: checked.patch, document: result.document, affectedIds: result.affectedIds, warnings: result.warnings };
  } catch (error) {
    return { valid: false, issues: error instanceof PatchError ? error.issues : [parseIssue(error, "PATCH_OPERATION")], patch: checked.patch };
  }
}

export function lint(value: InternalDocument): RepairIssue[] { return lintDocument(value); }
/** Apply a normalized patch. Throws PatchError when an operation or the patched document is invalid. */
export function applyPatch(document: InternalDocument, patch: InternalPatchDocument): PatchResult { return applyDocumentPatch(document, patch); }

export { isPatchDocument, schema, PatchError };
export { normalizePatchSet } from "./normalize";
export { corePatchContext, newDocumentIssues } from "./patch";
export {
  PATCH_SET_KEYS, PATCH_SET_EXCLUDED_NODE_KEYS, PATCH_SET_SEMANTICS, PATCH_SET_APPLIES_TO, PATCH_SET_DEFERRED_KEYS, PATCH_TEXT_STYLE_KEYS,
  isPatchSetKey, patchSetShapeIssues, patchSetTargetIssues, patchSetBindingFields
} from "./patch-keys";
export type { PatchSetKey, PatchSetSemantics, PatchTargetContext } from "./patch-keys";
export { indexDocument } from "./references";
export type { DocumentIndex } from "./references";
export type { PatchResult, RepairIssue };
export type * from "./types";
