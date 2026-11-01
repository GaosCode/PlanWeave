import type { HostReadinessObservation } from "@planweave-ai/agent-host-protocol";
import type { RemoteAcpConversationService } from "../execution/remoteAcpConversationService.js";
import type { HostCredentialRenewalPort } from "../credentials/credentialRenewal.js";
import type { AgentHostExecutor } from "../execution/agentHostExecutor.js";
import type { DurableAcpInteractionRelay } from "../execution/durableAcpRelay.js";
import type { AgentHostStateRepository } from "../state/agentHostState.js";
import type { CanvasRuntimeService } from "../runtime/canvasRuntimeService.js";
import type { ServerEvent } from "../protocol.js";
import type { ReconnectBackoffOptions } from "./reconnectBackoff.js";
import type { CalibratedServerClock } from "./calibratedServerClock.js";
import type {
  HostTransportClock,
  HostTransportLimits,
  HostTransportLogger
} from "./hostTransport.js";

export type AgentHostClientOptions = {
  serverUrl: string;
  hostId: string;
  workspaceId?: string;
  token: string;
  credentialRenewal?: HostCredentialRenewalPort;
  capabilities: readonly string[];
  capacity: number;
  readiness: HostReadinessObservation;
  state: AgentHostStateRepository;
  executor: AgentHostExecutor;
  interactionRelay?: Pick<DurableAcpInteractionRelay, "accept">;
  conversations?: Pick<
    RemoteAcpConversationService,
    "handle" | "recover" | "stop" | "isSessionActive"
  >;
  canvasRuntime?: Pick<
    CanvasRuntimeService,
    | "disconnect"
    | "enabled"
    | "handle"
    | "recover"
    | "start"
    | "stop"
    | "synchronizeServerTime"
    | "updateCredentialToken"
  >;
  allowInsecureTransport?: boolean;
  ca?: string[];
  request: typeof fetch;
  reconnect?: Partial<ReconnectBackoffOptions>;
  clock?: HostTransportClock;
  serverClock?: CalibratedServerClock;
  random?: () => number;
  limits?: Partial<HostTransportLimits>;
  logger?: HostTransportLogger;
  onProtocolError?(event: Extract<ServerEvent, { type: "protocol.error" }>): void;
};
