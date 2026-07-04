import { loadPackage, resolvePackageWorkspace } from "../package/loadPackage.js";
import type { ExecutorPreflightCheck, ExecutorPreflightResult } from "./executorPreflightTypes.js";
import type {
  ExecutorAdapter,
  ExecutorProfile,
  ExecutorProfileSummary,
  ManifestTaskNode,
  PackageWorkspaceRef,
  PlanPackageManifest,
  ProjectWorkspace
} from "../types.js";
import { claudeCodeIntegration } from "./claudeCodeIntegration.js";
import { codexIntegration } from "./codexIntegration.js";
import { execWithStdin, executorLimitFailureMessage, executorRuntimeLimits, workspaceExecutionCwd, type BlockClaim } from "./executorShared.js";
import type { ExecutorIntegration, ExecutorRuntimeOptions } from "./executorIntegration.js";
import { localReviewIntegration } from "./localReviewIntegration.js";
import { manualIntegration } from "./manualExecutor.js";
import { opencodeIntegration } from "./opencodeIntegration.js";
import { piIntegration } from "./piIntegration.js";

const executorIntegrations: ExecutorIntegration[] = [
  manualIntegration,
  codexIntegration,
  opencodeIntegration,
  claudeCodeIntegration,
  piIntegration,
  localReviewIntegration
];

const builtinExecutors: Record<string, ExecutorProfile> = Object.assign({}, ...executorIntegrations.map((integration) => integration.builtinProfiles));
export const executorPreflightVersionTimeoutMs = 5_000;

function integrationForAdapter(adapter: ExecutorProfile["adapter"]): ExecutorIntegration {
  const integration = executorIntegrations.find((item) => item.adapter === adapter);
  if (!integration) {
    throw new Error(`Executor adapter '${adapter}' is not supported.`);
  }
  return integration;
}

function isSupportedAdapter(adapter: ExecutorProfile["adapter"]): boolean {
  return executorIntegrations.some((item) => item.adapter === adapter);
}

function taskNodeForClaim(manifest: PlanPackageManifest, claim: BlockClaim): ManifestTaskNode {
  const node = manifest.nodes.find((item) => item.type === "task" && item.id === claim.taskId);
  if (node?.type !== "task") {
    throw new Error(`Task '${claim.taskId}' does not exist.`);
  }
  return node;
}

function resolveBlockExecutorName(manifest: PlanPackageManifest, claim: BlockClaim, override?: string): string {
  const task = taskNodeForClaim(manifest, claim);
  const block = task.blocks.find((item) => item.id === claim.blockId);
  if (!block) {
    throw new Error(`Block '${claim.ref}' does not exist.`);
  }
  return override ?? block.executor ?? task.executor ?? manifest.execution.defaultExecutor ?? "default";
}

function profilesByName(manifest: PlanPackageManifest): Record<string, ExecutorProfile> {
  return {
    ...builtinExecutors,
    ...(manifest.executors ?? {})
  };
}

async function resolveProfileForClaim(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  executorName?: string;
}): Promise<{ name: string; profile: ExecutorProfile }> {
  const { manifest } = await loadPackage(options.projectRoot);
  const name = resolveBlockExecutorName(manifest, options.claim, options.executorName);
  const profile = profilesByName(manifest)[name];
  if (!profile) {
    throw new Error(`Executor profile '${name}' does not exist.`);
  }
  return { name, profile };
}

function createProfiledAdapter(options: {
  projectRoot: PackageWorkspaceRef;
  executorName?: string;
  runtime?: ExecutorRuntimeOptions;
  expectedAdapter?: ExecutorProfile["adapter"];
}): ExecutorAdapter {
  return {
    async runBlock({ claim, prompt }) {
      const { name, profile } = await resolveProfileForClaim({
        projectRoot: options.projectRoot,
        claim,
        executorName: options.executorName
      });
      if (options.expectedAdapter && profile.adapter !== options.expectedAdapter) {
        throw new Error(`Executor profile '${name}' is '${profile.adapter}', not '${options.expectedAdapter}'.`);
      }
      return integrationForAdapter(profile.adapter).runBlock({
        projectRoot: options.projectRoot,
        claim,
        prompt,
        executorName: name,
        profile,
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
      if (options.expectedAdapter && profile.adapter !== options.expectedAdapter) {
        throw new Error(`Executor profile '${name}' is '${profile.adapter}', not '${options.expectedAdapter}'.`);
      }
      return integrationForAdapter(profile.adapter).runFeedback({
        projectRoot: options.projectRoot,
        workspace,
        claim,
        executorName: name,
        profile,
        runtime: options.runtime
      });
    }
  };
}

export function createManualExecutorAdapter(options: { projectRoot: PackageWorkspaceRef; executorName?: string; runtime?: ExecutorRuntimeOptions }): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedAdapter: "manual" });
}

export function createCodexExecAdapter(options: { projectRoot: PackageWorkspaceRef; executorName?: string; runtime?: ExecutorRuntimeOptions }): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedAdapter: "codex-exec" });
}

export function createOpencodeExecAdapter(options: { projectRoot: PackageWorkspaceRef; executorName?: string; runtime?: ExecutorRuntimeOptions }): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedAdapter: "opencode-exec" });
}

export function createClaudeCodeExecAdapter(options: { projectRoot: PackageWorkspaceRef; executorName?: string; runtime?: ExecutorRuntimeOptions }): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedAdapter: "claude-code-exec" });
}

