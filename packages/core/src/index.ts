import { lintDocument, validationIssues, type RepairIssue } from "./lint";
import { isPatchDocument, normalizeDocument, normalizePatchDocument } from "./normalize";
import { applyDocumentPatch, type PatchResult } from "./patch";
import { parseDocument } from "./parser";
import { schema } from "./schema";
import { validateSchema } from "./schema-validation";
import type { InternalDocument, InternalPatchDocument } from "./types";
import { validateDocument } from "./validate";

export interface ValidationResult { valid: boolean; issues: RepairIssue[]; document?: InternalDocument; patch?: InternalPatchDocument; }

export function parse(source: string): unknown { return parseDocument(source); }
export function normalize(value: unknown): InternalDocument { return normalizeDocument(value); }
export function normalizePatch(value: unknown): InternalPatchDocument { return normalizePatchDocument(value); }
export function validate(value: unknown): ValidationResult {
  try {
    const schemaIssues = validateSchema(value);
    if (schemaIssues.length) return { valid: false, issues: schemaIssues };
    if (isPatchDocument(value)) return { valid: true, issues: [], patch: normalizePatchDocument(value) };
    const document = normalizeDocument(value);
    const issues = validationIssues(validateDocument(document));
    return { valid: issues.length === 0, issues, document };
  } catch (error) {
    return { valid: false, issues: [{ severity: "ERROR", code: "PARSE_OR_NORMALIZE", path: "$", message: error instanceof Error ? error.message : String(error), suggestion: "Correct the document using the Compact Design schema." }] };
  }
}
export function lint(value: InternalDocument): RepairIssue[] { return lintDocument(value); }
export function applyPatch(document: InternalDocument, patch: InternalPatchDocument): PatchResult { return applyDocumentPatch(document, patch); }

export { isPatchDocument, schema };
export { indexDocument } from "./references";
export type { DocumentIndex } from "./references";
export type { PatchResult, RepairIssue };
export type * from "./types";
