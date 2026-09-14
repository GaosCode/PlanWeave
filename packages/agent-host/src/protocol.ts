import {
  artifactRefSchema,
  capabilitiesSchema,
  dispatchResultSchema,
  executeBlockCommandSchema,
  hostEventSchema,
  historicalHostEventSchema,
  historicalMailboxCommandSchema,
  hostHelloSchema,
  mailboxCommandSchema,
  serverEventSchema,
  type ArtifactRef,
  type DispatchResult,
  type HostEvent,
  type HistoricalHostEvent,
  type HistoricalMailboxCommand,
  type HostHello,
  type MailboxCommand,
  type NormalizedFailure,
  type ServerEvent,
  type ServerToHostCommand
} from "@planweave-ai/agent-host-protocol";

export type {
  ArtifactRef,
  DispatchResult,
  HostEvent,
  HistoricalHostEvent,
  HistoricalMailboxCommand,
  HostHello,
  MailboxCommand,
  NormalizedFailure,
  ServerEvent,
  ServerToHostCommand
};

export function parseAgentHostArtifactRef(input: unknown): ArtifactRef {
  return artifactRefSchema.parse(input);
}

export function parseAgentHostCapabilities(input: unknown): string[] {
  return capabilitiesSchema.parse(input);
}

export function parseAgentHostDispatchResult(input: unknown): DispatchResult {
  return dispatchResultSchema.parse(input);
}

export function parseAgentHostExecuteCommand(
  input: unknown
): Extract<ServerToHostCommand, { type: "execute_block" }> {
  return executeBlockCommandSchema.parse(input);
}

export function parseAgentHostEvent(input: unknown): HostEvent {
  return hostEventSchema.parse(input);
}

export function parseAgentHostMailboxCommand(input: unknown): MailboxCommand {
  return mailboxCommandSchema.parse(input);
}

export function parseAgentHostServerEvent(input: unknown): ServerEvent {
  return serverEventSchema.parse(input);
}

export function serializeAgentHostEvent(input: unknown): string {
  return JSON.stringify(parseAgentHostEvent(input));
}

export function serializeAgentHostHello(input: unknown): string {
  return JSON.stringify(hostHelloSchema.parse(input));
}

export function parseHistoricalAgentHostEvent(input: unknown): HistoricalHostEvent {
  return historicalHostEventSchema.parse(input);
}

export function serializeHistoricalAgentHostEvent(input: unknown): string {
  return JSON.stringify(parseHistoricalAgentHostEvent(input));
}

export function parseHistoricalAgentHostMailboxCommand(input: unknown): HistoricalMailboxCommand {
  return historicalMailboxCommandSchema.parse(input);
}
