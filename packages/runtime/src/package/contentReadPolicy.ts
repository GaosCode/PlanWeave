import { z } from "zod";

export const DEFAULT_MAX_BYTES = 20_000;
export const MAX_CONTENT_BYTES = 1024 * 1024;
export const MAX_FILE_READ_BYTES = 64 * 1024 * 1024;
export const MAX_LIST_READ_BYTES = 256 * 1024 * 1024;
export const contentMaxBytesSchema = z.number().int().positive().max(MAX_CONTENT_BYTES);

export class ContentReadError extends Error {
  constructor(
    readonly code:
      | "content_max_bytes_invalid"
      | "content_file_budget_exceeded"
      | "content_page_budget_exceeded",
    message: string
  ) {
    super(message);
    this.name = "ContentReadError";
  }
}

export function normalizeContentMaxBytes(value: unknown): number {
  const parsed = contentMaxBytesSchema.safeParse(value === undefined ? DEFAULT_MAX_BYTES : value);
  if (!parsed.success) {
    throw new ContentReadError(
      "content_max_bytes_invalid",
      `maxBytes must be a safe positive integer no greater than ${MAX_CONTENT_BYTES}.`
    );
  }
  return parsed.data;
}
