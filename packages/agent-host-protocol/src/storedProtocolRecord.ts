import { z } from "zod";
import { agentHostProtocolVersion } from "./version.js";

type PreviousProtocolRecord<T> = T extends { protocolVersion: number }
  ? Omit<T, "protocolVersion"> & { protocolVersion: 1 }
  : never;

export function storedProtocolRecord<T extends { protocolVersion: number }>(current: z.ZodType<T>) {
  return z.union([
    current,
    z
      .object({ protocolVersion: z.literal(1) })
      .loose()
      .transform((record, context) => {
        const parsed = current.safeParse({ ...record, protocolVersion: agentHostProtocolVersion });
        if (!parsed.success) {
          for (const issue of parsed.error.issues)
            context.addIssue({ code: "custom", message: issue.message, path: issue.path });
          return z.NEVER;
        }
        const { protocolVersion: _version, ...body } = parsed.data;
        return { ...body, protocolVersion: 1 } as PreviousProtocolRecord<T>;
      })
  ]);
}
