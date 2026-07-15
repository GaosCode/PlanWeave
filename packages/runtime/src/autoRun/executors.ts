import { loadPackage, resolvePackageWorkspace } from "../package/loadPackage.js";
import type {
  ExecutorPreflightCheck,
  ProducedExecutorPreflightResult
} from "./executorPreflightTypes.js";
import {
  executorSpawnFailureCode,
  producedExecutorPreflightResultSchema
} from "./executorPreflightTypes.js";
import type {
  AutoRunRunnerEvidence,
  ExecutorAdapter,
  ExecutorIntegrationName,
  ExecutorProfile,
  ExecutorProfileAdapter,
  ExecutorProfileSummary,
  ManifestTaskNode,
  PackageWorkspaceRef,
  PlanPackageManifest,
  ProjectWorkspace
} from "../types.js";
import {
  executorIntegrationForProfile,
  requireExecutorIntegration,
  resolveAgentDefinition
} from "./agentRegistry.js";
import { applyDesktopAgentSettingsToBuiltinProfiles } from "./desktopAgentSettings.js";
import {
  assertPackageExecutorCommandTrusted,
  execWithStdin,
  executorLimitFailureMessage,
  executorRuntimeLimits,
  workspaceExecutionCwd,
  type BlockClaim
} from "./executorShared.js";
import type { ExecutorRuntimeOptions } from "./executorIntegration.js";
import {
  builtinExecutorProfiles,
  isSupportedExecutionIntegration,
  runProfileBlock,
  runProfileFeedback
} from "./profileExecutor.js";
import { resolveAgentRunner } from "./runnerRegistry.js";
import { assertAcpLaunchTrusted } from "./acpLaunch.js";
import { executionWaveIdSchema } from "./runnerContractSchemas.js";

export const executorPreflightVersionTimeoutMs = 5_000;
export const executorPreflightAcpSessionProbeTimeoutMs = 30_000;

function taskNodeForClaim(manifest: PlanPackageManifest, claim: BlockClaim): ManifestTaskNode {
  const node = manifest.nodes.find((item) => item.type === "task" && item.id === claim.taskId);
  if (node?.type !== "task") {
    throw new Error(`Task '${claim.taskId}' does not exist.`);
  }
  return node;
}

function resolveBlockExecutorName(
  manifest: PlanPackageManifest,
  claim: BlockClaim,
  override?: string
): string {
  const task = taskNodeForClaim(manifest, claim);
  const block = task.blocks.find((item) => item.id === claim.blockId);
  if (!block) {
    throw new Error(`Block '${claim.ref}' does not exist.`);
  }
  return (
    override ?? block.executor ?? task.executor ?? manifest.execution.defaultExecutor ?? "default"
  );
}

function profilesByName(manifest: PlanPackageManifest): Record<string, ExecutorProfile> {
  return {
    ...applyDesktopAgentSettingsToBuiltinProfiles(builtinExecutorProfiles),
    ...(manifest.executors ?? {})
  };
}

function profileSource(manifest: PlanPackageManifest, name: string): "builtin" | "package" {
  return manifest.executors?.[name] ? "package" : "builtin";
}

async function resolveProfileForClaim(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  executorName?: string;
}): Promise<{ name: string; profile: ExecutorProfile; source: "builtin" | "package" }> {
  const { manifest } = await loadPackage(options.projectRoot);
  const name = resolveBlockExecutorName(manifest, options.claim, options.executorName);
  const profile = profilesByName(manifest)[name];
  if (!profile) {
    throw new Error(`Executor profile '${name}' does not exist.`);
  }
  return { name, profile, source: profileSource(manifest, name) };
}

