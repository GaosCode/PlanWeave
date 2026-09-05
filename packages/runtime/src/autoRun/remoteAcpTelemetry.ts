import { acpSessionIdSchema } from "./runnerContractSchemas.js";
import { engineUsageSnapshotLeafSchema } from "@planweave-ai/agent-host-protocol/browser";
import { z } from "zod";
import { acpContextUsageSnapshotSchema, projectAcpContextUsage } from "./acpUsageProjection.js";
import {
  acpActualSessionConfigurationSchema,
  projectAcpActualSessionConfiguration
} from "./acpSessionConfiguration.js";
import type { ProjectedRemoteAcpEvent } from "./remoteAcpEventProjection.js";

export const remoteAcpTelemetrySchema = z
  .object({
    executionAttemptId: z.string().min(1).nullable(),
    sessionId: z.string().min(1).nullable(),
    loadSession: z.boolean().nullable(),
    currentContext: acpContextUsageSnapshotSchema.nullable(),
    cumulativeUsage: engineUsageSnapshotLeafSchema.nullable(),
    actualConfiguration: acpActualSessionConfigurationSchema
  })
  .strict();
export type RemoteAcpTelemetry = z.infer<typeof remoteAcpTelemetrySchema>;

export function projectRemoteAcpTelemetry(
  inputs: readonly ProjectedRemoteAcpEvent[]
): RemoteAcpTelemetry {
  const executionAttemptId = inputs.at(-1)?.executionAttemptId ?? null;
  const events = inputs.filter((event) => event.executionAttemptId === executionAttemptId);
  let sessionId: string | null = null;
  let loadSession: boolean | null = null;
  let cumulativeUsage: RemoteAcpTelemetry["cumulativeUsage"] = null;
  const normalized = events.map((event) => {
    const evidence = event.engineEvidence;
    if (evidence?.kind === "session_started") sessionId = evidence.sessionId;
    if (evidence?.kind === "capabilities") loadSession = evidence.capabilities.loadSession;
    if (evidence?.kind === "usage_snapshot") cumulativeUsage = evidence.usage;
    return {
      sequence: event.cursor,
      timestamp: event.timestamp,
      body: event.body,
      ...(sessionId === null
        ? {}
        : { correlation: { sessionId: acpSessionIdSchema.parse(sessionId) } })
    };
  });
  return remoteAcpTelemetrySchema.parse({
    executionAttemptId,
    sessionId,
    loadSession,
    currentContext: projectAcpContextUsage(normalized),
    cumulativeUsage,
    actualConfiguration: projectAcpActualSessionConfiguration(normalized)
  });
}
