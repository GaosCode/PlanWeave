import {
  edgeTypes,
  executorAdapter,
  reviewTriggerConditions,
  supportedManifestVersion,
  type ExecutorAdapterName,
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

const executorProfileSchema: Record<ExecutorAdapterName, Record<string, unknown>> = {
  manual: { adapter: executorAdapter.manual },
  "codex-exec": {
    adapter: executorAdapter.codexExec,
    command: "string, non-empty",
    args: 'string[], default: ["exec", "-"]',
    sandbox: '"read-only" | "workspace-write" | "danger-full-access", optional',
    role: "string, optional",
    ...runtimeLimitFields
  },
  "opencode-exec": {
    adapter: executorAdapter.opencodeExec,
    command: "string, non-empty",
    args: 'string[], default: ["run", "-"]',
    sandbox: '"read-only" | "workspace-write" | "danger-full-access", optional',
    ...runtimeLimitFields
  },
  "claude-code-exec": {
    adapter: executorAdapter.claudeCodeExec,
    command: "string, non-empty",
    args: 'string[], default: ["-p"]',
    ...runtimeLimitFields
  },
  "pi-exec": {
    adapter: executorAdapter.piExec,
    command: "string, non-empty",
    args: 'string[], default: ["-p"]',
    ...runtimeLimitFields
  },
  "local-review": {
    adapter: executorAdapter.localReview,
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
        "string, optional; must be default/manual/codex/codex-auto/opencode/claude-code/claude-code-auto/pi/pi-auto or a key in executors",
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
              locks:
                'string[], default: []; reserved name "exclusive" is mutually exclusive with every other block',
              safe: "boolean, optional, deprecated — use locks:[\"exclusive\"] instead of safe:false; presence emits a deprecation warning"
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
    "Dependency edges answer when a block can start; locks answer which ready blocks can run at the same time.",
    "Absent block parallel means parallel-eligible with no locks. Reserved lock exclusive conflicts with everything.",
    "parallel.safe is deprecated: safe:false is normalized to locks including exclusive; safe:true has no effect.",
    "Keep goals, requirements, constraints, risks, and references in project/global prompts, task acceptance, task prompts, or block prompts.",
    "Prompt paths are source files; rendered prompt output is derived and must not be written back into source prompts."
  ]
};