function createProfiledAdapter(options: {
  projectRoot: PackageWorkspaceRef;
  executorName?: string;
  runtime?: ExecutorRuntimeOptions;
  expectedIntegration?: ExecutorIntegrationName;
}): ExecutorAdapter {
  return {
    async runBlock({ claim, prompt, executionWaveId }) {
      const { name, profile, source } = await resolveProfileForClaim({
        projectRoot: options.projectRoot,
        claim,
        executorName: options.executorName
      });
      const integration = executorIntegrationForProfile(profile);
      if (options.expectedIntegration && integration !== options.expectedIntegration) {
        throw new Error(
          `Executor profile '${name}' uses integration '${integration}', not '${options.expectedIntegration}'.`
        );
      }
      await assertPackageExecutorCommandTrusted({
        projectRoot: options.projectRoot,
        executorName: name,
        profile: { ...profile, source }
      });
      return runProfileBlock({
        projectRoot: options.projectRoot,
        claim,
        prompt,
        executorName: name,
        profile,
        profileSource: source,
        ...(executionWaveId !== undefined
          ? { executionWaveId: executionWaveIdSchema.parse(executionWaveId) }
          : {}),
        runtime: options.runtime
      });
    },
    async runFeedback({ claim }) {
      const { manifest, workspace } = await loadPackage(options.projectRoot);
      const name = options.executorName ?? claim.effectiveExecutor;
      const profile = profilesByName(manifest)[name];
      if (!profile) {
        throw new Error(`Executor profile '${name}' does not exist.`);
      }
      const integration = executorIntegrationForProfile(profile);
      if (options.expectedIntegration && integration !== options.expectedIntegration) {
        throw new Error(
          `Executor profile '${name}' uses integration '${integration}', not '${options.expectedIntegration}'.`
        );
      }
      await assertPackageExecutorCommandTrusted({
        projectRoot: options.projectRoot,
        executorName: name,
        profile: { ...profile, source: profileSource(manifest, name) }
      });
      return runProfileFeedback({
        projectRoot: options.projectRoot,
        workspace,
        claim,
        executorName: name,
        profile,
        profileSource: profileSource(manifest, name),
        runtime: options.runtime
      });
    }
  };
}

export function createManualExecutorAdapter(options: {
  projectRoot: PackageWorkspaceRef;
  executorName?: string;
  runtime?: ExecutorRuntimeOptions;
}): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedIntegration: "manual" });
}

export function createCodexExecAdapter(options: {
  projectRoot: PackageWorkspaceRef;
  executorName?: string;
  runtime?: ExecutorRuntimeOptions;
}): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedIntegration: "codex-exec" });
}

export function createOpencodeExecAdapter(options: {
  projectRoot: PackageWorkspaceRef;
  executorName?: string;
  runtime?: ExecutorRuntimeOptions;
}): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedIntegration: "opencode-exec" });
}

export function createClaudeCodeExecAdapter(options: {
  projectRoot: PackageWorkspaceRef;
  executorName?: string;
  runtime?: ExecutorRuntimeOptions;
}): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedIntegration: "claude-code-exec" });
}

export function createPiExecAdapter(options: {
  projectRoot: PackageWorkspaceRef;
  executorName?: string;
  runtime?: ExecutorRuntimeOptions;
}): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedIntegration: "pi-exec" });
}

export function createLocalReviewAdapter(options: {
  projectRoot: PackageWorkspaceRef;
  executorName?: string;
  runtime?: ExecutorRuntimeOptions;
}): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedIntegration: "local-review" });
}

export function createExecutorAdapter(options: {
  projectRoot: PackageWorkspaceRef;
  executorName?: string;
  runtime?: ExecutorRuntimeOptions;
}): ExecutorAdapter {
  return createProfiledAdapter(options);
}

