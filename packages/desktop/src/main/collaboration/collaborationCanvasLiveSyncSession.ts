import {
  collaborationCanvasBindingInputSchema,
  type CollaborationCanvasBindingInput,
  type CollaborationCanvasLiveSyncSignal
} from "../../shared/collaboration.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import { CollaborationClientError } from "./collaborationErrors.js";
import type { ResolvedCollaborationCanvasBinding } from "./ContentVersionFacade.js";
import type { CanvasLiveSyncHandlers, CanvasLiveSyncStatus } from "./CanvasLiveSyncClient.js";
import type { CanvasLiveSyncServerMessage } from "@planweave-ai/collaboration-protocol/canvas/live-sync";

export type CollaborationCanvasLiveSyncClientPort = Pick<
  CollaborationClient,
  | "projectId"
  | "canvasCommandSession"
  | "liveSyncCanvas"
  | "liveSyncHelloRevision"
  | "liveSyncState"
  | "startLiveSync"
  | "stopLiveSync"
  | "subscribeLiveSync"
>;

export type CollaborationCanvasLiveSyncSessionHost = {
  getClient(): CollaborationCanvasLiveSyncClientPort | null;
  getClientProfileId(): string | null;
  resolveCanvasBinding(
    input: CollaborationCanvasBindingInput
  ): Promise<ResolvedCollaborationCanvasBinding | null>;
  publishCanvasLiveSyncSignal(signal: CollaborationCanvasLiveSyncSignal): void;
  clearDeviceCredential(profileId: string): Promise<void>;
  publishStatus(): Promise<unknown>;
};

function messageMatchesRemoteScope(
  message: CanvasLiveSyncServerMessage,
  remote: { projectId: string; canvasId: string }
): boolean {
  if (message.type === "canvas.live.accepted_entry") {
    return (
      message.entry.scope.projectId === remote.projectId &&
      message.entry.scope.canvasId === remote.canvasId
    );
  }
  if (message.type === "canvas.live.pong") return true;
  return message.projectId === remote.projectId && message.canvasId === remote.canvasId;
}

/**
 * Renderer-facing live-sync session: attaches scope-bound signal subscribers only.
 * Command-facade bind owns socket start and replica apply. Rebind/stop always unsubscribes.
 */
export class CollaborationCanvasLiveSyncSession {
  private scope: {
    remoteProjectId: string;
    remoteCanvasId: string;
  } | null = null;
  private generation = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly host: CollaborationCanvasLiveSyncSessionHost) {}

  reset(): void {
    this.detachSubscription();
    this.generation += 1;
    this.scope = null;
  }

  async start(input: unknown): Promise<void> {
    const parsed = collaborationCanvasBindingInputSchema.parse(input);
    const client = this.host.getClient();
    const profileId = this.host.getClientProfileId();
    if (!client || !profileId) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_session_not_connected",
        message: "Collaboration session is not connected."
      });
    }
    const resolved = await this.host.resolveCanvasBinding(parsed);
    const commandSession = client.canvasCommandSession();
    if (
      !resolved ||
      resolved.kind !== parsed.kind ||
      resolved.canvasId !== parsed.canvasId ||
      (resolved.kind === "local" &&
        parsed.kind === "local" &&
        resolved.localProjectId !== parsed.localProjectId) ||
      (resolved.kind === "remote" &&
        parsed.kind === "remote" &&
        (resolved.workspaceId !== parsed.workspaceId || resolved.projectId !== parsed.projectId)) ||
      resolved.remoteProjectId !== client.projectId ||
      !commandSession ||
      commandSession.canvasId !== resolved.remoteCanvasId
    ) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_canvas_live_sync_session_required",
        message: "The Canvas command session must be bound to the requested remote canvas.",
        retryable: false
      });
    }
    const nextScope = {
      remoteProjectId: resolved.remoteProjectId,
      remoteCanvasId: resolved.remoteCanvasId
    };

    // Drop any prior subscription before attaching the new scope (A → B rebind).
    this.detachSubscription();
    this.generation += 1;
    const generation = this.generation;
    this.scope = nextScope;

    const remote = {
      projectId: nextScope.remoteProjectId,
      canvasId: nextScope.remoteCanvasId
    };

    const isCurrent = () =>
      this.generation === generation &&
      this.scope?.remoteProjectId === remote.projectId &&
      this.scope.remoteCanvasId === remote.canvasId &&
      this.host.getClient() === client &&
      this.host.getClientProfileId() === profileId;

    const handlers: CanvasLiveSyncHandlers = {
      onMessage: (message) => {
        if (!isCurrent()) return;
        if (!messageMatchesRemoteScope(message, remote)) return;
        this.host.publishCanvasLiveSyncSignal({
          profileId,
          projectId: remote.projectId,
          canvasId: remote.canvasId,
          message
        });
      },
      onStatus: (status: CanvasLiveSyncStatus) => {
        if (!isCurrent()) return;
        if (status.state !== "auth_expired") return;
        this.detachSubscription();
        this.generation += 1;
        this.scope = null;
        void this.host.clearDeviceCredential(profileId).then(() => this.host.publishStatus());
      }
    };

    if (
      client.liveSyncCanvas() === nextScope.remoteCanvasId &&
      typeof client.subscribeLiveSync === "function"
    ) {
      this.unsubscribe = client.subscribeLiveSync(handlers);
      return;
    }

    if (typeof client.subscribeLiveSync === "function") {
      this.unsubscribe = client.subscribeLiveSync(handlers);
      client.startLiveSync(nextScope.remoteCanvasId, commandSession.revision);
      return;
    }

    client.startLiveSync(nextScope.remoteCanvasId, commandSession.revision, handlers);
  }

  stop(): void {
    this.detachSubscription();
    this.generation += 1;
    this.scope = null;
  }

  private detachSubscription(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
