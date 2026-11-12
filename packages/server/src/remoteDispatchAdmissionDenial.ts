import { agentEndpointErrorCodeSchema } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { z } from "zod";
import { AgentEndpointCatalogError } from "./agentEndpointCatalog.js";
import { CanvasRuntimeUnavailableError } from "./canvas/executionRuntimePort.js";
import {
  RemoteAgentAuthorizationError,
  remoteAgentAuthorizationErrorCodeSchema
} from "./remoteAgent/errors.js";
import { DispatchAssignmentError } from "./work/dispatchIntegration.js";
import { workAssignmentErrorCodeSchema } from "./work/errors.js";

const catalogDenialCodeSchema = agentEndpointErrorCodeSchema.extract([
  "agent_endpoint_unknown",
  "agent_endpoint_unavailable",
  "agent_endpoint_incompatible"
]);

export const remoteDispatchAdmissionDenialSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("catalog"), code: catalogDenialCodeSchema }).strict(),
  z
    .object({ kind: z.literal("agent_access"), code: remoteAgentAuthorizationErrorCodeSchema })
    .strict(),
  z
    .object({
      kind: z.literal("assignment"),
      code: workAssignmentErrorCodeSchema,
      message: z.string()
    })
    .strict(),
  z.object({ kind: z.literal("host"), code: z.literal("host_offline") }).strict()
]);

type AdmissionDenial = z.infer<typeof remoteDispatchAdmissionDenialSchema>;

export type RemoteDispatchActivationDenial = { error: Error; evidence: AdmissionDenial };

export function describeRemoteDispatchAdmissionDenial(
  error: unknown
): RemoteDispatchActivationDenial {
  if (error instanceof RemoteAgentAuthorizationError) {
    return { error, evidence: { kind: "agent_access", code: error.code } };
  }
  if (error instanceof AgentEndpointCatalogError) {
    return { error, evidence: { kind: "catalog", code: error.code } };
  }
  if (error instanceof DispatchAssignmentError) {
    return { error, evidence: { kind: "assignment", code: error.code, message: error.message } };
  }
  throw error;
}

export function restoreRemoteDispatchAdmissionError(evidence: AdmissionDenial): Error {
  switch (evidence.kind) {
    case "catalog":
      return new AgentEndpointCatalogError(evidence.code);
    case "agent_access":
      return new RemoteAgentAuthorizationError(evidence.code);
    case "assignment":
      return new DispatchAssignmentError(evidence.code, evidence.message);
    case "host":
      return new CanvasRuntimeUnavailableError(evidence.code);
  }
}

export class PersistedRemoteDispatchAdmissionDenial extends Error {
  constructor(readonly originalError: Error) {
    super(originalError.message, { cause: originalError });
  }
}

export class RemoteDispatchAdmissionCompensationError extends Error {
  constructor(readonly originalError: unknown) {
    super(originalError instanceof Error ? originalError.message : String(originalError), {
      cause: originalError
    });
  }
}

export function throwRemoteDispatchAdmissionError(error: unknown): never {
  throw error instanceof PersistedRemoteDispatchAdmissionDenial ||
    error instanceof RemoteDispatchAdmissionCompensationError
    ? error.originalError
    : error;
}
