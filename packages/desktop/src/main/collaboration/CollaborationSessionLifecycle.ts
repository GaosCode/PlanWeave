import { COLLABORATION_REQUEST_TIMEOUT_MS } from "@planweave-ai/collaboration-protocol/core/limits";
import type { CollaborationConnectionProfile } from "@planweave-ai/collaboration-protocol/connection";
import {
  assertNoSmuggledCollaborationSecrets,
  collaborationProfileIdInputSchema,
  type CollaborationObserverSignal,
  type CollaborationSessionPhase,
  type CollaborationStatus
} from "../../shared/collaboration.js";
import {
  type CollaborationClient,
  type CollaborationObserverStatus
} from "./CollaborationClient.js";
import type { CollaborationCanvasCommandFacade } from "./collaborationCanvasCommands.js";
import type { CollaborationCanvasLiveSyncSession } from "./collaborationCanvasLiveSyncSession.js";
import type { CollaborationCredentialVault } from "./collaborationCredentialVault.js";
import {
  COLLABORATION_CONNECTION_ERROR_CODES,
  collaborationConnectionErrorFromUnknown,
  collaborationErrorFromUnknown
} from "./collaborationErrors.js";
import type { CollaborationPresenceSession } from "./collaborationPresenceSession.js";
import type { CollaborationProfileStore } from "./collaborationProfileStore.js";

type CollaborationSessionLifecycleDependencies = {
  profiles: CollaborationProfileStore;
  vault: CollaborationCredentialVault;
  presenceSession: CollaborationPresenceSession;
  canvasLiveSyncSession: CollaborationCanvasLiveSyncSession;
  canvasCommands: CollaborationCanvasCommandFacade;
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  assertOpen(): void;
  getClient(): CollaborationClient | null;
  getClientProfileId(): string | null;
  setClient(client: CollaborationClient | null, profileId: string | null): void;
  getSessionPhase(): CollaborationSessionPhase;
  setSession(
    phase: CollaborationSessionPhase,
    detail?: string | null,
    error?: { code: string; message: string } | null
  ): void;
  clientForProfile(
    profileId: string,
    requireCredential: boolean
  ): Promise<{ client: CollaborationClient; profile: CollaborationConnectionProfile }>;
  publishStatus(): Promise<CollaborationStatus>;
  publishObserverSignal(signal: CollaborationObserverSignal): void;
};

function observerFailureMessage(code: string): string {
  if (code === "collaboration_observer_http_403") {
    return "Realtime updates are unavailable because this member does not have project read access. Ask an owner to share the project or grant this member project access.";
  }
  return code;
}

