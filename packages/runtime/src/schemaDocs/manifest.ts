import {
  edgeTypes,
  executorIntegration,
  reviewTriggerConditions,
  supportedManifestVersion,
  type ReviewTriggerCondition
} from "../types.js";
import {
  DEFAULT_EXECUTOR_MAX_STDERR_BYTES,
  DEFAULT_EXECUTOR_MAX_STDOUT_BYTES,
  DEFAULT_EXECUTOR_TIMEOUT_MS
} from "../autoRun/executorShared.js";
import type { SchemaDocument } from "./types.js";

const runtimeLimitFields = {
  timeoutMs: `positive integer milliseconds, optional; default runtime limit: ${DEFAULT_EXECUTOR_TIMEOUT_MS}`,
  maxStdoutBytes: `positive integer bytes, optional; default runtime limit: ${DEFAULT_EXECUTOR_MAX_STDOUT_BYTES}`,
  maxStderrBytes: `positive integer bytes, optional; default runtime limit: ${DEFAULT_EXECUTOR_MAX_STDERR_BYTES}`
};

const executorProfileSchema: Record<string, Record<string, unknown>> = {
  manual: { adapter: "manual" },
  "agent-cli": {
    adapter: "agent",
    agent: '"codex" | "opencode" | "claude-code" | "pi" | "grok"',
    runner: { transport: '"cli"', tmuxEnabled: "boolean, optional" },
    command: "string, non-empty",
    args: "string[]; agent-specific default",
    sandbox: '"read-only" | "workspace-write" | "danger-full-access", codex/opencode only',
    role: "string, optional; codex only",
    ...runtimeLimitFields
  },
  "agent-acp": {
    adapter: "agent",
    agent: '"codex" | "opencode" | "claude-code" | "pi" | "grok"',
    runner: { transport: '"acp"' }
  },
  "codex-exec": {
    adapter: `${executorIntegration.codexExec} (legacy manifest input)`,
    command: "string, non-empty",
    args: 'string[], default: ["exec", "-"]',
    sandbox: '"read-only" | "workspace-write" | "danger-full-access", optional',
    role: "string, optional",
    ...runtimeLimitFields
  },
  "opencode-exec": {
    adapter: `${executorIntegration.opencodeExec} (legacy manifest input)`,
    command: "string, non-empty",
    args: 'string[], default: ["run", "-"]',
    sandbox: '"read-only" | "workspace-write" | "danger-full-access", optional',
    ...runtimeLimitFields
  },
  "claude-code-exec": {
    adapter: `${executorIntegration.claudeCodeExec} (legacy manifest input)`,
    command: "string, non-empty",
    args: 'string[], default: ["-p"]',
    ...runtimeLimitFields
  },
  "pi-exec": {
    adapter: `${executorIntegration.piExec} (legacy manifest input)`,
    command: "string, non-empty",
    args: 'string[], default: ["-p"]',
    ...runtimeLimitFields
  },
  "grok-exec": {
    adapter: `${executorIntegration.grokExec} (legacy manifest input)`,
    command: "string, non-empty",
    args: 'string[]; must include "--no-auto-update" and end with exactly one "--prompt-file"; default: ["--no-auto-update", "--prompt-file"]',
    ...runtimeLimitFields
  },
  "local-review": {
    adapter: "local-review",
    command: "string, non-empty",
    args: "string[], default: []",
    sandbox: '"read-only" | "workspace-write" | "danger-full-access", optional',
    ...runtimeLimitFields
  }
};

const reviewTriggerConditionSchema = Object.fromEntries(
  reviewTriggerConditions.map((condition) => [condition, condition])
) as Record<ReviewTriggerCondition, ReviewTriggerCondition>;
const edgeTypeSchema = edgeTypes.map((type) => `"${type}"`).join(" | ");

