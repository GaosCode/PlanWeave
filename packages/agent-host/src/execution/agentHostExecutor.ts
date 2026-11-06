import type { ExecuteAcpOptions } from "@planweave-ai/runtime";
import type {
  ArtifactRef,
  DispatchResult,
  NormalizedFailure,
  ServerToHostCommand
} from "../protocol.js";
import { normalizedFailureSchema, type ArtifactMediaType } from "@planweave-ai/agent-host-protocol";

export type AgentHostExecuteCommand = Extract<ServerToHostCommand, { type: "execute_block" }>;

export type AgentHostArtifactInput = {
  bytes: Uint8Array;
  mediaType: ArtifactMediaType;
  purpose: "report" | "output";
  operationKey: string;
};

export type AgentHostArtifactDownload = {
  artifactRef: ArtifactRef;
  logicalName: string;
  mediaType?: ArtifactMediaType;
};

export type AgentHostArtifactDownloadResult = {
  bytes: Uint8Array;
  mediaType: ArtifactMediaType;
};

/** Artifact transfer already bound to the active dispatch and lease. */
export interface AgentHostArtifactTransfer {
  download(input: AgentHostArtifactDownload): Promise<AgentHostArtifactDownloadResult>;
  upload(input: AgentHostArtifactInput): Promise<ArtifactRef>;
}

export type AgentHostExecutionContext = {
  signal: AbortSignal;
  readonly cancellationStartedAt?: number;
  cleanupObserver?: ExecuteAcpOptions["cleanupObserver"];
  executionKey: string;
  artifacts: AgentHostArtifactTransfer;
  sessionStart: { kind: "new" } | { kind: "load"; sessionId: string };
};

export class AgentHostExecutionError extends Error {
  readonly failure: NormalizedFailure;

  constructor(failure: NormalizedFailure) {
    const parsed = normalizedFailureSchema.parse(failure);
    super(parsed.message);
    this.failure = parsed;
    this.name = "AgentHostExecutionError";
  }
}

export class AgentHostSessionLoadError extends AgentHostExecutionError {
  constructor() {
    super({
      code: "acp_session_load_failed",
      message: "The Agent Host could not load the interrupted ACP session.",
      retryable: false
    });
    this.name = "AgentHostSessionLoadError";
  }
}

export interface AgentHostExecutor {
  execute(
    command: AgentHostExecuteCommand,
    context: AgentHostExecutionContext
  ): Promise<DispatchResult>;
}
