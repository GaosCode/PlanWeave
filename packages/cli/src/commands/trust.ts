import type { Command } from "commander";
import {
  listExecutorProfiles,
  listTrustedCommands,
  loadPackage,
  parseBlockRef,
  trustCommand,
  type AgentFamily,
  type RunnerTransport,
  type TrustedCommand
} from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

type TrustJsonOptions = CanvasCommandOptions & {
  json?: boolean;
};

function printTrustOutput(value: unknown, json: boolean | undefined): void {
  console.log(json ? JSON.stringify(value, null, 2) : formatHuman(value));
}

function formatHuman(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "No trusted commands.";
    }
    return value
      .map((entry) => {
        const item = entry as TrustedCommand;
        return `${item.id.slice(0, 12)}…  ${item.command} ${item.args.join(" ")}`.trimEnd();
      })
      .join("\n");
  }
  if (value && typeof value === "object" && "entry" in value) {
    const trusted = value as {
      entry: TrustedCommand;
      executorName: string;
      agentId: AgentFamily | null;
      runnerKind: RunnerTransport | null;
    };
    return `Trusted: ${trusted.entry.command} ${trusted.entry.args.join(" ")} (executor=${trusted.executorName}, agent=${trusted.agentId ?? "none"}, runner=${trusted.runnerKind ?? "none"})`.trimEnd();
  }
  const entry = value as TrustedCommand;
  return `Trusted: ${entry.command} ${entry.args.join(" ")}`.trimEnd();
}

async function trustReviewHook(options: TrustJsonOptions, ref: string): Promise<TrustedCommand> {
  const projectRoot = await resolveCliPackageWorkspace(options);
  const { manifest } = await loadPackage(projectRoot);
  const { taskId, blockId } = parseBlockRef(ref);
  const task = manifest.nodes.find((node) => node.type === "task" && node.id === taskId);
  if (!task || task.type !== "task") {
    throw new Error(`Task '${taskId}' does not exist.`);
  }
  const block = task.blocks.find((item) => item.id === blockId);
  if (!block) {
    throw new Error(`Block '${ref}' does not exist.`);
  }
  if (block.type !== "review") {
    throw new Error(`Block '${ref}' is not a review block.`);
  }
  const hook = block.review.hook;
  if (!hook) {
    throw new Error(`Review block '${ref}' has no hook configured.`);
  }
  return trustCommand(projectRoot, hook.command, hook.args);
}

async function trustExecutorProfile(
  options: TrustJsonOptions,
  executorName: string
): Promise<{
  entry: TrustedCommand;
  executorName: string;
  agentId: AgentFamily | null;
  runnerKind: RunnerTransport | null;
}> {
  const projectRoot = await resolveCliPackageWorkspace(options);
  const profiles = await listExecutorProfiles({ projectRoot });
  const profile = profiles.find((item) => item.name === executorName);
  if (!profile) {
    throw new Error(`Executor profile '${executorName}' does not exist.`);
  }
  if (profile.adapter === "manual") {
    throw new Error(`Executor profile '${executorName}' does not define a command to trust.`);
  }
  const launch = "command" in profile ? profile : profile.acpLaunch;
  if (!launch) {
    throw new Error(`Executor profile '${executorName}' does not define a command to trust.`);
  }
  return {
    entry: await trustCommand(projectRoot, launch.command, [...launch.args]),
    executorName,
    agentId: profile.agentId ?? null,
    runnerKind: profile.runnerKind ?? null
  };
}

export function registerTrustCommand(program: Command): void {
  const trust = program
    .command("trust")
    .description("Approve local hook and executor commands for this project");

  addCanvasOption(
    trust
      .command("hook")
      .argument("<review-block-ref>", "review block ref whose hook command should be trusted")
      .option("--json", "print machine-readable output")
      .description("Trust the review hook command configured on a review block")
  ).action(async (ref: string, options: TrustJsonOptions) => {
    printTrustOutput(await trustReviewHook(options, ref), options.json);
  });

  addCanvasOption(
    trust
      .command("executor")
      .argument("<executor-name>", "executor profile whose command should be trusted")
      .option("--json", "print machine-readable output")
      .description("Trust the command configured on an executor profile")
  ).action(async (executorName: string, options: TrustJsonOptions) => {
    printTrustOutput(await trustExecutorProfile(options, executorName), options.json);
  });

  addCanvasOption(
    trust
      .command("list")
      .option("--json", "print machine-readable output")
      .description("List trusted hook and executor commands for this project")
  ).action(async (options: TrustJsonOptions) => {
    const projectRoot = await resolveCliPackageWorkspace(options);
    printTrustOutput(await listTrustedCommands(projectRoot), options.json);
  });
}
