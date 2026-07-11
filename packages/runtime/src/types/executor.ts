import { z } from "zod";
import type { ClaimResult } from "./taskManager.js";

export const executorProfileAdapterSchema = z.enum(["manual", "agent", "local-review"]);
export type ExecutorProfileAdapter = z.infer<typeof executorProfileAdapterSchema>;

export const executorIntegrationSchema = z.enum([
  "manual",
  "codex-exec",
  "opencode-exec",
  "claude-code-exec",
  "pi-exec",
  "local-review"
]);
export const executorIntegrations = executorIntegrationSchema.options;
export type ExecutorIntegrationName = z.infer<typeof executorIntegrationSchema>;
export const executorIntegration = {
  manual: executorIntegrationSchema.enum.manual,
  codexExec: executorIntegrationSchema.enum["codex-exec"],
  opencodeExec: executorIntegrationSchema.enum["opencode-exec"],
  claudeCodeExec: executorIntegrationSchema.enum["claude-code-exec"],
  piExec: executorIntegrationSchema.enum["pi-exec"],
  localReview: executorIntegrationSchema.enum["local-review"]
} as const;

/**
 * @deprecated Use executorIntegration. This thin published alias shares the same authority and may
 * only be removed in a future major version after a documented deprecation window.
 */
export const executorAdapter = executorIntegration;
/**
 * @deprecated Use executorIntegrations. This thin published alias shares the same authority and may
 * only be removed in a future major version after a documented deprecation window.
 */
export const executorAdapters = executorIntegrations;
/**
 * @deprecated Use ExecutorIntegrationName. This thin published alias shares the same authority and
 * may only be removed in a future major version after a documented deprecation window.
 */
export type ExecutorAdapterName = ExecutorIntegrationName;

export const agentFamilySchema = z.enum(["codex", "opencode", "claude-code", "pi"]);
export const agentFamilies = agentFamilySchema.options;
export type AgentFamily = z.infer<typeof agentFamilySchema>;

export const executorRuntimeLimitsSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  maxStdoutBytes: z.number().int().positive().optional(),
  maxStderrBytes: z.number().int().positive().optional()
});
export type ExecutorRuntimeLimits = z.infer<typeof executorRuntimeLimitsSchema>;

export const runnerTransportSchema = z.enum(["cli", "acp"]);
export type RunnerTransport = z.infer<typeof runnerTransportSchema>;

export const cliRunnerSchema = z
  .object({
    transport: runnerTransportSchema.extract(["cli"]),
    tmuxEnabled: z.boolean().optional()
  })
  .strict();

export type CliRunner = z.infer<typeof cliRunnerSchema>;

export const acpRunnerSchema = z
  .object({ transport: runnerTransportSchema.extract(["acp"]) })
  .strict();
export type AcpRunner = z.infer<typeof acpRunnerSchema>;

const manualExecutorProfileSchema = z
  .object({ adapter: executorProfileAdapterSchema.extract(["manual"]) })
  .strict();

const localReviewExecutorProfileSchema = z
  .object({
    adapter: executorProfileAdapterSchema.extract(["local-review"]),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
    ...executorRuntimeLimitsSchema.shape
  })
  .strict();

const agentAcpProfileSchema = z
  .object({
    adapter: executorProfileAdapterSchema.extract(["agent"]),
    agent: agentFamilySchema,
    runner: acpRunnerSchema
  })
  .strict();

const codexCliProfileSchema = z
  .object({
    adapter: executorProfileAdapterSchema.extract(["agent"]),
    agent: agentFamilySchema.extract(["codex"]),
    runner: cliRunnerSchema,
    command: z.string().min(1),
    args: z.array(z.string()).default(["exec", "-"]),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
    role: z.string().min(1).optional(),
    ...executorRuntimeLimitsSchema.shape
  })
  .strict();

const opencodeCliProfileSchema = z
  .object({
    adapter: executorProfileAdapterSchema.extract(["agent"]),
    agent: agentFamilySchema.extract(["opencode"]),
    runner: cliRunnerSchema,
    command: z.string().min(1),
    args: z.array(z.string()).default(["run", "-"]),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
    ...executorRuntimeLimitsSchema.shape
  })
  .strict();

const claudeCodeCliProfileSchema = z
  .object({
    adapter: executorProfileAdapterSchema.extract(["agent"]),
    agent: agentFamilySchema.extract(["claude-code"]),
    runner: cliRunnerSchema,
    command: z.string().min(1),
    args: z.array(z.string()).default(["-p"]),
    ...executorRuntimeLimitsSchema.shape
  })
  .strict();

const piCliProfileSchema = z
  .object({
    adapter: executorProfileAdapterSchema.extract(["agent"]),
    agent: agentFamilySchema.extract(["pi"]),
    runner: cliRunnerSchema,
    command: z.string().min(1),
    args: z.array(z.string()).default(["-p"]),
    ...executorRuntimeLimitsSchema.shape
  })
  .strict();

