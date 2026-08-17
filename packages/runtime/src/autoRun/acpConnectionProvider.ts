import { z } from "zod";
import type {
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeResponse,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionConfigOptionResponse,
  SetSessionModeResponse
} from "@agentclientprotocol/sdk";
import type {
  AcpConnection,
  AcpOperationOptions,
  CreateAcpConnectionOptions
} from "./acpConnection.js";
import type { AcpCleanupDeadline } from "./acpExecutionCleanup.js";
import {
  acpEngineSessionStartSchema,
  type AcpEngineSessionStart
} from "./acpExecutionEngineContracts.js";
import type { LivePendingOperationHandle } from "./liveControl.js";

export type AcpConnectionAcquireRequest = CreateAcpConnectionOptions;

export const acpLeaseTerminalSchema = z.enum(["succeeded", "failed", "cancelled"]);
export type AcpLeaseTerminal = z.infer<typeof acpLeaseTerminalSchema>;

export const acpLeaseReleaseInputSchema = z
  .object({
    terminal: acpLeaseTerminalSchema,
    cleanupDeadline: z
      .object({
        expiresAt: z.number().finite(),
        remainingMs: z.custom<(this: AcpCleanupDeadline) => number>(
          (value) => typeof value === "function",
          { message: "ACP lease release requires a cleanup deadline." }
        )
      })
      .readonly()
  })
  .strict();
export type AcpLeaseReleaseInput = {
  readonly terminal: AcpLeaseTerminal;
  readonly cleanupDeadline: AcpCleanupDeadline;
};

export const acpLeaseReleaseResultSchema = z
  .object({
    closedSession: z.boolean(),
    disposed: z.boolean(),
    failures: z.array(z.unknown()).readonly()
  })
  .strict();
export type AcpLeaseReleaseResult = z.infer<typeof acpLeaseReleaseResultSchema>;

export const acpOwnedSessionOpenSchema = acpEngineSessionStartSchema;
export type AcpOwnedSessionStart = AcpEngineSessionStart;

export type AcpOwnedSessionOpenOptions = AcpOperationOptions & {
  readonly cwd?: string;
};

export type AcpOwnedSessionConfigInput = {
  readonly configId: string;
  readonly value: string | boolean;
};

export class AcpLeaseReleasedError extends Error {
  constructor(operation: string) {
    super(`ACP ${operation} is not available after lease release.`);
    this.name = "AcpLeaseReleasedError";
  }
}

export type AcpLeaseAdvertisedCapabilities = {
  readonly loadSession: boolean;
  readonly closeSession: boolean;
};

export type AcpOwnedSession = {
  readonly sessionId: string;
  readonly created: NewSessionResponse;
  prompt(prompt: PromptRequest["prompt"], options?: AcpOperationOptions): Promise<PromptResponse>;
  cancel(options?: AcpOperationOptions): Promise<void>;
  close(options?: AcpOperationOptions): Promise<void>;
  setMode(modeId: string, options?: AcpOperationOptions): Promise<SetSessionModeResponse>;
  setConfigOption(
    input: AcpOwnedSessionConfigInput,
    options?: AcpOperationOptions
  ): Promise<SetSessionConfigOptionResponse>;
};

export type AcpConnectionLease = {
  readonly processId: number | null;
  readonly pendingOperationCount: number;
  readonly pendingOperations: ReadonlyMap<string, LivePendingOperationHandle>;
  readonly stderr: readonly string[];
  readonly closed: Promise<void>;
  readonly terminalFailure?: Error | null;
  readonly advertised: AcpLeaseAdvertisedCapabilities;
  initialize(options?: AcpOperationOptions): Promise<InitializeResponse>;
  authenticate(
    request: AuthenticateRequest,
    options?: AcpOperationOptions
  ): Promise<AuthenticateResponse>;
  openSession(
    start: AcpOwnedSessionStart,
    options?: AcpOwnedSessionOpenOptions
  ): Promise<AcpOwnedSession>;
  cancel(notification: CancelNotification, options?: AcpOperationOptions): Promise<void>;
  release(input: AcpLeaseReleaseInput): Promise<AcpLeaseReleaseResult>;
};

export type AcpConnectionProvider = {
  acquire(request: AcpConnectionAcquireRequest): Promise<AcpConnectionLease>;
  shutdown(): Promise<void>;
};

export type AcpLiveRunTransport = Pick<
  AcpConnection,
  "processId" | "pendingOperationCount" | "pendingOperations" | "cancel"
>;
