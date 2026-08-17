import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse
} from "@agentclientprotocol/sdk";
import type { AcpSessionHandlerPort } from "./acpConnectionProvider.js";

export class AcpSessionRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpSessionRoutingError";
  }
}

type OpeningOwner = {
  readonly ownerId: string;
  readonly handlers: AcpSessionHandlerPort;
};

type BoundSession = {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly handlers: AcpSessionHandlerPort;
};

type PendingPermission = {
  readonly request: RequestPermissionRequest;
  resolve(value: RequestPermissionResponse): void;
  reject(error: Error): void;
};

type PendingElicitation = {
  readonly request: CreateElicitationRequest;
  resolve(value: CreateElicitationResponse): void;
  reject(error: Error): void;
};

type PendingTerminal = {
  readonly request: TerminalOutputRequest;
  resolve(value: TerminalOutputResponse): void;
  reject(error: Error): void;
};

type OpeningBuffer = {
  readonly updates: SessionNotification[];
  readonly permissions: PendingPermission[];
  readonly elicitations: PendingElicitation[];
  readonly terminals: PendingTerminal[];
};

const cancelledPermission = (): RequestPermissionResponse => ({
  outcome: { outcome: "cancelled" }
});
const cancelledElicitation = (): CreateElicitationResponse => ({ action: "cancel" });
const emptyTerminalOutput = (): TerminalOutputResponse => ({ output: "", truncated: false });