const canonicalExecutorProfileSchema = z.union([
  manualExecutorProfileSchema,
  localReviewExecutorProfileSchema,
  codexCliProfileSchema,
  opencodeCliProfileSchema,
  claudeCodeCliProfileSchema,
  piCliProfileSchema,
  agentAcpProfileSchema
]);

const legacyAgentProfileSchema = z.discriminatedUnion("adapter", [
  z
    .object({
      adapter: executorIntegrationSchema.extract(["codex-exec"]),
      command: z.string().min(1),
      args: z.array(z.string()).default(["exec", "-"]),
      sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
      role: z.string().min(1).optional(),
      ...executorRuntimeLimitsSchema.shape
    })
    .strict(),
  z
    .object({
      adapter: executorIntegrationSchema.extract(["opencode-exec"]),
      command: z.string().min(1),
      args: z.array(z.string()).default(["run", "-"]),
      sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
      ...executorRuntimeLimitsSchema.shape
    })
    .strict(),
  z
    .object({
      adapter: executorIntegrationSchema.extract(["claude-code-exec"]),
      command: z.string().min(1),
      args: z.array(z.string()).default(["-p"]),
      ...executorRuntimeLimitsSchema.shape
    })
    .strict(),
  z
    .object({
      adapter: executorIntegrationSchema.extract(["pi-exec"]),
      command: z.string().min(1),
      args: z.array(z.string()).default(["-p"]),
      ...executorRuntimeLimitsSchema.shape
    })
    .strict()
]);

function normalizeLegacyAgentProfile(
  profile: z.infer<typeof legacyAgentProfileSchema>
): z.infer<typeof canonicalExecutorProfileSchema> {
  if (profile.adapter === "codex-exec") {
    const { adapter: _adapter, ...cli } = profile;
    return { adapter: "agent", agent: "codex", runner: { transport: "cli" }, ...cli };
  }
  if (profile.adapter === "opencode-exec") {
    const { adapter: _adapter, ...cli } = profile;
    return {
      adapter: "agent",
      agent: "opencode",
      runner: { transport: "cli" },
      ...cli
    };
  }
  if (profile.adapter === "claude-code-exec") {
    const { adapter: _adapter, ...cli } = profile;
    return {
      adapter: "agent",
      agent: "claude-code",
      runner: { transport: "cli" },
      ...cli
    };
  }
  const { adapter: _adapter, ...cli } = profile;
  return { adapter: "agent", agent: "pi", runner: { transport: "cli" }, ...cli };
}

const executorProfileUnionSchema = z.union([
  canonicalExecutorProfileSchema,
  legacyAgentProfileSchema
]);

const canonicalAgentDiscriminatorSchema = z
  .object({
    adapter: executorProfileAdapterSchema.extract(["agent"]),
    agent: agentFamilySchema,
    runner: z.object({ transport: runnerTransportSchema }).passthrough()
  })
  .passthrough();

const executorProfileAdapterInputSchema = z.union([
  executorProfileAdapterSchema,
  executorIntegrationSchema
]);

const executorProfileDiscriminatorSchema = z
  .object({ adapter: executorProfileAdapterInputSchema })
  .passthrough();

type ExecutorProfileZodIssue = z.ZodError["issues"][number];

function appendReadableProfileIssues(
  issues: readonly ExecutorProfileZodIssue[],
  context: z.RefinementCtx,
  seen: Set<string>
): void {
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        const path = [...issue.path, key];
        const message = `Unrecognized key: "${key}"`;
        const identity = `${path.join(".")}:${message}`;
        if (!seen.has(identity)) {
          seen.add(identity);
          context.addIssue({ code: z.ZodIssueCode.custom, path, message });
        }
      }
      continue;
    }
    const identity = `${issue.path.join(".")}:${issue.message}`;
    if (!seen.has(identity)) {
      seen.add(identity);
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: issue.path,
        message: issue.message
      });
    }
  }
}

function selectedExecutorProfileParse(raw: unknown) {
  const discriminator = executorProfileDiscriminatorSchema.safeParse(raw);
  if (!discriminator.success) {
    return discriminator;
  }

  const { adapter } = discriminator.data;
  if (adapter === "manual") {
    return manualExecutorProfileSchema.safeParse(raw);
  }
  if (adapter === "local-review") {
    return localReviewExecutorProfileSchema.safeParse(raw);
  }
  if (
    adapter === "codex-exec" ||
    adapter === "opencode-exec" ||
    adapter === "claude-code-exec" ||
    adapter === "pi-exec"
  ) {
    return legacyAgentProfileSchema.safeParse(raw);
  }
  if (adapter !== "agent") {
    return executorProfileUnionSchema.safeParse(raw);
  }

  const agentDiscriminator = canonicalAgentDiscriminatorSchema.safeParse(raw);
  if (!agentDiscriminator.success) {
    return agentDiscriminator;
  }
  if (agentDiscriminator.data.runner.transport === "acp") {
    return agentAcpProfileSchema.safeParse(raw);
  }
  if (agentDiscriminator.data.agent === "codex") {
    return codexCliProfileSchema.safeParse(raw);
  }
  if (agentDiscriminator.data.agent === "opencode") {
    return opencodeCliProfileSchema.safeParse(raw);
  }
  if (agentDiscriminator.data.agent === "claude-code") {
    return claudeCodeCliProfileSchema.safeParse(raw);
  }
  return piCliProfileSchema.safeParse(raw);
}