export function listExecutorProfilesForManifest(
  manifest: PlanPackageManifest
): ProducedExecutorProfileSummary[] {
  const packageProfiles = manifest.executors ?? {};
  const summaries: ProducedExecutorProfileSummary[] = Object.entries(
    applyDesktopAgentSettingsToBuiltinProfiles(builtinExecutorProfiles)
  ).map(([name, profile]) => summarizeExecutorProfile(name, "builtin", profile));
  for (const [name, profile] of Object.entries(packageProfiles)) {
    const existing = summaries.findIndex((summary) => summary.name === name);
    const summary = summarizeExecutorProfile(name, "package", profile);
    if (existing >= 0) {
      summaries[existing] = summary;
    } else {
      summaries.push(summary);
    }
  }
  return summaries;
}

function summarizeExecutorProfile(
  name: string,
  source: "builtin" | "package",
  profile: ExecutorProfile
): ProducedExecutorProfileSummary {
  const executionIntegration = executorIntegrationForProfile(profile);
  if (profile.adapter === "manual") {
    return {
      ...profile,
      name,
      source,
      adapter: "manual",
      profileAdapter: "manual",
      executionIntegration,
      agentId: null,
      runnerKind: null
    };
  }
  if (profile.adapter === "local-review") {
    return {
      ...profile,
      name,
      source,
      adapter: "local-review",
      profileAdapter: "local-review",
      executionIntegration,
      agentId: null,
      runnerKind: null
    };
  }
  return {
    ...profile,
    name,
    source,
    adapter: executionIntegration ?? "agent",
    profileAdapter: "agent",
    executionIntegration,
    agentId: profile.agent,
    runnerKind: profile.runner.transport,
    ...(profile.runner.transport === "acp"
      ? {
          acpLaunch: resolveAgentDefinition(profile.agent).acp.launch,
          staticCapabilities: resolveAgentDefinition(profile.agent).acp.capabilities,
          optionalCapabilities: resolveAgentDefinition(profile.agent).acp.optionalCapabilities,
          limitations: resolveAgentDefinition(profile.agent).acp.limitations
        }
      : {})
  };
}

type ProducedExecutorProfileSummary = ExecutorProfileSummary & {
  profileAdapter: ExecutorProfileAdapter;
  executionIntegration: ExecutorIntegrationName | null;
};

export async function listExecutorProfiles(options: {
  projectRoot: PackageWorkspaceRef;
}): Promise<ProducedExecutorProfileSummary[]> {
  const { manifest } = await loadPackage(options.projectRoot);
  return listExecutorProfilesForManifest(manifest);
}

export async function resolveExecutorRunnerEvidence(options: {
  projectRoot: PackageWorkspaceRef;
  executorName: string;
}): Promise<AutoRunRunnerEvidence> {
  const { manifest } = await loadPackage(options.projectRoot);
  return executorRunnerEvidenceForManifest(manifest, options.executorName);
}