export const manifestSchemaDocument: SchemaDocument<"manifest"> = {
  name: "manifest",
  summary: "Plan Package source graph schema.",
  path: "manifest.json inside the CLI-returned packageDir; default canvas uses canvases/default/package/manifest.json",
  ownership:
    "User/agent editable source. Do not write runtime state, results, or desktop layout here.",
  validation: ["planweave validate --json", "planweave refresh-prompts"],
  schema: {
    version: supportedManifestVersion,
    project: { title: "string, non-empty", description: "string" },
    execution: {
      defaultExecutor:
        "string, optional; must be a built-in CLI/ACP profile name or a key in executors",
      parallel: { enabled: "boolean", maxConcurrent: "positive integer" }
    },
    review: { maxFeedbackCycles: "non-negative integer, default: 1", completionPolicy: "strict" },
    executors: { "[executorName]": executorProfileSchema },
    nodes: [
      {
        id: "task id string, non-empty",
        type: "task",
        title: "string, non-empty",
        prompt: "string, non-empty; package-relative prompt source path",
        executor: "string, optional; must reference a known executor profile",
        acceptance: "string[], at least one item",
        blocks: [
          {
            id: "block id string, non-empty",
            type: "implementation",
            title: "string, non-empty",
            prompt: "string, non-empty; package-relative prompt source path",
            depends_on: "block id string[], default: []",
            executor: "string, optional; must reference a known executor profile",
            parallel: {
              sharedResources:
                "string[], optional; deduplicated coordination hints that never affect ready, claim, or scheduling"
            }
          },
          {
            id: "block id string, non-empty",
            type: "review",
            title: "string, non-empty",
            prompt: "string, non-empty; package-relative prompt source path",
            depends_on: "block id string[], default: []",
            executor: "string, optional; must reference a known executor profile",
            review: {
              required: "boolean, default: true",
              maxFeedbackCycles: "non-negative integer, default: 1",
              preset: "string, optional",
              triggerCondition:
                Object.values(reviewTriggerConditionSchema)
                  .map((condition) => `"${condition}"`)
                  .join(" | ") + ", optional",
              inputContext: "string, optional",
              passCriteria: "string, optional",
              feedbackFormat: "string, optional",
              hook: {
                id: "string, non-empty",
                type: "executable",
                command: "string, non-empty",
                args: "string[], default: []",
                executionPolicy: "trusted-local"
              }
            }
          }
        ]
      }
    ],
    edges: [{ from: "task id string", to: "task id string", type: edgeTypeSchema }]
  },
  notes: [
    "Only task nodes are supported; do not create goal, context, requirement, risk, or file nodes.",
    "Only implementation and review block types are supported.",
    "Use task edges for task dependencies and block depends_on for block order inside a task.",
    "Dependencies answer when a block can start; shared resources only describe coordination context.",
    "Absent block parallel means the block has no shared-resource coordination hints.",
    "Agent identity and runner transport are separate. Each agent profile selects exactly one runner: cli or acp.",
    "Legacy *-exec profiles remain valid and normalize once to the canonical agent plus CLI runner shape.",
    "CLI and ACP are alternative runner transports. Canonical agent names follow the configured transport; explicit *-acp names select ACP. PlanWeave never falls back between them.",
    "ACP is conversation/session integration, not terminal attachment. The selected agent owns login, subscription, provider configuration, quota, and optional API-key mode; PlanWeave does not collect those credentials and ACP does not require a PlanWeave API key.",
    "Existing legacy CLI manifests remain valid without changes and normalize once to the CLI runner contract.",
    "tmuxEnabled is CLI-only. ACP runner objects are strict and reject CLI command, terminal, and tmux fields.",
    "Headless runner preflight and execution never auto-approve permission, authentication, or elicitation requests; unsupported interaction fails closed within a bounded timeout.",
    "Keep goals, requirements, constraints, risks, and references in project/global prompts, task acceptance, task prompts, or block prompts.",
    "Prompt paths are source files; rendered prompt output is derived and must not be written back into source prompts."
  ]
};