const executorProfileBoundarySchema = z.unknown().transform((raw, context) => {
  const parsed = selectedExecutorProfileParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  appendReadableProfileIssues(parsed.error.issues, context, new Set());
  return z.NEVER;
});

/** Manifest boundary schema. Legacy CLI profiles normalize once into the canonical profile. */
export const executorProfileSchema = executorProfileBoundarySchema.transform((profile) => {
  if (
    profile.adapter === "codex-exec" ||
    profile.adapter === "opencode-exec" ||
    profile.adapter === "claude-code-exec" ||
    profile.adapter === "pi-exec"
  ) {
    return normalizeLegacyAgentProfile(profile);
  }
  return profile;
});

export type ExecutorProfile = z.infer<typeof executorProfileSchema>;
export type ExecutorProfileInput = z.input<typeof executorProfileUnionSchema>;
export type ManualExecutorProfile = Extract<ExecutorProfile, { adapter: "manual" }>;
export type LocalReviewExecutorProfile = Extract<ExecutorProfile, { adapter: "local-review" }>;
export type AgentExecutorProfile = Extract<ExecutorProfile, { adapter: "agent" }>;
export type AgentCliExecutorProfile = Extract<
  AgentExecutorProfile,
  { runner: { transport: "cli" } }
>;
export type CodexExecExecutorProfile = Extract<AgentCliExecutorProfile, { agent: "codex" }>;
export type OpencodeExecExecutorProfile = Extract<AgentCliExecutorProfile, { agent: "opencode" }>;
export type ClaudeCodeExecExecutorProfile = Extract<
  AgentCliExecutorProfile,
  { agent: "claude-code" }
>;
export type PiExecExecutorProfile = Extract<AgentCliExecutorProfile, { agent: "pi" }>;

type ExecutorProfileSummaryFor<TProfile extends ExecutorProfile> = TProfile extends ExecutorProfile
  ? Omit<TProfile, "adapter"> & {
      name: string;
      source: "builtin" | "package";
      /** Compatibility field: execution integration for executable profiles, agent for ACP. */
      adapter: ExecutorAdapterName | "agent";
      profileAdapter?: TProfile["adapter"];
      executionIntegration?: ExecutorIntegrationName | null;
      agentId?: AgentFamily | null;
      runnerKind?: RunnerTransport | null;
      acpLaunch?: {
        command: string;
        args: readonly string[];
        source: { registryId: string; version: string; url: string; descriptor: string };
      } | null;
      staticCapabilities?: readonly string[];
      optionalCapabilities?: readonly string[];
      limitations?: readonly string[];
    }
  : never;

export type ExecutorProfileSummary = ExecutorProfileSummaryFor<ExecutorProfile>;

export type ExecutorAdapterResult =
  | {
      kind: "block";
      reportPath: string;
      runId?: string;
      executor?: string;
      /** Persisted execution integration identifier retained by the existing run metadata contract. */
      adapter?: ExecutorIntegrationName;
      agentId?: AgentFamily | null;
      runnerKind?: RunnerTransport | null;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      startedAt?: string;
      finishedAt?: string;
      agentSessionId?: string | null;
      codexSessionId?: string | null;
      opencodeSessionId?: string | null;
    }
  | {
      kind: "review";
      resultPath: string;
      runId?: string;
      executor?: string;
      /** Persisted execution integration identifier retained by the existing run metadata contract. */
      adapter?: ExecutorIntegrationName;
      agentId?: AgentFamily | null;
      runnerKind?: RunnerTransport | null;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      startedAt?: string;
      finishedAt?: string;
      agentSessionId?: string | null;
      codexSessionId?: string | null;
      opencodeSessionId?: string | null;
    }
  | {
      kind: "feedback";
      reportPath: string;
      runId?: string;
      executor?: string;
      /** Persisted execution integration identifier retained by the existing run metadata contract. */
      adapter?: ExecutorIntegrationName;
      agentId?: AgentFamily | null;
      runnerKind?: RunnerTransport | null;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      startedAt?: string;
      finishedAt?: string;
      agentSessionId?: string | null;
      codexSessionId?: string | null;
      opencodeSessionId?: string | null;
    }
  | {
      kind: "manual";
      promptPath: string;
      runDir: string;
      runId: string;
      executor: string;
      adapter: "manual";
      agentId?: null;
      runnerKind?: null;
      nextCommand: string;
    };

export type ExecutorAdapter = {
  runBlock(input: {
    claim: Extract<ClaimResult, { kind: "block" }>;
    prompt: string;
  }): Promise<ExecutorAdapterResult>;
  runFeedback(input: {
    claim: Extract<ClaimResult, { kind: "feedback" }>;
  }): Promise<ExecutorAdapterResult>;
};