export function executorRunnerEvidenceForManifest(
  manifest: PlanPackageManifest,
  executorName: string
): AutoRunRunnerEvidence {
  const profile = profilesByName(manifest)[executorName];
  return {
    effectiveExecutor: executorName,
    agentId: profile?.adapter === "agent" ? profile.agent : null,
    runnerKind: profile?.adapter === "agent" ? profile.runner.transport : null
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function skippedCheck(
  check: ExecutorPreflightCheck["check"],
  message: string
): ExecutorPreflightCheck {
  return { check, status: "skipped", message };
}

function finalizePreflightResult(options: {
  name: string;
  profileAdapter: ExecutorProfileAdapter | null;
  executionIntegration: ExecutorIntegrationName | null;
  checks: ExecutorPreflightCheck[];
  successMessage: string;
  agentId?: ExecutorPreflightResultIdentity["agentId"];
  runnerKind?: ExecutorPreflightResultIdentity["runnerKind"];
  agentInfo?: ProducedExecutorPreflightResult["agentInfo"];
  authentication?: ProducedExecutorPreflightResult["authentication"];
  capabilities?: ProducedExecutorPreflightResult["capabilities"];
  sessionConfig?: ProducedExecutorPreflightResult["sessionConfig"];
}): ProducedExecutorPreflightResult {
  const failed = options.checks.find((check) => check.status === "failed");
  return producedExecutorPreflightResultSchema.parse({
    name: options.name,
    adapter: options.executionIntegration ?? options.profileAdapter,
    profileAdapter: options.profileAdapter,
    executionIntegration: options.executionIntegration,
    agentId: options.agentId ?? null,
    runnerKind: options.runnerKind ?? null,
    failureCode: failed?.failureCode ?? null,
    agentInfo: options.agentInfo ?? null,
    authentication: options.authentication ?? null,
    capabilities: options.capabilities ?? null,
    sessionConfig: options.sessionConfig ?? null,
    ok: failed === undefined,
    message: failed?.message ?? options.successMessage,
    checks: options.checks
  });
}

type ExecutorPreflightResultIdentity = Pick<
  ProducedExecutorPreflightResult,
  "agentId" | "runnerKind"
>;

export async function testExecutorProfile(options: {
  projectRoot: PackageWorkspaceRef;
  executorName: string;
  versionTimeoutMs?: number;
}): Promise<ProducedExecutorPreflightResult> {
  let workspace: ProjectWorkspace;
  let cwdCheck: ExecutorPreflightCheck;
  try {
    workspace = await resolvePackageWorkspace(options.projectRoot);
    const executionCwd = workspaceExecutionCwd(workspace);
    cwdCheck = {
      check: "cwd_resolved",
      status: "passed",
      message: `Project cwd resolved to '${executionCwd}'.`,
      cwd: executionCwd
    };
  } catch (error) {
    return finalizePreflightResult({
      name: options.executorName,
      profileAdapter: null,
      executionIntegration: null,
      successMessage: "executor preflight passed",
      checks: [
        skippedCheck(
          "profile_exists",
          "Project cwd could not be resolved before loading executor profiles."
        ),
        skippedCheck(
          "adapter_supported",
          "Project cwd could not be resolved before checking the execution integration."
        ),
        {
          check: "cwd_resolved",
          status: "failed",
          message: `Project cwd could not be resolved: ${errorMessage(error)}`
        },
        skippedCheck(
          "command_started",
          "Project cwd could not be resolved before starting the command."
        ),
        skippedCheck(
          "command_version",
          "Project cwd could not be resolved before checking command version."
        )
      ]
    });
  }

  const { manifest } = await loadPackage(workspace);
  const profile = profilesByName(manifest)[options.executorName];
  if (!profile) {
    return finalizePreflightResult({
      name: options.executorName,
      profileAdapter: null,
      executionIntegration: null,
      successMessage: "executor preflight passed",
      checks: [
        {
          check: "profile_exists",
          status: "failed",
          failureCode: "invalid_profile",
          message: `Executor profile '${options.executorName}' does not exist.`
        },
        skippedCheck("adapter_supported", "Executor profile does not exist."),
        cwdCheck,
        skippedCheck("command_started", "Executor profile does not exist."),
        skippedCheck("command_version", "Executor profile does not exist.")
      ]
    });
  }

  const profileCheck: ExecutorPreflightCheck = {
    check: "profile_exists",
    status: "passed",
    message: `Executor profile '${options.executorName}' exists.`
  };
  let executionIntegration: ExecutorIntegrationName;
  let integrationCheck: ExecutorPreflightCheck;
  if (profile.adapter === "agent") {
    const runner = resolveAgentRunner(profile);
    const definition = resolveAgentDefinition(profile.agent);
    const availability = runner.availability(definition);
    const preflightTimeoutMs =
      options.versionTimeoutMs ??
      (profile.runner.transport === "acp"
        ? executorPreflightAcpSessionProbeTimeoutMs
        : executorPreflightVersionTimeoutMs);
    if ("command" in profile) {
      try {
        await assertPackageExecutorCommandTrusted({
          projectRoot: workspace,
          executorName: options.executorName,
          profile: { ...profile, source: profileSource(manifest, options.executorName) }
        });
      } catch (error) {
        return finalizePreflightResult({
          name: options.executorName,
          profileAdapter: profile.adapter,
          executionIntegration: availability.integration,
          agentId: profile.agent,
          runnerKind: profile.runner.transport,
          successMessage: "executor preflight passed",
          checks: [
            profileCheck,
            {
              check: "adapter_supported",
              status: availability.supported ? "passed" : "failed",
              message: availability.message
            },
            cwdCheck,
            {
              check: "command_started",
              status: "failed",
              message: errorMessage(error),
              command: profile.command,
              cwd: workspaceExecutionCwd(workspace)
            },
            skippedCheck("command_version", "Executor command is not trusted on this machine.")
          ]
        });
      }
    } else if (definition.acp.launch) {
      const launch = definition.acp.launch;
      try {
        await assertAcpLaunchTrusted({
          projectRoot: workspace,
          executorName: options.executorName,
          definition,
          profileSource: profileSource(manifest, options.executorName)
        });
      } catch (error) {
        return finalizePreflightResult({
          name: options.executorName,
          profileAdapter: profile.adapter,
          executionIntegration: availability.integration,
          agentId: profile.agent,
          runnerKind: profile.runner.transport,
          successMessage: "executor preflight passed",
          checks: [
            profileCheck,
            { check: "adapter_supported", status: "passed", message: availability.message },
            cwdCheck,
            {
              check: "command_started",
              status: "failed",
              message: errorMessage(error),
              command: launch.command,
              cwd: workspaceExecutionCwd(workspace)
            },
            skippedCheck("command_version", "Executor command is not trusted on this machine.")
          ]
        });
      }
    }
    const runnerResult = await runner.preflight({
      profile,
      profileSource: profileSource(manifest, options.executorName),
      definition,
      cwd: workspaceExecutionCwd(workspace),
      timeoutMs: preflightTimeoutMs
    });
    return finalizePreflightResult({
      name: options.executorName,
      profileAdapter: profile.adapter,
      executionIntegration: runnerResult.executionIntegration,
      agentId: profile.agent,
      runnerKind: profile.runner.transport,
      agentInfo: runnerResult.agentInfo ?? null,
      authentication: runnerResult.authentication ?? null,
      capabilities:
        runnerResult.availableCapabilities ??
        runnerResult.negotiatedCapabilities?.available ??
        null,
      sessionConfig: runnerResult.sessionConfig ?? null,
      successMessage: `${profile.runner.transport.toUpperCase()} runner preflight passed.`,
      checks: [
        profileCheck,
        {
          check: "adapter_supported",
          status: availability.supported ? "passed" : "failed",
          message: availability.message,
          ...(availability.supported ? {} : { failureCode: "initialization_failed" as const })
        },
        cwdCheck,
        ...runnerResult.checks
      ]
    });
  } else {
    executionIntegration = requireExecutorIntegration(profile);
    integrationCheck = isSupportedExecutionIntegration(executionIntegration)
      ? {
          check: "adapter_supported",
          status: "passed",
          message: `Executor integration '${executionIntegration}' is supported.`
        }
      : {
          check: "adapter_supported",
          status: "failed",
          message: `Executor integration '${executionIntegration}' is not supported.`
        };
  }
  if (integrationCheck.status === "failed") {
    return finalizePreflightResult({
      name: options.executorName,
      profileAdapter: profile.adapter,
      executionIntegration,
      successMessage: "executor preflight passed",
      checks: [
        profileCheck,
        integrationCheck,
        cwdCheck,
        skippedCheck("command_started", "Executor integration is not supported."),
        skippedCheck("command_version", "Executor integration is not supported.")
      ]
    });
  }
  if (profile.adapter === "manual") {
    return finalizePreflightResult({
      name: options.executorName,
      profileAdapter: profile.adapter,
      executionIntegration,
      successMessage: "manual executor does not require a command",
      checks: [
        profileCheck,
        integrationCheck,
        cwdCheck,
        skippedCheck("command_started", "Manual executor does not require a command."),
        skippedCheck("command_version", "Manual executor does not require a command.")
      ]
    });
  }

  let result;
  const versionTimeoutMs = options.versionTimeoutMs ?? executorPreflightVersionTimeoutMs;
  const limits = executorRuntimeLimits({ ...profile, timeoutMs: versionTimeoutMs });
  const executionCwd = workspaceExecutionCwd(workspace);
  try {
    await assertPackageExecutorCommandTrusted({
      projectRoot: workspace,
      executorName: options.executorName,
      profile: { ...profile, source: profileSource(manifest, options.executorName) }
    });
  } catch (error) {
    return finalizePreflightResult({
      name: options.executorName,
      profileAdapter: profile.adapter,
      executionIntegration,
      successMessage: "executor preflight passed",
      checks: [
        profileCheck,
        integrationCheck,
        cwdCheck,
        {
          check: "command_started",
          status: "failed",
          message: errorMessage(error),
          command: profile.command,
          cwd: executionCwd
        },
        skippedCheck("command_version", "Executor command is not trusted on this machine.")
      ]
    });
  }
  try {
    result = await execWithStdin({
      command: profile.command,
      args: ["--version"],
      cwd: executionCwd,
      stdin: "",
      timeoutMs: limits.timeoutMs,
      maxStdoutBytes: limits.maxStdoutBytes,
      maxStderrBytes: limits.maxStderrBytes
    });
  } catch (error) {
    return finalizePreflightResult({
      name: options.executorName,
      profileAdapter: profile.adapter,
      executionIntegration,
      successMessage: "executor preflight passed",
      checks: [
        profileCheck,
        integrationCheck,
        cwdCheck,
        {
          check: "command_started",
          status: "failed",
          failureCode: executorSpawnFailureCode(error),
          message: `Command '${profile.command}' could not be started: ${errorMessage(error)}`,
          command: profile.command,
          cwd: executionCwd
        },
        skippedCheck("command_version", "Command could not be started.")
      ]
    });
  }

  const output = result.stdout.trim() || result.stderr.trim();
  const versionCheck: ExecutorPreflightCheck = result.limitExceeded
    ? {
        check: "command_version",
        status: "failed",
        failureCode: "initialization_failed",
        message: executorLimitFailureMessage({
          executorName: options.executorName,
          limitExceeded: result.limitExceeded
        }),
        command: profile.command,
        cwd: executionCwd,
        output,
        exitCode: result.exitCode,
        timedOut: false
      }
    : result.timedOut
      ? {
          check: "command_version",
          status: "failed",
          failureCode: "timeout",
          message: `Command version check timed out after ${versionTimeoutMs}ms.`,
          command: profile.command,
          cwd: executionCwd,
          output,
          exitCode: result.exitCode,
          timedOut: true
        }
      : result.exitCode === 0
        ? {
            check: "command_version",
            status: "passed",
            message: output || "Command version check completed successfully.",
            command: profile.command,
            cwd: executionCwd,
            output,
            exitCode: result.exitCode,
            timedOut: result.timedOut
          }
        : {
            check: "command_version",
            status: "failed",
            failureCode: "initialization_failed",
            message: output || `Command version check exited with code ${result.exitCode}.`,
            command: profile.command,
            cwd: executionCwd,
            output,
            exitCode: result.exitCode,
            timedOut: result.timedOut
          };
  return finalizePreflightResult({
    name: options.executorName,
    profileAdapter: profile.adapter,
    executionIntegration,
    successMessage: versionCheck.message,
    checks: [
      profileCheck,
      integrationCheck,
      cwdCheck,
      {
        check: "command_started",
        status: "passed",
        message: `Command '${profile.command}' started.`,
        command: profile.command,
        cwd: executionCwd
      },
      versionCheck
    ]
  });
}
