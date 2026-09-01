import { createHash } from "node:crypto";
import type {
  RemoteEventReplay,
  RemoteInteractionPage,
  RemoteInteractionView,
  RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import { projectRemoteAcpReplay } from "../autoRun/remoteAcpEventProjection.js";
import { stableJson } from "../plangraph/hash.js";
import {
  remoteWorkspaceExecutionHandleSchema,
  type RemoteWorkspaceAuthorityBinding,
  type RemoteWorkspaceExecutionHandle
} from "./contracts.js";
import {
  assertRemoteWorkAuthorityMatchesBinding,
  assertValidatedWorkspaceAuthorityBinding,
  isOwnerCanvasRemoteAuthorityBinding,
  type ValidatedWorkspaceAuthorityBinding
} from "./authorityBinding.js";
import { WorkspaceExecutionError, workspaceExecutionPortError } from "./errors.js";
import type {
  RemoteOperationCommandPort,
  RemoteOperationQueryPort,
  RemoteWorkspaceAdapterSnapshot,
  RemoteWorkspaceEvidenceSnapshot,
  RemoteWorkspaceExecutionAdapter,
  WorkAuthorityPort,
  WorkspaceExecutionInteractionPort,
  WorkspaceExecutionTerminal
} from "./ports.js";

type ValidatedRemoteBinding = ValidatedWorkspaceAuthorityBinding & RemoteWorkspaceAuthorityBinding;

function operationRevision(observation: RemoteOperationObservation): number {
  const revision = observation.diagnostics?.revision;
  if (revision === undefined) {
    throw new WorkspaceExecutionError("remote_operation_revision_missing");
  }
  return revision;
}

function terminalForObservation(
  observation: RemoteOperationObservation
): WorkspaceExecutionTerminal {
  if (observation.state === "completed") return { terminal: true, outcome: "completed" };
  if (observation.state === "failed") {
    return {
      terminal: true,
      outcome: "failed",
      errorCode:
        observation.failure?.code ??
        observation.diagnostics?.error?.code ??
        "remote_operation_failed"
    };
  }
  if (observation.state === "cancelled") return { terminal: true, outcome: "cancelled" };
  return {
    terminal: false,
    reason: observation.state === "action_required" ? "action_required" : "running"
  };
}

function assertRemoteBinding(
  binding: ValidatedWorkspaceAuthorityBinding
): asserts binding is ValidatedRemoteBinding {
  assertValidatedWorkspaceAuthorityBinding(binding);
  if (binding.kind !== "remote") {
    throw new WorkspaceExecutionError("workspace_execution_remote_binding_required");
  }
}

function assertObservationIdentity(input: {
  observation: RemoteOperationObservation;
  binding: ValidatedRemoteBinding;
  operationId?: string;
  endpointId: string;
}): void {
  const { observation, binding } = input;
  const diagnostics = observation.diagnostics;
  if (
    (input.operationId !== undefined && observation.operationId !== input.operationId) ||
    observation.projectId !== binding.projectId ||
    observation.canvasId !== binding.canvasId ||
    observation.blockRef !== binding.blockRef ||
    observation.dispatchId !== observation.attempt.dispatchId ||
    observation.executionAttemptId !== observation.attempt.executionAttemptId ||
    diagnostics === undefined ||
    diagnostics.attemptId !== observation.executionAttemptId ||
    (!isOwnerCanvasRemoteAuthorityBinding(binding) &&
      diagnostics.locator.workspaceId !== binding.workspaceId) ||
    diagnostics.locator.projectId !== binding.projectId ||
    diagnostics.locator.canvasId !== binding.canvasId ||
    diagnostics.endpointId !== input.endpointId ||
    observation.agentEndpoint?.endpointId !== input.endpointId ||
    diagnostics.authorityRevisions?.responsibility !==
      binding.authorityRevisions.responsibilityRevision ||
    diagnostics.authorityRevisions.reviewer !== binding.authorityRevisions.reviewerRevision ||
    diagnostics.authorityRevisions.executionTarget !==
      binding.authorityRevisions.executionTargetRevision ||
    diagnostics.content.revision !== binding.contentRevision ||
    diagnostics.content.fingerprint !== binding.graphFingerprint
  ) {
    throw new WorkspaceExecutionError(
      input.operationId === undefined
        ? "remote_dispatch_acceptance_mismatch"
        : "workspace_execution_resume_mismatch"
    );
  }
}

function handleFromObservation(input: {
  prior?: RemoteWorkspaceExecutionHandle;
  runSessionId: string;
  binding: ValidatedRemoteBinding;
  agentEndpointId: string;
  observation: RemoteOperationObservation;
}): RemoteWorkspaceExecutionHandle {
  const revision = operationRevision(input.observation);
  if (input.prior && revision < input.prior.operationRevision) {
    throw new WorkspaceExecutionError("remote_operation_observation_stale");
  }
  const executionAttemptId = input.observation.executionAttemptId;
  const attemptChanged =
    input.prior !== undefined && input.prior.executionAttemptId !== executionAttemptId;
  if (input.prior && revision === input.prior.operationRevision && attemptChanged) {
    throw new WorkspaceExecutionError("remote_attempt_revision_stale");
  }
  if (
    input.prior?.executionAttemptId === executionAttemptId &&
    input.prior.attemptStateVersion !== null &&
    input.observation.attempt.stateVersion < input.prior.attemptStateVersion
  ) {
    throw new WorkspaceExecutionError("remote_attempt_revision_stale");
  }
  const phase = input.prior?.phase === "acp_session" && !attemptChanged ? "acp_session" : "attempt";
  return remoteWorkspaceExecutionHandleSchema.parse({
    version: "planweave.workspace-execution-handle/v1",
    target: "remote",
    phase,
    runSessionId: input.runSessionId,
    authorityBindingId: input.binding.bindingId,
    scope: { kind: "block", blockRef: input.binding.blockRef },
    capabilities: { interactionResponse: true },
    operationId: input.observation.operationId,
    operationRevision: revision,
    dispatchId: input.observation.dispatchId,
    executionAttemptId,
    attemptStateVersion: input.observation.attempt.stateVersion,
    leaseId: input.observation.attempt.leaseId ?? null,
    agentEndpointId: input.agentEndpointId,
    cursor: {
      target: "remote",
      executionAttemptId,
      eventCursor: attemptChanged ? 0 : (input.prior?.cursor.eventCursor ?? 0)
    }
  });
}

function assertReplayCursorDomain(replay: RemoteEventReplay, requestedCursor: number): void {
  if (
    replay.afterCursor !== requestedCursor ||
    replay.cursor < requestedCursor ||
    replay.cursor > replay.highWatermark ||
    replay.hasMore !== replay.cursor < replay.highWatermark
  ) {
    throw new WorkspaceExecutionError("remote_event_cursor_gap");
  }
  const droppedThrough = Math.max(
    requestedCursor,
    ...(replay.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.code === "remote_acp_event_retention_gap")
      .map((diagnostic) => diagnostic.droppedThroughCursor)
  );
  let expectedCursor = droppedThrough;
  for (const event of replay.events) {
    expectedCursor += 1;
    if (event.cursor !== expectedCursor) {
      throw new WorkspaceExecutionError("remote_event_cursor_gap");
    }
  }
  if (replay.cursor !== expectedCursor) {
    throw new WorkspaceExecutionError("remote_event_cursor_gap");
  }
}

export function remoteInteractionIdentityKey(interaction: RemoteInteractionView): string {
  return remoteInteractionIdentityKeyFrom({
    operationId: interaction.operationId,
    dispatchId: interaction.request.dispatchId,
    leaseId: interaction.request.leaseId,
    executionAttemptId: interaction.request.executionAttemptId,
    acpSessionId: interaction.request.acpSessionId,
    actionId: interaction.request.actionId
  });
}

export function remoteInteractionIdentityKeyFrom(identity: {
  operationId: string;
  dispatchId: string;
  leaseId: string;
  executionAttemptId: string;
  acpSessionId: string;
  actionId: string;
}): string {
  const canonicalIdentity = {
    operationId: identity.operationId,
    dispatchId: identity.dispatchId,
    leaseId: identity.leaseId,
    executionAttemptId: identity.executionAttemptId,
    acpSessionId: identity.acpSessionId,
    actionId: identity.actionId
  };
  return `wxi:sha256:${createHash("sha256").update(stableJson(canonicalIdentity)).digest("hex")}`;
}

async function readInteractionSnapshot(
  query: RemoteOperationQueryPort,
  binding: ValidatedRemoteBinding,
  operationId: string,
  signal?: AbortSignal
): Promise<RemoteInteractionPage> {
  const items: RemoteInteractionView[] = [];
  let cursor = 0;
  for (;;) {
    const page = await query.interactions({ binding, operationId, cursor }, signal);
    items.push(...page.items);
    if (page.nextCursor === null) return { items, nextCursor: null };
    if (page.nextCursor <= cursor) {
      throw new WorkspaceExecutionError("remote_interaction_snapshot_unstable");
    }
    cursor = page.nextCursor;
  }
}

function interactionSnapshotFingerprint(page: RemoteInteractionPage): string {
  return stableJson(
    page.items.map((item) => ({ key: remoteInteractionIdentityKey(item), status: item.status }))
  );
}

export function createRemoteWorkspaceExecutionAdapter(input: {
  workAuthority: WorkAuthorityPort;
  command: RemoteOperationCommandPort;
  query: RemoteOperationQueryPort;
  interaction: WorkspaceExecutionInteractionPort;
}): RemoteWorkspaceExecutionAdapter {
  async function snapshotFromObservation(args: {
    observation: RemoteOperationObservation;
    binding: ValidatedRemoteBinding;
    runSessionId: string;
    endpointId: string;
    prior?: RemoteWorkspaceExecutionHandle;
  }): Promise<RemoteWorkspaceAdapterSnapshot> {
    assertObservationIdentity({
      observation: args.observation,
      binding: args.binding,
      operationId: args.prior?.operationId,
      endpointId: args.endpointId
    });
    const handle = handleFromObservation({
      prior: args.prior,
      runSessionId: args.runSessionId,
      binding: args.binding,
      agentEndpointId: args.endpointId,
      observation: args.observation
    });
    return {
      handle,
      observation: args.observation,
      replays: [],
      interactions: { items: [], nextCursor: null },
      terminal: terminalForObservation(args.observation)
    };
  }

  return {
    async inspectExisting({ binding, operationId, signal }) {
      assertRemoteBinding(binding);
      let observation: RemoteOperationObservation;
      try {
        observation = await input.query.observe({ binding, operationId }, signal);
      } catch (error) {
        throw workspaceExecutionPortError(error, "remote_observation_unavailable");
      }
      const endpointId = observation.agentEndpoint?.endpointId;
      if (!endpointId) throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
      assertObservationIdentity({ observation, binding, operationId, endpointId });
      return { observation, agentEndpointId: endpointId };
    },
    async attachExisting({ binding, session, observation, agentEndpointId }) {
      assertRemoteBinding(binding);
      return snapshotFromObservation({
        observation,
        binding,
        runSessionId: session.sessionId,
        endpointId: agentEndpointId
      });
    },
    async launch({ binding, target, session, intent, signal }) {
      assertRemoteBinding(binding);
      let authority: Awaited<ReturnType<WorkAuthorityPort["ensure"]>>;
      try {
        authority = await input.workAuthority.ensure({ binding }, signal);
      } catch (error) {
        throw workspaceExecutionPortError(error, "work_authority_unavailable");
      }
      assertRemoteWorkAuthorityMatchesBinding(binding, authority);
      let observation: RemoteOperationObservation;
      try {
        observation = await input.command.dispatch({ binding, intent }, signal);
      } catch (error) {
        throw workspaceExecutionPortError(error, "remote_dispatch_unavailable");
      }
      return snapshotFromObservation({
        observation,
        binding,
        runSessionId: session.sessionId,
        endpointId: target.agentEndpointId
      });
    },
    async recover({ binding, session, intent, signal }) {
      assertRemoteBinding(binding);
      let observation: RemoteOperationObservation | null;
      try {
        observation = await input.query.recover(
          { binding, idempotencyKey: intent.idempotencyKey },
          signal
        );
      } catch (error) {
        throw workspaceExecutionPortError(error, "remote_observation_unavailable");
      }
      if (!observation) return null;
      return snapshotFromObservation({
        observation,
        binding,
        runSessionId: session.sessionId,
        endpointId: intent.agentEndpointId
      });
    },
    async follow({ handle, binding, signal }) {
      assertRemoteBinding(binding);
      if (handle.authorityBindingId !== binding.bindingId) {
        throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
      }
      let observation: RemoteOperationObservation;
      try {
        observation = await input.query.observe(
          { binding, operationId: handle.operationId },
          signal
        );
      } catch (error) {
        throw workspaceExecutionPortError(error, "remote_observation_unavailable");
      }
      return snapshotFromObservation({
        observation,
        binding,
        runSessionId: handle.runSessionId,
        endpointId: handle.agentEndpointId,
        prior: handle
      });
    },
    async collectEvidence({ handle, binding, signal }): Promise<RemoteWorkspaceEvidenceSnapshot> {
      assertRemoteBinding(binding);
      const replays: RemoteEventReplay[] = [];
      let afterCursor = handle.cursor.eventCursor;
      for (;;) {
        let replay: RemoteEventReplay;
        try {
          replay = await input.query.replay(
            { binding, operationId: handle.operationId, afterCursor },
            signal
          );
        } catch (error) {
          throw workspaceExecutionPortError(error, "remote_replay_unavailable");
        }
        if (replay.executionAttemptId !== handle.executionAttemptId) {
          throw new WorkspaceExecutionError("remote_attempt_changed");
        }
        assertReplayCursorDomain(replay, afterCursor);
        projectRemoteAcpReplay(replay);
        replays.push(replay);
        afterCursor = replay.cursor;
        if (!replay.hasMore) break;
        if (replay.cursor === replay.afterCursor) {
          throw new WorkspaceExecutionError("remote_event_cursor_gap");
        }
      }
      let first: RemoteInteractionPage;
      let second: RemoteInteractionPage;
      try {
        first = await readInteractionSnapshot(input.query, binding, handle.operationId, signal);
        second = await readInteractionSnapshot(input.query, binding, handle.operationId, signal);
      } catch (error) {
        if (error instanceof WorkspaceExecutionError) throw error;
        throw workspaceExecutionPortError(error, "remote_interactions_unavailable");
      }
      if (interactionSnapshotFingerprint(first) !== interactionSnapshotFingerprint(second)) {
        throw new WorkspaceExecutionError("remote_interaction_snapshot_unstable");
      }
      for (const item of second.items) {
        if (
          item.operationId !== handle.operationId ||
          item.request.dispatchId !== handle.dispatchId ||
          item.request.executionAttemptId !== handle.executionAttemptId ||
          (handle.leaseId !== null && item.request.leaseId !== handle.leaseId)
        ) {
          throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
        }
      }
      return {
        handle: remoteWorkspaceExecutionHandleSchema.parse({
          ...handle,
          phase: "acp_session",
          cursor: { ...handle.cursor, eventCursor: afterCursor }
        }),
        replays,
        interactions: second
      };
    },
    async respond({ handle, binding, response, signal }) {
      assertRemoteBinding(binding);
      if (
        handle.authorityBindingId !== binding.bindingId ||
        response.executionAttemptId !== handle.executionAttemptId ||
        response.dispatchId === undefined
      ) {
        throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
      }
      try {
        const interaction = await input.interaction.respond(
          { binding, operationId: handle.operationId, response },
          signal
        );
        if (
          interaction.operationId !== handle.operationId ||
          interaction.status !== "settled" ||
          interaction.request.dispatchId !== response.dispatchId ||
          interaction.request.leaseId !== response.leaseId ||
          interaction.request.executionAttemptId !== response.executionAttemptId ||
          interaction.request.acpSessionId !== response.acpSessionId ||
          interaction.request.actionId !== response.actionId ||
          stableJson(interaction.settlement) !== stableJson(response)
        ) {
          throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
        }
        return interaction;
      } catch (error) {
        if (error instanceof WorkspaceExecutionError) throw error;
        throw workspaceExecutionPortError(error, "remote_interaction_response_unavailable");
      }
    }
  };
}
