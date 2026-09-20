import { z } from "zod";

export const serverDataRestoreDiagnosticSchema = z
  .object({
    phase: z.enum(["prepare", "backup", "promotion", "cleanup"]),
    outcome: z.enum(["not_committed", "rollback_failed", "committed"]),
    target: z.string(),
    staging: z.string(),
    backup: z.string().optional()
  })
  .strict();
export type ServerDataRestoreDiagnostic = z.infer<typeof serverDataRestoreDiagnosticSchema>;

export class ServerDataArchiveError extends Error {
  readonly diagnostic?: ServerDataRestoreDiagnostic;
  constructor(
    readonly code: string,
    options?: ErrorOptions & { diagnostic?: ServerDataRestoreDiagnostic }
  ) {
    super(code, options);
    this.name = "ServerDataArchiveError";
    this.diagnostic = options?.diagnostic;
  }
}
