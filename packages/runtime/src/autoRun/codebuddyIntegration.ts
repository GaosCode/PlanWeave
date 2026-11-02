import type { AgentDefinition } from "./agentRunner.js";

/**
 * CodeBuddy (Tencent) — ACP-only integration.
 *
 * The CLI shipped inside the WorkBuddy desktop is a reduced build: it ships only
 * `codebuddy-lite-wb.mjs`, accepts `--acp` but exits silently, and fails on a
 * missing `../dist/codebuddy` when the lite-bundle override is absent. The npm
 * package `@tencent-ai/codebuddy-code` is the distributable build and does
 * implement ACP (verified: `initialize` answers with protocolVersion 1).
 *
 * Therefore this integration points at the npm package and deliberately offers
 * no CLI (`--print`) profile: PlanWeave's CLI executor path passes the whole
 * host environment through to the child, which would leak session identifiers
 * and MCP credentials into the agent. The ACP path uses the shared environment
 * whitelist instead.
 */
export const codebuddyAgentDefinition: AgentDefinition = {
  agent: "codebuddy",
  builtinProfiles: {
    "codebuddy-acp": {
      adapter: "agent",
      agent: "codebuddy",
      runner: { transport: "acp" }
    }
  },
  cli: null,
  acp: {
    launch: {
      command: "codebuddy-code",
      args: ["--acp"],
      source: {
        registryId: "codebuddy-code",
        version: "2.179.1",
        url: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
        descriptor: "codebuddy-code@2.179.1"
      }
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
      "Requires the npm package @tencent-ai/codebuddy-code; the CLI bundled with the WorkBuddy desktop cannot run --acp.",
      "Authentication is interactive (iOA, Google/GitHub, WeChat, or a self-hosted domain); an unauthenticated host fails closed at session creation.",
      "CLI (--print) execution is intentionally unsupported so the agent never inherits the full host environment."
    ]
  }
};
