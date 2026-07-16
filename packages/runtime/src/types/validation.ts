export type ValidationIssue = {
  code: string;
  message: string;
  path?: string;
  transitionId?: string;
};

export type ValidationSummaryGroup = {
  code: string;
  message: string;
  count: number;
  examples: string[];
};

export type ValidationSummary = {
  errorCount: number;
  warningCount: number;
  groups: ValidationSummaryGroup[];
};

export type ValidationReport = {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  summary: ValidationSummary;
};
