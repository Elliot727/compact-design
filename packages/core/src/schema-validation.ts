import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import { schema } from "./schema";
import type { RepairIssue } from "./lint";

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  compiled ||= new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  return compiled;
}

function issue(error: ErrorObject): RepairIssue {
  const missing = error.keyword === "required" && typeof error.params.missingProperty === "string" ? `/${error.params.missingProperty}` : "";
  return {
    severity: "ERROR",
    code: `SCHEMA_${error.keyword.toUpperCase()}`,
    path: `$${error.instancePath}${missing}`,
    message: error.message || "does not match the Compact Design schema",
    suggestion: "Use the property types and allowed values from the Compact Design schema."
  };
}

export function validateSchema(value: unknown): RepairIssue[] {
  const validate = validator();
  return validate(value) ? [] : (validate.errors || []).map(issue);
}
