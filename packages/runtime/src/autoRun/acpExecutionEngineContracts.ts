import type {
  AgentCapabilities,
  CreateElicitationResponse,
  NewSessionResponse,
  SessionConfigOption
} from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { AcpAuthenticationHints, AcpAuthenticationOutcome } from "./acpAuthentication.js";
import type {
  AcpConnection,
  CreateAcpConnectionOptions,
  TrustedAcpLaunch
} from "./acpConnection.js";
import type { AcpNormalizedEventBody } from "./acpEventNormalization.js";
import type { AcpShutdownPolicy } from "../acpProfile/schema.js";
import type { AcpCapabilityPolicy } from "../acpProfile/schema.js";
import type { AcpCapabilitySnapshot } from "./acpCapabilityGate.js";

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const acpExecutionLimitsSchema = z
  .object({
    operationTimeoutMs: positiveSafeInteger,
    interactionTimeoutMs: positiveSafeInteger,
    promptMaxBytes: positiveSafeInteger,
    eventMaxBytes: positiveSafeInteger,
    outputMaxBytes: positiveSafeInteger,
    inboundMessageMaxBytes: positiveSafeInteger,
    stderrMaxBytes: positiveSafeInteger
  })
  .strict();
export type AcpExecutionLimits = z.infer<typeof acpExecutionLimitsSchema>;

export const DEFAULT_ACP_EXECUTION_LIMITS: AcpExecutionLimits = {
  operationTimeoutMs: 30_000,
  interactionTimeoutMs: 30_000,
  promptMaxBytes: 1_048_576,
  eventMaxBytes: 1_048_576,
  outputMaxBytes: 8_388_608,
  inboundMessageMaxBytes: 1_048_576,
  stderrMaxBytes: 1_048_576
};

export const acpEngineSessionStartSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new") }).strict(),
  z.object({ kind: z.literal("load"), sessionId: z.string().min(1).max(1024) }).strict()
]);
export type AcpEngineSessionStart = z.infer<typeof acpEngineSessionStartSchema>;

export type AcpPreparedWorkspace = { readonly cwd: string };

export type AcpEngineClock = {
  now(): Date;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
};

export type AcpEnginePermissionOption = {
  readonly optionId: string;
  readonly label: string;
  readonly decision: "approve" | "deny";
};

export type AcpEnginePermissionRequest = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly summary: string;
  readonly options: readonly AcpEnginePermissionOption[];
};

export type AcpEngineElicitationRequest = {
  readonly requestId: string;
  readonly sessionId: string | null;
  readonly message: string;
  readonly requestedSchema: unknown;
};

export type AcpEngineInteractionContext = {
  readonly signal: AbortSignal;
  readonly deadline: Date;
};

export type AcpEnginePermissionDecision =
  | { readonly kind: "select"; readonly optionId: string }
  | { readonly kind: "cancel" };

export type AcpEngineInteractionBroker = {
  readonly advertiseElicitation?: boolean;
  requestPermission(
    request: AcpEnginePermissionRequest,
    context: AcpEngineInteractionContext
  ): Promise<AcpEnginePermissionDecision> | AcpEnginePermissionDecision;
  requestElicitation(
    request: AcpEngineElicitationRequest,
    context: AcpEngineInteractionContext
  ): Promise<CreateElicitationResponse> | CreateElicitationResponse;
};

export type AcpEngineAuthenticationRequiredPolicy = "fail" | "probe_session";

export type AcpEngineSessionConfigurator = {
  setMode(modeId: string): Promise<void>;
  setConfigOption(input: {
    readonly configId: string;
    readonly value: string | boolean;
  }): Promise<readonly SessionConfigOption[]>;
};

export type AcpEngineLifecycleEvent =
  | { readonly kind: "connection_ready"; readonly processId: number | null }
  | { readonly kind: "initialized"; readonly agentCapabilities: AgentCapabilities | undefined }
  | { readonly kind: "capability_gated"; readonly snapshot: AcpCapabilitySnapshot }
  | {
      readonly kind: "authentication_completed";
      readonly authentication: AcpAuthenticationOutcome;
    }
  | { readonly kind: "authentication_probe"; readonly state: "starting" | "failed" | "succeeded" }
  | {
      readonly kind: "session_ready";
      readonly loaded: boolean;
      readonly session: NewSessionResponse;
      readonly configurator: AcpEngineSessionConfigurator;
    }
  | {
      readonly kind: "prompt_starting";
      readonly sessionId: string;
      readonly turn: number;
      readonly followUp: boolean;
      readonly prompt: string;
    }
  | {
      readonly kind: "prompt_completed";
      readonly sessionId: string;
      readonly turn: number;
      readonly followUp: boolean;
      readonly stopReason: string;
    }
  | {
      readonly kind: "prompts_completed";
      readonly sessionId: string;
      readonly turns: number;
      readonly output: string;
    }
  | { readonly kind: "cleanup_starting"; readonly terminal: AcpEngineTerminal }
  | {
      readonly kind: "cleanup_completed";
      readonly cleanup: { readonly attempted: true; readonly completed: boolean };
    };