function elicitationSessionId(request: CreateElicitationRequest): string | null {
  return "sessionId" in request && typeof request.sessionId === "string" ? request.sessionId : null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class AcpSessionRouter {
  private openingOwner: OpeningOwner | null = null;
  private openChain: Promise<void> = Promise.resolve();
  private readonly bindings = new Map<string, BoundSession>();
  private readonly ownerSessions = new Map<string, string>();
  private readonly openingBuffers = new Map<string, OpeningBuffer>();
  private readonly promptFlights = new Map<string, Promise<unknown>>();

  async withOpening<T extends { readonly sessionId: string }>(
    ownerId: string,
    handlers: AcpSessionHandlerPort,
    open: () => Promise<T>
  ): Promise<T> {
    if (this.ownerSessions.has(ownerId) || this.openingOwner?.ownerId === ownerId) {
      throw new AcpSessionRoutingError("ACP shared session owner is already opening or bound.");
    }
    const run = this.openChain.then(() => this.runOpen(ownerId, handlers, open));
    this.openChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  unbindOwner(ownerId: string): void {
    const sessionId = this.ownerSessions.get(ownerId);
    if (sessionId) {
      this.bindings.delete(sessionId);
      this.failClosedBuffer(this.openingBuffers.get(sessionId));
      this.openingBuffers.delete(sessionId);
      this.promptFlights.delete(sessionId);
    }
    this.ownerSessions.delete(ownerId);
    if (this.openingOwner?.ownerId === ownerId) this.openingOwner = null;
  }

  sessionUpdate(notification: SessionNotification): Promise<void> {
    const bound = this.bindings.get(notification.sessionId);
    if (bound) {
      return Promise.resolve(bound.handlers.onSessionUpdate?.(notification)).then(() => undefined);
    }
    if (this.openingOwner) {
      this.bufferFor(notification.sessionId).updates.push(notification);
      return Promise.resolve();
    }
    return Promise.resolve();
  }

  permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const bound = this.bindings.get(request.sessionId);
    if (bound?.handlers.onPermissionRequest) {
      return Promise.resolve(bound.handlers.onPermissionRequest(request));
    }
    if (this.openingOwner) {
      return new Promise((resolve, reject) => {
        this.bufferFor(request.sessionId).permissions.push({ request, resolve, reject });
      });
    }
    return Promise.resolve(cancelledPermission());
  }

  elicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const sessionId = elicitationSessionId(request);
    if (sessionId) {
      const bound = this.bindings.get(sessionId);
      if (bound?.handlers.onElicitationRequest) {
        return Promise.resolve(bound.handlers.onElicitationRequest(request));
      }
      if (this.openingOwner) {
        return new Promise((resolve, reject) => {
          this.bufferFor(sessionId).elicitations.push({ request, resolve, reject });
        });
      }
      return Promise.resolve(cancelledElicitation());
    }
    if (this.openingOwner?.handlers.onElicitationRequest) {
      return Promise.resolve(this.openingOwner.handlers.onElicitationRequest(request));
    }
    return Promise.resolve(cancelledElicitation());
  }

  terminalOutput(request: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const bound = this.bindings.get(request.sessionId);
    if (bound?.handlers.onTerminalOutput) {
      return Promise.resolve(bound.handlers.onTerminalOutput(request));
    }
    if (this.openingOwner) {
      return new Promise((resolve, reject) => {
        this.bufferFor(request.sessionId).terminals.push({ request, resolve, reject });
      });
    }
    return Promise.resolve(emptyTerminalOutput());
  }

  async runPrompt<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.promptFlights.get(sessionId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.promptFlights.set(sessionId, next);
    try {
      return await next;
    } finally {
      if (this.promptFlights.get(sessionId) === next) this.promptFlights.delete(sessionId);
    }
  }

  private async runOpen<T extends { readonly sessionId: string }>(
    ownerId: string,
    handlers: AcpSessionHandlerPort,
    open: () => Promise<T>
  ): Promise<T> {
    if (this.openingOwner) {
      throw new AcpSessionRoutingError("ACP shared connection already has an opening owner.");
    }
    this.openingOwner = { ownerId, handlers };
    try {
      const created = await open();
      this.bindSession(ownerId, created.sessionId, handlers);
      await this.flushBuffer(created.sessionId);
      this.dropUnmatchedBuffers();
      return created;
    } catch (error) {
      this.dropUnmatchedBuffers();
      throw error;
    } finally {
      if (this.openingOwner?.ownerId === ownerId) this.openingOwner = null;
    }
  }

  private bindSession(ownerId: string, sessionId: string, handlers: AcpSessionHandlerPort): void {
    if (this.bindings.has(sessionId)) {
      throw new AcpSessionRoutingError("ACP shared session id is already bound.");
    }
    this.bindings.set(sessionId, { ownerId, sessionId, handlers });
    this.ownerSessions.set(ownerId, sessionId);
  }

  private bufferFor(sessionId: string): OpeningBuffer {
    const existing = this.openingBuffers.get(sessionId);
    if (existing) return existing;
    const created: OpeningBuffer = {
      updates: [],
      permissions: [],
      elicitations: [],
      terminals: []
    };
    this.openingBuffers.set(sessionId, created);
    return created;
  }

  private async flushBuffer(sessionId: string): Promise<void> {
    const buffered = this.openingBuffers.get(sessionId);
    this.openingBuffers.delete(sessionId);
    if (!buffered) return;
    const bound = this.bindings.get(sessionId);
    for (const notification of buffered.updates) {
      await bound?.handlers.onSessionUpdate?.(notification);
    }
    for (const item of buffered.permissions) {
      try {
        const response = bound?.handlers.onPermissionRequest
          ? await bound.handlers.onPermissionRequest(item.request)
          : cancelledPermission();
        item.resolve(response);
      } catch (error) {
        item.reject(asError(error));
      }
    }
    for (const item of buffered.elicitations) {
      try {
        const response = bound?.handlers.onElicitationRequest
          ? await bound.handlers.onElicitationRequest(item.request)
          : cancelledElicitation();
        item.resolve(response);
      } catch (error) {
        item.reject(asError(error));
      }
    }
    for (const item of buffered.terminals) {
      try {
        const response = bound?.handlers.onTerminalOutput
          ? await bound.handlers.onTerminalOutput(item.request)
          : emptyTerminalOutput();
        item.resolve(response);
      } catch (error) {
        item.reject(asError(error));
      }
    }
  }

  private dropUnmatchedBuffers(): void {
    for (const [sessionId, buffered] of this.openingBuffers) {
      this.openingBuffers.delete(sessionId);
      this.failClosedBuffer(buffered);
    }
  }

  private failClosedBuffer(buffered: OpeningBuffer | undefined): void {
    if (!buffered) return;
    for (const item of buffered.permissions) item.resolve(cancelledPermission());
    for (const item of buffered.elicitations) item.resolve(cancelledElicitation());
    for (const item of buffered.terminals) item.resolve(emptyTerminalOutput());
  }
}
