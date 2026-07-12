/**
 * Deterministic fake provider for Coordinator Agent tests.
 *
 * Returns predefined structured artifacts so tests can validate the
 * services layer (citation validation, cancellation, restart recovery)
 * without a real LLM backend.
 */

import type { AgentProvider, AgentProviderContext, AgentProviderOutput } from "./providerContracts.js"

export type FakeProviderOptions = {
  /** Artifacts to return on each call. Defaults to a minimal set. */
  outputs?: AgentProviderOutput[]
  /** If true, throw on run() to simulate provider failure. */
  shouldFail?: Error
}

export function createFakeAgentProvider(options: FakeProviderOptions = {}): AgentProvider {
  const outputs = options.outputs ?? [defaultOutput()]
  let callIndex = 0

  return {
    type: "fake",
    async run(_context: AgentProviderContext, signal?: AbortSignal): Promise<AgentProviderOutput> {
      if (signal?.aborted) {
        throw new Error("Run cancelled")
      }
      if (options.shouldFail) {
        throw options.shouldFail
      }
      const output = outputs[callIndex % outputs.length]
      callIndex++
      if (signal?.aborted) {
        throw new Error("Run cancelled while processing")
      }
      return output
    }
  }
}

function defaultOutput(): AgentProviderOutput {
  return {
    done: true,
    artifacts: [
      {
        kind: "brief",
        title: "Project brief",
        body: "This project aims to build a coordination layer for planning rooms.",
        citations: []
      },
      {
        kind: "requirements",
        title: "Functional requirements",
        body: "1. Messages must be appendable to rooms.\n2. Attachments must be storable.",
        citations: []
      },
      {
        kind: "constraints",
        title: "Technical constraints",
        body: "Must use SQLite, must support idempotency keys.",
        citations: []
      }
    ]
  }
}
