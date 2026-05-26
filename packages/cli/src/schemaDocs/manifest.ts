import type { SchemaDocument } from "./types.js";

const executorProfileSchema = {
  manual: { adapter: "manual" },
  "codex-exec": {
    adapter: "codex-exec",
    command: "string, non-empty",
    args: 'string[], default: ["exec", "-"]',
    sandbox: '"read-only" | "workspace-write" | "danger-full-access", optional',
    role: "string, optional",
    timeoutMs: "positive integer, optional"
  },
  "opencode-exec": {
    adapter: "opencode-exec",
    command: "string, non-empty",
    args: 'string[], default: ["run", "-"]',
    sandbox: '"read-only" | "workspace-write" | "danger-full-access", optional',
    timeoutMs: "positive integer, optional"
  },
  "local-review": {
    adapter: "local-review",
    command: "string, non-empty",
    args: "string[], default: []",
    sandbox: '"read-only" | "workspace-write" | "danger-full-access", optional',
    timeoutMs: "positive integer, optional"
  }
};

export const manifestSchemaDocument: SchemaDocument = {
  name: "manifest",
  summary: "Plan Package source graph schema.",
  path: "package/manifest.json inside the CLI-returned packageDir",
  ownership: "User/agent editable source. Do not write runtime state, results, or desktop layout here.",
  validation: ["planweave validate --json", "planweave refresh-prompts"],
  schema: {
    version: "plan-package/v1",
    project: { title: "string, non-empty", description: "string" },
    execution: {
      defaultExecutor: "string, optional; must be default/manual/codex-auto/codex-reviewer or a key in executors",
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
            parallel: { safe: "boolean, default: false", locks: "string[], default: []" }
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
              triggerCondition: '"after_required_work_completed" | "manual", optional',
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
    edges: [{ from: "task id string", to: "task id string", type: "depends_on" }]
  },
  notes: [
    "Only task nodes are supported; do not create goal, context, requirement, risk, or file nodes.",
    "Only implementation and review block types are supported.",
    "Use task edges for task dependencies and block depends_on for block order inside a task.",
    "Keep goals, requirements, constraints, risks, and references in project/global prompts, task acceptance, task prompts, or block prompts.",
    "Prompt paths are source files; rendered prompt output is derived and must not be written back into source prompts."
  ]
};