export type AcpEngineLifecycleObserver = (event: AcpEngineLifecycleEvent) => void | Promise<void>;

export type AcpEnginePromptSource = AsyncIterable<string>;

export type AcpEngineCapabilities = {
  readonly loadSession: boolean;
  readonly closeSession: boolean;
  readonly prompt: {
    readonly image: boolean;
    readonly audio: boolean;
    readonly embeddedContext: boolean;
  };
  readonly mcp: { readonly http: boolean; readonly sse: boolean };
  readonly client: { readonly permission: true; readonly elicitation: boolean };
};

export type AcpEngineUsage = {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thoughtTokens: number | null;
  readonly cachedReadTokens: number | null;
  readonly cachedWriteTokens: number | null;
};

type AcpEngineEventBase = { readonly sequence: number; readonly timestamp: string };

export type AcpEngineEventPayload =
  | { readonly kind: "lifecycle"; readonly state: "connecting" | "running" | "cleanup" }
  | { readonly kind: "capability_snapshot"; readonly snapshot: AcpCapabilitySnapshot }
  | { readonly kind: "capabilities"; readonly capabilities: AcpEngineCapabilities }
  | { readonly kind: "session_started"; readonly sessionId: string; readonly loaded: boolean }
  | {
      readonly kind: "session_update";
      readonly sessionId: string;
      readonly body: AcpNormalizedEventBody;
    }
  | { readonly kind: "usage"; readonly usage: AcpEngineUsage }
  | {
      readonly kind: "interaction";
      readonly requestId: string;
      readonly interaction: "permission" | "elicitation";
      readonly state: "requested" | "resolved";
      readonly outcome?: "selected" | "cancelled" | "accepted" | "declined";
    }
  | { readonly kind: "terminal"; readonly terminal: AcpEngineTerminal };

export type AcpEngineEvent = AcpEngineEventBase & AcpEngineEventPayload;

export type AcpEngineEventSink = (event: AcpEngineEvent) => void | Promise<void>;

export type AcpEngineFailureReason =
  | "authentication_required"
  | "capability_missing"
  | "interaction_failed"
  | "interaction_timeout"
  | "limit_exceeded"
  | "operation_timeout"
  | "process_error"
  | "protocol_error"
  | "event_sink_failed"
  | "incomplete_response"
  | "cleanup_failed"
  | "unknown_error";

export type AcpEngineTerminal =
  | { readonly state: "succeeded"; readonly stopReason: string }
  | { readonly state: "cancelled"; readonly message: string }
  | { readonly state: "failed"; readonly reason: AcpEngineFailureReason; readonly message: string };

export type AcpEngineResult = {
  readonly sessionId: string | null;
  readonly output: string;
  readonly stderr: readonly string[];
  readonly capabilities: AcpEngineCapabilities | null;
  readonly capabilitySnapshot: AcpCapabilitySnapshot | null;
  readonly authentication: AcpAuthenticationOutcome | null;
  readonly usage: AcpEngineUsage | null;
  readonly terminal: AcpEngineTerminal;
  readonly cleanup: { readonly attempted: boolean; readonly completed: boolean };
};

export type AcpEngineConnectionFactory = (options: CreateAcpConnectionOptions) => AcpConnection;

export type ExecuteAcpOptions = {
  readonly launch: TrustedAcpLaunch;
  readonly workspace: AcpPreparedWorkspace;
  readonly env: Readonly<Record<string, string>>;
  readonly clientInfo: { readonly name: string; readonly version: string };
  readonly shutdown: AcpShutdownPolicy;
  readonly capabilityPolicy: AcpCapabilityPolicy;
  readonly prompt: string;
  readonly sessionStart: AcpEngineSessionStart;
  readonly sessionLoadUnsupportedMessage?: string;
  readonly authentication?: {
    readonly hints?: AcpAuthenticationHints;
    readonly availableEnvironmentVariables?: ReadonlySet<string>;
    readonly requiredPolicy?: AcpEngineAuthenticationRequiredPolicy;
  };
  readonly interactionBroker?: AcpEngineInteractionBroker;
  readonly interactionDeadline?: () => Date | null;
  readonly followUpPrompts?: AcpEnginePromptSource;
  readonly lifecycleObserver?: AcpEngineLifecycleObserver;
  readonly eventSink?: AcpEngineEventSink;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<AcpExecutionLimits>;
  readonly clock?: AcpEngineClock;
  readonly connect?: AcpEngineConnectionFactory;
};
