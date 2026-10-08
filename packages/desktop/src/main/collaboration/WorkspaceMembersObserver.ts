import { WebSocket } from "ws";
import {
  workspaceMembersInvalidatedSchema,
  type WorkspaceConnectionProfile
} from "@planweave-ai/collaboration-protocol/connection";
import type { CollaborationCredentialPort } from "./collaborationClientTypes.js";
import { reconnectDelay } from "./reconnectBackoff.js";
import { derivedWebSocketOrigin } from "./webSocketOrigin.js";

/** One Workspace directory invalidation connection, independent of any Project session. */
export class WorkspaceMembersObserver {
  private socket: WebSocket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private generation = 0;
  private attempt = 0;
  constructor(
    private readonly options: {
      profile: WorkspaceConnectionProfile;
      credential: CollaborationCredentialPort;
      onInvalidated(): void;
      onError(code: string): void;
    }
  ) {}

  start() {
    void this.connect();
  }
  stop() {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.terminate();
  }
  private async connect() {
    if (this.stopped) return;
    const generation = ++this.generation;
    try {
      const token = await this.options.credential.getDeviceToken();
      if (this.stopped || generation !== this.generation) return;
      if (!token) {
        this.options.onError("workspace_members_credential_missing");
        return;
      }
      const url = new URL(
        "/api/v1/workspace-connection/members/observe",
        this.options.profile.serverBaseUrl
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: derivedWebSocketOrigin(this.options.profile.serverBaseUrl)
        },
        maxPayload: 1024
      });
      this.socket = socket;
      const current = () =>
        !this.stopped && generation === this.generation && this.socket === socket;
      let terminal = false;
      socket.on("unexpected-response", (_request, response) => {
        response.resume();
        if (!current()) return;
        terminal =
          response.statusCode === 401 || response.statusCode === 403 || response.statusCode === 404;
        this.options.onError(`workspace_members_http_${response.statusCode}`);
        this.socket = undefined;
        socket.terminate();
        if (!terminal) this.schedule();
      });
      socket.on("message", (bytes) => {
        if (!current()) return;
        try {
          const message = workspaceMembersInvalidatedSchema.parse(JSON.parse(bytes.toString()));
          if (message.workspaceId !== this.options.profile.workspaceId)
            throw new Error("workspace_members_scope_mismatch");
          this.attempt = 0;
          this.options.onInvalidated();
        } catch {
          this.options.onError("workspace_members_protocol_error");
          socket.close(4000, "protocol error");
        }
      });
      socket.on("error", () => {
        if (current()) this.options.onError("workspace_members_connection_failed");
      });
      socket.on("close", (code) => {
        if (!current()) return;
        this.socket = undefined;
        this.options.onError(
          code === 4001
            ? "workspace_members_authorization_expired"
            : "workspace_members_disconnected"
        );
        if (code !== 4001 && !terminal) this.schedule();
      });
    } catch {
      if (this.stopped || generation !== this.generation) return;
      this.options.onError("workspace_members_connection_failed");
      this.schedule();
    }
  }
  private schedule() {
    if (this.stopped || this.timer) return;
    const delay = reconnectDelay(++this.attempt, Math.random, {
      initialDelayMs: 250,
      maxDelayMs: 30_000
    });
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
  }
}
