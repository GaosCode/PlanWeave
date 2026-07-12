/**
 * Provider-neutral contracts for the Coordinator Agent.
 *
 * Every provider implementation MUST satisfy the `AgentProvider` interface.
 * The services layer validates citations after the provider returns, so
 * providers are not responsible for citation correctness — they just
 * produce artifacts with whatever source references they believe are valid.
 */

export type {
  AgentProvider,
  AgentProviderContext,
  AgentProviderOutput,
  AgentBudget
} from "../types.js"
