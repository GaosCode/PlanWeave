export type ValidationIssue = {
  code: string;
  message: string;
  path?: string;
};

export type ValidationReport = {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};
