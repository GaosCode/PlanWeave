import type {
  CanvasPresenceError,
  CanvasPresenceLeave,
  CanvasPresenceSnapshot,
  CanvasPresenceUpdate
} from "@planweave-ai/collaboration-protocol/canvas/presence";
import type {
  HumanObserverCursor,
  HumanObserverServerMessage
} from "@planweave-ai/collaboration-protocol/activity/observer";

/** Returns the current human device bearer (`pw_hdev_…`) or undefined when unauthenticated. */
export type CollaborationCredentialPort = {
  getDeviceToken(): string | undefined | Promise<string | undefined>;
};

export type CollaborationClientClock = {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
};

export type CollaborationObserverStatus =
  | { readonly state: "stopped" }
  | { readonly state: "connecting"; readonly attempt: number }
  | {
      readonly state: "connected";
      readonly cursor: HumanObserverCursor;
      readonly connectedAt: string;
    }
  | { readonly state: "catching_up"; readonly resumeCursor: HumanObserverCursor }
  | { readonly state: "reconnecting"; readonly attempt: number; readonly delayMs: number }
  | { readonly state: "auth_expired"; readonly code: string }
  | { readonly state: "failed"; readonly code: string };

export type CollaborationObserverHandlers = {
  onEvent?(message: Extract<HumanObserverServerMessage, { type: "human.observer.event" }>): void;
  onCatchupRequired?(
    message: Extract<HumanObserverServerMessage, { type: "human.observer.catchup_required" }>
  ): void;
  onAuthExpired?(
    message: Extract<HumanObserverServerMessage, { type: "human.observer.auth_expired" }>
  ): void;
  onStatus?(status: CollaborationObserverStatus): void;
};

export type CollaborationPresenceStatus =
  | { readonly state: "stopped" }
  | { readonly state: "connecting"; readonly canvasId: string; readonly attempt: number }
  | { readonly state: "connected"; readonly canvasId: string }
  | {
      readonly state: "reconnecting";
      readonly canvasId: string;
      readonly attempt: number;
      readonly delayMs: number;
    }
  | { readonly state: "auth_expired"; readonly canvasId: string; readonly code: string }
  | { readonly state: "error"; readonly canvasId: string; readonly code: string };

export type CollaborationPresenceHandlers = {
  onSnapshot?(message: CanvasPresenceSnapshot): void;
  onUpdate?(message: CanvasPresenceUpdate): void;
  onLeave?(message: CanvasPresenceLeave): void;
  onError?(message: CanvasPresenceError): void;
  onStatus?(status: CollaborationPresenceStatus): void;
};

export type CollaborationWebSocketLike = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on?(
    type: "unexpected-response",
    listener: (
      request: unknown,
      response: { readonly statusCode?: number; resume?(): void }
    ) => void
  ): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: unknown) => void
  ): void;
  removeEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: unknown) => void
  ): void;
};

export type CollaborationWebSocketConstructor = new (
  url: string,
  protocolsOrOptions?: string | string[] | { headers?: Record<string, string> }
) => CollaborationWebSocketLike;

export const systemCollaborationClock: CollaborationClientClock = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};
