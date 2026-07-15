import type { AgentDefinition } from "./agentRunner.js";

export const grokAgentDefinition: AgentDefinition = {
  agent: "grok",
  builtinProfiles: {
    "grok-acp": {
      adapter: "agent",
      agent: "grok",
      runner: { transport: "acp" }
    }
  },
  cli: null,
  acp: {
    launch: {
      command: "grok",
      args: ["--no-auto-update", "agent", "stdio"],
      source: {
        registryId: "xai-grok-cli",
        version: "0.2.101",
        url: "https://docs.x.ai/build/cli/headless-scripting",
        descriptor: "xAI Grok CLI 0.2.101: grok --no-auto-update agent stdio (verified 2026-07-15)"
      }
    },
    authentication: {
      preferredMethodIds: ["xai.api_key", "cached_token"],
      headlessSafeMethodIds: ["cached_token"]
    },
    capabilities: ["session", "prompt", "cancel", "streaming", "tool-updates"],
    optionalCapabilities: [
      "permission",
      "authentication",
      "image",
      "embedded-context",
      "session-close",
      "history-load"
    ],
    limitations: [
      "ACP-only integration; PlanWeave does not provide a Grok CLI runner or fallback.",
      "The trusted launch was verified against xAI Grok CLI 0.2.101 help and xAI Headless & Scripting documentation on 2026-07-15.",
      "Interactive Grok authentication must be completed outside headless PlanWeave execution before retrying."
    ]
  }
};
