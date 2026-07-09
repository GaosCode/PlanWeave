import type { ValidationIssue, ValidationSummary } from "../types.js";

const MAX_EXAMPLES_PER_GROUP = 3;

type ValidationIssueCollections = {
  errors: readonly ValidationIssue[];
  warnings: readonly ValidationIssue[];
};

type MutableValidationSummaryGroup = {
  code: string;
  message: string;
  count: number;
  examples: string[];
};

function normalizePathPattern(path: string | undefined): string {
  if (path === undefined) {
    return "";
  }

  return path
    .split(".")
    .map((segment) => (/^\d+$/.test(segment) ? "[]" : segment))
    .join(".");
}

function groupKeyForIssue(issue: ValidationIssue): string {
  return [issue.code, issue.message, normalizePathPattern(issue.path)].join("\u0000");
}

function appendIssue(
  groupsByKey: Map<string, MutableValidationSummaryGroup>,
  issue: ValidationIssue
): void {
  const groupKey = groupKeyForIssue(issue);
  const existingGroup = groupsByKey.get(groupKey);
  const group = existingGroup ?? {
    code: issue.code,
    message: issue.message,
    count: 0,
    examples: []
  };

  group.count += 1;
  const example = issue.path ?? issue.message;
  if (group.examples.length < MAX_EXAMPLES_PER_GROUP) {
    group.examples.push(example);
  }
  groupsByKey.set(groupKey, group);
}

function isValidationIssueArray(
  input: readonly ValidationIssue[] | ValidationIssueCollections
): input is readonly ValidationIssue[] {
  return Array.isArray(input);
}

function issueCollectionsFromInput(
  errorsOrReport: readonly ValidationIssue[] | ValidationIssueCollections,
  warnings?: readonly ValidationIssue[]
): ValidationIssueCollections {
  if (isValidationIssueArray(errorsOrReport)) {
    return {
      errors: errorsOrReport,
      warnings: warnings ?? []
    };
  }
  return errorsOrReport;
}

export function summarizeValidationReport(report: ValidationIssueCollections): ValidationSummary;
export function summarizeValidationReport(
  errors: readonly ValidationIssue[],
  warnings?: readonly ValidationIssue[]
): ValidationSummary;
export function summarizeValidationReport(
  errorsOrReport: readonly ValidationIssue[] | ValidationIssueCollections,
  warnings?: readonly ValidationIssue[]
): ValidationSummary {
  const issueCollections = issueCollectionsFromInput(errorsOrReport, warnings);
  const groupsByKey = new Map<string, MutableValidationSummaryGroup>();

  for (const error of issueCollections.errors) {
    appendIssue(groupsByKey, error);
  }
  for (const warning of issueCollections.warnings) {
    appendIssue(groupsByKey, warning);
  }

  return {
    errorCount: issueCollections.errors.length,
    warningCount: issueCollections.warnings.length,
    groups: Array.from(groupsByKey.values())
  };
}
