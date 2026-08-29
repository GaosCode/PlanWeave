import type { RemoteAgentEndpointList } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import type {
  RemoteDispatchIntentV3,
  RemoteEventReplay,
  RemoteInteractionPage,
  RemoteInteractionResponse,
  RemoteInteractionView,
  RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import type { WorkAuthorityProjection } from "@planweave-ai/collaboration-protocol/work/authority";
import type { RunSessionState } from "../runSessions/types.js";
import type {
  LocalWorkspaceExecutionHandle,
  RemoteWorkspaceAuthorityBinding,
  RemoteWorkspaceExecutionHandle,
  WorkspaceExecutionDispatchIntent,
  WorkspaceExecutionHandle,
  WorkspaceExecutionRequest,
  WorkspaceExecutionTarget
} from "./contracts.js";
import type { ValidatedWorkspaceAuthorityBinding } from "./authorityBinding.js";

export interface RemoteAgentCatalogPort {
  list(
    input: {
      binding: ValidatedWorkspaceAuthorityBinding & RemoteWorkspaceAuthorityBinding;
      executor: NonNullable<WorkspaceExecutionRequest["effectiveExecutor"]>;
    },
    signal?: AbortSignal
  ): Promise<RemoteAgentEndpointList>;
}

export interface WorkAuthorityPort {
  ensure(
    input: { binding: ValidatedWorkspaceAuthorityBinding & RemoteWorkspaceAuthorityBinding },
    signal?: AbortSignal
  ): Promise<WorkAuthorityProjection>;
}

export interface RemoteOperationCommandPort {
  dispatch(
    input: {
      binding: ValidatedWorkspaceAuthorityBinding & RemoteWorkspaceAuthorityBinding;
      intent: RemoteDispatchIntentV3;
    },
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation>;
}

export interface RemoteOperationQueryPort {
  recover(
    input: {
      binding: ValidatedWorkspaceAuthorityBinding & RemoteWorkspaceAuthorityBinding;
      idempotencyKey: string;
    },
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation | null>;
  observe(
    input: {
      binding: ValidatedWorkspaceAuthorityBinding & RemoteWorkspaceAuthorityBinding;
      operationId: string;
    },
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation>;
  replay(
    input: {
      binding: ValidatedWorkspaceAuthorityBinding & RemoteWorkspaceAuthorityBinding;
      operationId: string;
      afterCursor: number;
    },
    signal?: AbortSignal
  ): Promise<RemoteEventReplay>;
  interactions(
    input: {
      binding: ValidatedWorkspaceAuthorityBinding & RemoteWorkspaceAuthorityBinding;
      operationId: string;
      cursor: number;
    },
    signal?: AbortSignal
  ): Promise<RemoteInteractionPage>;
}

export interface WorkspaceExecutionInteractionPort {
  respond(
    input: {
      binding: ValidatedWorkspaceAuthorityBinding & RemoteWorkspaceAuthorityBinding;
      operationId: string;
      response: RemoteInteractionResponse;
    },
    signal?: AbortSignal
  ): Promise<RemoteInteractionView>;
}

export type WorkspaceExecutionTerminal =
  | { terminal: false; reason: "running" | "action_required" }
  | {
      terminal: true;
      outcome: "completed" | "failed" | "cancelled";
      errorCode?: string;
    };

export type LocalWorkspaceAdapterSnapshot = {
  handle: LocalWorkspaceExecutionHandle;
  session: RunSessionState;
  terminal: WorkspaceExecutionTerminal;
};

export type RemoteWorkspaceAdapterSnapshot = {
  handle: RemoteWorkspaceExecutionHandle;
  observation: RemoteOperationObservation;
  replays: RemoteEventReplay[];
  interactions: RemoteInteractionPage;
  terminal: WorkspaceExecutionTerminal;
};

export type RemoteWorkspaceEvidenceSnapshot = {
  handle: RemoteWorkspaceExecutionHandle;
  replays: RemoteEventReplay[];
  interactions: RemoteInteractionPage;
};

export interface LocalWorkspaceExecutionAdapter {
  launch(input: {
    request: WorkspaceExecutionRequest;
    binding: ValidatedWorkspaceAuthorityBinding;
    signal?: AbortSignal;
  }): Promise<LocalWorkspaceAdapterSnapshot>;
}

export interface RemoteWorkspaceExecutionAdapter {
  launch(input: {
    request: WorkspaceExecutionRequest;
    binding: ValidatedWorkspaceAuthorityBinding;
    target: Extract<WorkspaceExecutionTarget, { target: "remote" }>;
    session: RunSessionState;
    intent: WorkspaceExecutionDispatchIntent;
    signal?: AbortSignal;
  }): Promise<RemoteWorkspaceAdapterSnapshot>;
  recover(input: {
    binding: ValidatedWorkspaceAuthorityBinding;
    session: RunSessionState;
    intent: WorkspaceExecutionDispatchIntent;
    signal?: AbortSignal;
  }): Promise<RemoteWorkspaceAdapterSnapshot | null>;
  follow(input: {
    handle: RemoteWorkspaceExecutionHandle;
    binding: ValidatedWorkspaceAuthorityBinding;
    signal?: AbortSignal;
  }): Promise<RemoteWorkspaceAdapterSnapshot>;
  collectEvidence(input: {
    handle: RemoteWorkspaceExecutionHandle;
    binding: ValidatedWorkspaceAuthorityBinding;
    signal?: AbortSignal;
  }): Promise<RemoteWorkspaceEvidenceSnapshot>;
  respond(input: {
    handle: RemoteWorkspaceExecutionHandle;
    binding: ValidatedWorkspaceAuthorityBinding;
    response: RemoteInteractionResponse;
    signal?: AbortSignal;
  }): Promise<RemoteInteractionView>;
}

export type WorkspaceExecutionAdapterSnapshot =
  | LocalWorkspaceAdapterSnapshot
  | RemoteWorkspaceAdapterSnapshot;

export type WorkspaceExecutionAdapterHandle = WorkspaceExecutionHandle;
