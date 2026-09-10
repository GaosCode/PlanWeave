import { recordDesktopError } from "../desktopDiagnosticsLog.js";
import type { z } from "zod";
import {
  collaborationCommandErrorSchema,
  type CollaborationCommandResult
} from "../../shared/collaborationCommandIpc.js";
import { collaborationErrorFromUnknown } from "./collaborationErrors.js";

function commandErrorMessage(code: string, message: string): string {
  if (code === "human_rate_limited") {
    return "Too many collaboration requests. Try again shortly.";
  }
  if (code === "human_limit_exceeded") {
    return "The open invitation limit has been reached.";
  }
  return (message || code).slice(0, 512);
}

export async function runCollaborationCommand<T>(
  operation: () => Promise<T>,
  valueSchema: z.ZodType<T>
): Promise<CollaborationCommandResult<T>> {
  try {
    return {
      ok: true,
      value: valueSchema.parse(await operation())
    };
  } catch (error) {
    await recordDesktopError("collaboration.command", error);
    const mapped = collaborationErrorFromUnknown(error);
    return {
      ok: false,
      error: collaborationCommandErrorSchema.parse({
        kind: mapped.kind,
        code: mapped.code,
        message: commandErrorMessage(mapped.code, mapped.message),
        ...(mapped.httpStatus === undefined ? {} : { httpStatus: mapped.httpStatus }),
        ...(mapped.retryAfterMs === undefined ? {} : { retryAfterMs: mapped.retryAfterMs }),
        retryable: mapped.retryable
      })
    };
  }
}