/** Owns authenticated client connection, observer continuity, and teardown. */
export class CollaborationSessionLifecycle {
  private observerStatus: CollaborationObserverStatus = { state: "stopped" };
  private lastValidatedObserverCursor = 0;
  private lastValidatedObserverProfileId: string | null = null;
  private observerGeneration = 0;
  private observerConnectDeadline: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly dependencies: CollaborationSessionLifecycleDependencies) {}

  getObserverStatus(): CollaborationObserverStatus {
    return this.observerStatus;
  }

  clearRememberedObserverCursor(profileId?: string | null): void {
    if (profileId == null || this.lastValidatedObserverProfileId === profileId) {
      this.lastValidatedObserverCursor = 0;
      this.lastValidatedObserverProfileId = null;
    }
  }

  async connect(input: unknown): Promise<CollaborationStatus> {
    return this.dependencies.enqueue(async () => {
      this.dependencies.assertOpen();
      assertNoSmuggledCollaborationSecrets(input, "connectCollaborationSession");
      const { profileId } = collaborationProfileIdInputSchema.parse(input);
      return this.connectWithinQueue(profileId);
    });
  }

  /** Caller must already hold the collaboration service queue. */
  async connectWithinQueue(
    profileId: string,
    options: { preserveCredentialOnAuthFailure?: boolean } = {}
  ): Promise<CollaborationStatus> {
    const activeClient = this.dependencies.getClient();
    if (
      this.dependencies.getClientProfileId() === profileId &&
      activeClient &&
      (this.dependencies.getSessionPhase() === "connecting" ||
        (this.dependencies.getSessionPhase() === "connected" &&
          this.observerStatus.state !== "failed" &&
          this.observerStatus.state !== "stopped"))
    ) {
      return this.dependencies.publishStatus();
    }
    await this.dispose("reconnect");
    const token = await this.dependencies.vault.getDeviceToken(profileId);
    if (!token) {
      throw new Error("Human device credential is not available for this profile.");
    }
    const { client, profile } = await this.dependencies.clientForProfile(profileId, true);
    this.dependencies.setClient(client, profileId);
    const observerGeneration = this.observerGeneration;
    const isCurrentObserver = () =>
      this.dependencies.getClient() === client &&
      this.dependencies.getClientProfileId() === profileId &&
      this.observerGeneration === observerGeneration;
    await this.dependencies.profiles.setActiveProfileId(profileId);
    this.observerStatus = { state: "stopped" };
    const resumeCursor =
      this.lastValidatedObserverProfileId === profileId ? this.lastValidatedObserverCursor : 0;
    let preflightComplete = false;
    try {
      this.dependencies.setSession("connecting", "http_preflight", null);
      await client.verifyAccess();
      preflightComplete = true;
      this.dependencies.setSession("connected", "http_ready", null);
      this.armObserverConnectDeadline({ client, profileId, observerGeneration });
      client.startObserver(
        {
          onStatus: (status) => {
            if (!isCurrentObserver()) return;
            this.observerStatus = status;
            if (status.state === "connected") {
              this.clearObserverConnectDeadline();
              this.rememberObserverCursor(profileId, status.cursor);
              this.dependencies.setSession("connected", `observer:${status.state}`, null);
              this.dependencies.publishObserverSignal({
                type: "human.observer.cursor",
                profileId,
                projectId: profile.projectId,
                cursor: status.cursor
              });
            } else if (status.state === "auth_expired") {
              this.clearObserverConnectDeadline();
              this.dependencies.setSession("error", `observer:${status.state}`, {
                code: COLLABORATION_CONNECTION_ERROR_CODES.workspaceUnauthorized,
                message: "Collaboration device credential was rejected by the server."
              });
              void this.dependencies.vault
                .clear(profileId)
                .then(() => this.dependencies.publishStatus());
            } else if (status.state === "failed") {
              this.clearObserverConnectDeadline();
              const workspaceForbidden = status.code === "collaboration_observer_http_403";
              this.dependencies.setSession("connected", `observer:${status.state}`, {
                code: workspaceForbidden
                  ? COLLABORATION_CONNECTION_ERROR_CODES.workspaceForbidden
                  : status.code,
                message: observerFailureMessage(status.code)
              });
            } else if (status.state === "reconnecting" || status.state === "connecting") {
              if (status.state === "reconnecting" && this.observerConnectDeadline === null) {
                this.armObserverConnectDeadline({ client, profileId, observerGeneration });
              }
              this.dependencies.setSession("connected", `observer:${status.state}`);
            } else if (status.state === "catching_up") {
              this.clearObserverConnectDeadline();
              this.rememberObserverCursor(profileId, status.resumeCursor);
              this.dependencies.setSession("connected", `observer:${status.state}`);
            }
            void this.dependencies.publishStatus();
          },
          onEvent: (message) => {
            if (!isCurrentObserver()) return;
            this.rememberObserverCursor(profileId, message.cursor);
            this.dependencies.publishObserverSignal({
              type: "human.observer.event",
              profileId,
              projectId: profile.projectId,
              event: message
            });
          },
          onCatchupRequired: (message) => {
            if (!isCurrentObserver()) return;
            this.rememberObserverCursor(profileId, message.resumeCursor);
            this.dependencies.publishObserverSignal({
              type: "human.observer.catchup_required",
              profileId,
              projectId: profile.projectId,
              reason: message.reason,
              resumeCursor: message.resumeCursor,
              droppedThroughCursor: message.droppedThroughCursor
            });
          }
        },
        { cursor: resumeCursor }
      );
    } catch (error) {
      const mapped = collaborationConnectionErrorFromUnknown(error, profile.endpoint.topology);
      await this.dispose("connect_failed");
      if (
        !preflightComplete &&
        mapped.kind === "auth" &&
        options.preserveCredentialOnAuthFailure !== true
      ) {
        await this.dependencies.vault.clear(profileId);
      }
      this.dependencies.setSession(
        "error",
        preflightComplete ? "connect_failed" : "connect_preflight_failed",
        { code: mapped.code, message: mapped.message }
      );
      await this.dependencies.publishStatus();
      throw mapped;
    }
    return this.dependencies.publishStatus();
  }

  async disconnect(): Promise<CollaborationStatus> {
    return this.dependencies.enqueue(async () => {
      this.dependencies.assertOpen();
      return this.disconnectWithinQueue();
    });
  }

  /** Caller must already hold the collaboration service queue. */
  async disconnectWithinQueue(): Promise<CollaborationStatus> {
    await this.dispose("disconnect");
    this.dependencies.setSession("idle", null, null);
    return this.dependencies.publishStatus();
  }

  async dispose(reason: string): Promise<void> {
    this.clearObserverConnectDeadline();
    const client = this.dependencies.getClient();
    const profileId = this.dependencies.getClientProfileId();
    this.observerGeneration += 1;
    this.dependencies.presenceSession.reset();
    this.dependencies.canvasLiveSyncSession.reset();
    try {
      await this.dependencies.canvasCommands.flushMaterialization();
    } catch (error) {
      const mapped = collaborationErrorFromUnknown(error);
      this.dependencies.setSession("error", "canvas_replica_persistence_failed", {
        code: mapped.code,
        message: mapped.message
      });
    }
    this.dependencies.canvasCommands.clearAllSessions();
    if (client && profileId) {
      try {
        this.rememberObserverCursor(profileId, client.lastObserverCursor());
      } catch {
        // The observer may close between cursor read and client teardown.
      }
    }
    this.dependencies.setClient(null, null);
    this.observerStatus = { state: "stopped" };
    this.dependencies.setSession("idle", reason, null);
    if (client) {
      try {
        client.stopPresence();
      } catch {
        // Teardown is best-effort after the client has been detached.
      }
      try {
        client.stopLiveSync();
      } catch {
        // Teardown is best-effort after the client has been detached.
      }
      try {
        client.stopObserver();
      } catch {
        // Teardown is best-effort after the client has been detached.
      }
      try {
        client.dispose();
      } catch {
        // Teardown is best-effort after the client has been detached.
      }
    }
    if (reason === "logout" || reason === "profile_removed" || reason === "shutdown") {
      this.clearRememberedObserverCursor(profileId);
    }
  }

  private rememberObserverCursor(profileId: string, cursor: number): void {
    if (!Number.isFinite(cursor) || cursor < 0) return;
    if (this.lastValidatedObserverProfileId !== profileId) {
      this.lastValidatedObserverProfileId = profileId;
      this.lastValidatedObserverCursor = cursor;
      return;
    }
    if (cursor > this.lastValidatedObserverCursor) {
      this.lastValidatedObserverCursor = cursor;
    }
  }

  private clearObserverConnectDeadline(): void {
    if (this.observerConnectDeadline === null) return;
    clearTimeout(this.observerConnectDeadline);
    this.observerConnectDeadline = null;
  }

  private armObserverConnectDeadline(input: {
    client: CollaborationClient;
    profileId: string;
    observerGeneration: number;
  }): void {
    this.clearObserverConnectDeadline();
    const deadline = setTimeout(() => {
      this.observerConnectDeadline = null;
      void this.dependencies.enqueue(async () => {
        const isCurrentObserver =
          this.dependencies.getClient() === input.client &&
          this.dependencies.getClientProfileId() === input.profileId &&
          this.observerGeneration === input.observerGeneration;
        if (
          !isCurrentObserver ||
          (this.observerStatus.state !== "connecting" &&
            this.observerStatus.state !== "reconnecting")
        ) {
          return;
        }
        input.client.stopObserver();
        this.observerStatus = { state: "stopped" };
        this.dependencies.setSession("connected", "observer:connect_timeout", {
          code: "collaboration_observer_connect_timeout",
          message:
            "Authenticated HTTP access is available, but realtime WebSocket updates did not connect before the deadline."
        });
        await this.dependencies.publishStatus();
      });
    }, COLLABORATION_REQUEST_TIMEOUT_MS);
    deadline.unref?.();
    this.observerConnectDeadline = deadline;
  }
}
