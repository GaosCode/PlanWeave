/**
 * Public surface for A6 Coordinator Agent and consensus artifacts.
 */

export { AgentError } from "./types.js"
export type {
  AgentRun,
  AgentRunStatus,
  AgentCheckpoint,
  StructuredArtifact,
  ArtifactCitation,
  ArtifactKind,
  AgentBudget,
  AgentProvider,
  AgentProviderContext,
  AgentProviderOutput,
  AgentRepository,
  AgentServices,
  StartAgentRunCommand,
  CancelAgentRunCommand,
  StartRunResult,
  CancelRunResult,
  AgentErrorCode,
  AgentErrorDetails
} from "./types.js"
export { applyAgentsMigrations, agentsSchemaVersion, agentMigrations } from "./migrations.js"
export { createAgentRepository } from "./repository.js"
export { createAgentServices, assertAgentCannotApprove } from "./services.js"
export { createFakeAgentProvider } from "./providers/fakeProvider.js"
export type { FakeProviderOptions } from "./providers/fakeProvider.js"
