import { z } from "zod";

export const desktopCommandFailureSchema = z
  .object({
    desktopCommandFailure: z.literal(true),
    error: z
      .object({
        kind: z.string().min(1).max(64),
        code: z.string().min(1).max(128),
        message: z.string().min(1).max(512),
        retryable: z.boolean(),
        httpStatus: z.number().int().optional()
      })
      .strict()
  })
  .strict();

export class DesktopCommandError extends Error {
  readonly kind: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  constructor(error: z.infer<typeof desktopCommandFailureSchema>["error"]) {
    super(error.message);
    this.name = "DesktopCommandError";
    this.kind = error.kind;
    this.code = error.code;
    this.retryable = error.retryable;
    this.httpStatus = error.httpStatus;
  }
}

export function unwrapDesktopCommandFailure(value: unknown): void {
  if (value && typeof value === "object" && "desktopCommandFailure" in value) {
    throw new DesktopCommandError(desktopCommandFailureSchema.parse(value).error);
  }
}