export function createPiExecAdapter(options: { projectRoot: PackageWorkspaceRef; executorName?: string; runtime?: ExecutorRuntimeOptions }): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedAdapter: "pi-exec" });
}

export function createLocalReviewAdapter(options: { projectRoot: PackageWorkspaceRef; executorName?: string; runtime?: ExecutorRuntimeOptions }): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedAdapter: "local-review" });
}

export function createExecutorAdapter(options: { projectRoot: PackageWorkspaceRef; executorName?: string; runtime?: ExecutorRuntimeOptions }): ExecutorAdapter {
  return createProfiledAdapter(options);
}

export function listExecutorProfilesForManifest(manifest: PlanPackageManifest): ExecutorProfileSummary[] {
  const packageProfiles = manifest.executors ?? {};
  const summaries: ExecutorProfileSummary[] = Object.entries(builtinExecutors).map(([name, profile]) => ({
    name,
    source: "builtin",
    ...profile
  }));
  for (const [name, profile] of Object.entries(packageProfiles)) {
    const existing = summaries.findIndex((summary) => summary.name === name);
    const summary: ExecutorProfileSummary = { name, source: "package", ...profile };
    if (existing >= 0) {
      summaries[existing] = summary;
    } else {
      summaries.push(summary);
    }
  }
  return summaries;
}

export async function listExecutorProfiles(options: { projectRoot: PackageWorkspaceRef }): Promise<ExecutorProfileSummary[]> {
  const { manifest } = await loadPackage(options.projectRoot);
  return listExecutorProfilesForManifest(manifest);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function skippedCheck(check: ExecutorPreflightCheck["check"], message: string): ExecutorPreflightCheck {
  return { check, status: "skipped", message };
}

function finalizePreflightResult(options: {
  name: string;
  adapter: ExecutorProfile["adapter"] | null;
  checks: ExecutorPreflightCheck[];
  successMessage: string;
}): ExecutorPreflightResult {
  const failed = options.checks.find((check) => check.status === "failed");
  return {
    name: options.name,
    adapter: options.adapter,
    ok: failed === undefined,
    message: failed?.message ?? options.successMessage,
    checks: options.checks
  };
}

export async function testExecutorProfile(options: {
  projectRoot: PackageWorkspaceRef;
  executorName: string;
  versionTimeoutMs?: number;
}): Promise<ExecutorPreflightResult> {
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
      adapter: null,
      successMessage: "executor preflight passed",
      checks: [
        skippedCheck("profile_exists", "Project cwd could not be resolved before loading executor profiles."),
        skippedCheck("adapter_supported", "Project cwd could not be resolved before checking the adapter."),
        {
          check: "cwd_resolved",
          status: "failed",
          message: `Project cwd could not be resolved: ${errorMessage(error)}`
        },
        skippedCheck("command_started", "Project cwd could not be resolved before starting the command."),
        skippedCheck("command_version", "Project cwd could not be resolved before checking command version.")
      ]
    });
  }

  const { manifest } = await loadPackage(workspace);
  const profiles = listExecutorProfilesForManifest(manifest);
  const profile = profiles.find((item) => item.name === options.executorName);
  if (!profile) {
    return finalizePreflightResult({
      name: options.executorName,
      adapter: null,
      successMessage: "executor preflight passed",
      checks: [
        {
          check: "profile_exists",
          status: "failed",
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
    message: `Executor profile '${profile.name}' exists.`
  };
  const adapterCheck: ExecutorPreflightCheck = isSupportedAdapter(profile.adapter)
    ? {
        check: "adapter_supported",
        status: "passed",
        message: `Executor adapter '${profile.adapter}' is supported.`
      }
    : {
        check: "adapter_supported",
        status: "failed",
        message: `Executor adapter '${profile.adapter}' is not supported.`
      };
  if (adapterCheck.status === "failed") {
    return finalizePreflightResult({
      name: profile.name,
      adapter: profile.adapter,
      successMessage: "executor preflight passed",
      checks: [
        profileCheck,
        adapterCheck,
        cwdCheck,
        skippedCheck("command_started", "Executor adapter is not supported."),
        skippedCheck("command_version", "Executor adapter is not supported.")
      ]
    });
  }
  if (profile.adapter === "manual") {
    return finalizePreflightResult({
      name: profile.name,
      adapter: profile.adapter,
      successMessage: "manual executor does not require a command",
      checks: [
        profileCheck,
        adapterCheck,
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
      name: profile.name,
      adapter: profile.adapter,
      successMessage: "executor preflight passed",
      checks: [
        profileCheck,
        adapterCheck,
        cwdCheck,
        {
          check: "command_started",
          status: "failed",
          message: `Command '${profile.command}' could not be started: ${errorMessage(error)}`,
          command: profile.command,
          cwd: executionCwd
        },
        skippedCheck("command_version", "Command could not be started.")
      ]
    });
  }

  const output = result.stdout.trim() || result.stderr.trim();
  const versionCheck: ExecutorPreflightCheck =
    result.limitExceeded
      ? {
          check: "command_version",
          status: "failed",
          message: executorLimitFailureMessage({ executorName: profile.name, limitExceeded: result.limitExceeded }),
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
          message: output || `Command version check exited with code ${result.exitCode}.`,
          command: profile.command,
          cwd: executionCwd,
          output,
          exitCode: result.exitCode,
          timedOut: result.timedOut
        };
  return {
    name: profile.name,
    adapter: profile.adapter,
    ok: versionCheck.status === "passed",
    message: versionCheck.message,
    checks: [
      profileCheck,
      adapterCheck,
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
  };
}
