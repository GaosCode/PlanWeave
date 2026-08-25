import {
  collaborationPresenceCanvasInputSchema,
  collaborationPresenceUpdateInputSchema,
  type CollaborationPresenceSignal
} from "../../shared/collaboration.js";
import type { CollaborationClient, CollaborationPresenceStatus } from "./CollaborationClient.js";
import { CollaborationClientError } from "./collaborationErrors.js";

export type CollaborationPresenceSessionHost = {
  getClient(): CollaborationClient | null;
  getClientProfileId(): string | null;
  publishPresenceSignal(signal: CollaborationPresenceSignal): void;
  setSessionError(detail: string, error: { code: string; message: string }): void;
  clearDeviceCredential(profileId: string): Promise<void>;
  publishStatus(): Promise<unknown>;
};

/**
 * Ephemeral canvas presence session state for CollaborationService.
 * Independent from durable canvas command revision tracking.
 *
 * Does not cache or re-play local pointer/selection after reconnect — that
 * responsibility lives solely in the renderer CanvasPresenceController so
 * offline edits while disconnected are not overwritten by a stale main-process
 * copy.
 */
export class CollaborationPresenceSession {
  private presenceCanvasId: string | null = null;
  private presenceGeneration = 0;

  constructor(private readonly host: CollaborationPresenceSessionHost) {}

  reset(): void {
    this.presenceGeneration += 1;
    this.presenceCanvasId = null;
  }

  canvasId(): string | null {
    return this.presenceCanvasId;
  }

  async start(input: unknown): Promise<void> {
    const { canvasId } = collaborationPresenceCanvasInputSchema.parse(input);
    const client = this.host.getClient();
    const profileId = this.host.getClientProfileId();
    if (!client || !profileId) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_session_not_connected",
        message: "Collaboration session is not connected."
      });
    }
    if (this.presenceCanvasId === canvasId && client.presenceCanvas() === canvasId) return;
    this.presenceGeneration += 1;
    const generation = this.presenceGeneration;
    this.presenceCanvasId = canvasId;
    const isCurrent = () =>
      this.host.getClient() === client &&
      this.host.getClientProfileId() === profileId &&
      this.presenceCanvasId === canvasId &&
      this.presenceGeneration === generation;
    client.startPresence(canvasId, {
      onSnapshot: (message) => {
        if (!isCurrent()) return;
        this.host.publishPresenceSignal({ profileId, message });
      },
      onUpdate: (message) => {
        if (!isCurrent()) return;
        this.host.publishPresenceSignal({ profileId, message });
      },
      onLeave: (message) => {
        if (!isCurrent()) return;
        this.host.publishPresenceSignal({ profileId, message });
      },
      onError: (message) => {
        if (!isCurrent()) return;
        this.host.publishPresenceSignal({ profileId, message });
      },
      onStatus: (status: CollaborationPresenceStatus) => {
        if (!isCurrent()) return;
        if (status.state === "reconnecting") {
          this.host.publishPresenceSignal({
            profileId,
            reset: { canvasId, reason: "disconnected" }
          });
        } else if (status.state === "auth_expired") {
          this.host.publishPresenceSignal({
            profileId,
            reset: { canvasId, reason: "auth_expired" }
          });
        } else if (status.state === "error") {
          this.host.publishPresenceSignal({ profileId, reset: { canvasId, reason: "error" } });
        }
        if (status.state === "auth_expired") {
          this.presenceCanvasId = null;
          this.presenceGeneration += 1;
          try {
            client.stopPresence();
          } catch {
            // ignore close races during auth invalidation
          }
          this.host.setSessionError("presence:auth_expired", {
            code: status.code,
            message: "Collaboration device credential was rejected by the server."
          });
          void this.host.clearDeviceCredential(profileId).then(() => this.host.publishStatus());
        }
      }
    });
  }

  async stop(): Promise<void> {
    this.presenceGeneration += 1;
    this.presenceCanvasId = null;
    try {
      this.host.getClient()?.stopPresence();
    } catch {
      // ignore close races during scope teardown
    }
  }

  async publish(input: unknown): Promise<void> {
    const parsed = collaborationPresenceUpdateInputSchema.parse(input);
    const client = this.host.getClient();
    if (!client || !this.host.getClientProfileId() || !this.presenceCanvasId) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_presence_not_connected",
        message: "Canvas presence is not connected."
      });
    }
    client.publishPresence(parsed);
  }
}
