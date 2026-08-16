import type { AgentHostComposition } from "../composition/agentHostComposition.js";
import type { AgentHostBackgroundLauncher } from "../background/backgroundService.js";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { runRealAcpSmokeCli } from "../realAcp/cli.js";
import {
  AgentHostOperator,
  type AgentExposureMutationResult,
  type PortableEnrollmentResult
} from "./agentHostOperator.js";

export type AgentHostCliIo = { stdout(value: string): void; stderr(value: string): void };

/** Public usage text for `planweave agent-host --help` (stdout, exit 0). */
export const AGENT_HOST_CLI_USAGE = [
  "Usage: planweave agent-host <command> [options]",
  "",
  "Commands:",
  "  config-init --config <absolute-path> --preset codex-acp",
  "  preflight --config <absolute-path>",
  "  enroll <handoff> [--expose <profile,...>] [--workspace-root <absolute-path>] [--ca-certificate <absolute-path>] [--no-background]",
  "  enroll --config <absolute-path> --code <enrollment-or-setup-code> [--replace]",
  "  agents list --config <absolute-path>",
  "  agents expose <supported-profile> --config <absolute-path>",
  "  agents hide <supported-profile> --config <absolute-path>",
  "  service install --config <absolute-path>",
  "  service uninstall --config <absolute-path>",
  "  service status --config <absolute-path>",
  "  service restart --config <absolute-path>",
  "  service logs --config <absolute-path>",
  "  status --config <absolute-path>",
  "  run --config <absolute-path>",
  "  revoke --config <absolute-path>",
  "  real-acp-smoke [options]"
].join("\n");

type ParsedCommand = {
  command:
    | "config-init"
    | "preflight"
    | "enroll"
    | "run"
    | "status"
    | "revoke"
    | "agents-list"
    | "agents-expose"
    | "agents-hide"
    | "service-install"
    | "service-uninstall"
    | "service-status"
    | "service-restart"
    | "service-logs";
  configPath?: string;
  code?: string;
  handoff?: string;
  workspaceRoot?: string;
  caCertificatePath?: string;
  installBackground?: boolean;
  exposeProfiles: string[];
  profileId?: string;
  preset?: "codex-acp";
  replace: boolean;
};

export interface AgentHostOperatorService {
  preflight(configPath: string): Promise<unknown>;
  enroll(configPath: string, code: string, replaceExisting?: boolean): Promise<unknown>;
  createDaemon(configPath: string): Promise<AgentHostComposition>;
  initializePreset(configPath: string, presetId: string): Promise<unknown>;
  status(configPath: string): Promise<unknown>;
  revoke(configPath: string): Promise<unknown>;
  enrollHandoff(
    handoff: string,
    options: {
      workspaceRoot?: string;
      caCertificatePath?: string;
      installBackground?: boolean;
      executablePath?: string;
      fixedArgs?: readonly string[];
    }
  ): Promise<PortableEnrollmentResult>;
  listAgents(configPath: string): Promise<unknown>;
  reconcileAgentExposure(
    configPath: string,
    profileIds: readonly string[]
  ): Promise<AgentExposureMutationResult>;
  exposeAgent(configPath: string, profileId: string): Promise<AgentExposureMutationResult>;
  hideAgent(configPath: string, profileId: string): Promise<AgentExposureMutationResult>;
  installBackground(configPath: string, launcher: AgentHostBackgroundLauncher): Promise<unknown>;
  uninstallBackground(configPath: string): Promise<unknown>;
  backgroundStatus(configPath: string): Promise<unknown>;
  restartBackground(configPath: string): Promise<unknown>;
  backgroundLogs(configPath: string): Promise<unknown>;
}

function defaultAgentHostLauncher(): AgentHostBackgroundLauncher {
  return {
    executablePath: process.execPath,
    fixedArgs: [fileURLToPath(new URL("../bin.js", import.meta.url))]
  };
}

export function parseAgentHostArgs(argv: readonly string[]): ParsedCommand {
  const [command, ...args] = argv;
  if (command === "service") {
    const [action, configFlag, configPath, ...extra] = args;
    if (!action || !["install", "uninstall", "status", "restart", "logs"].includes(action)) {
      throw new Error("agent_host_cli_usage");
    }
    if (configFlag !== "--config" || !configPath || configPath.startsWith("--")) {
      throw new Error("agent_host_cli_config_required");
    }
    if (extra.length > 0) throw new Error("agent_host_cli_usage");
    if (!isAbsolute(configPath)) throw new Error("agent_host_cli_config_absolute_required");
    return {
      command: `service-${action}` as ParsedCommand["command"],
      configPath,
      exposeProfiles: [],
      replace: false
    };
  }
  if (command === "agents") {
    const [action, profileOrOption, ...tail] = args;
    const profileId = action === "list" ? undefined : profileOrOption;
    const options = action === "list" ? args.slice(1) : tail;
    if (!action || !["list", "expose", "hide"].includes(action)) {
      throw new Error("agent_host_cli_usage");
    }
    if (action !== "list" && (!profileId || profileId.startsWith("--"))) {
      throw new Error("agent_host_cli_agent_profile_required");
    }
    if (options.length !== 2 || options[0] !== "--config" || !options[1]) {
      throw new Error("agent_host_cli_config_required");
    }
    return {
      command: `agents-${action}` as ParsedCommand["command"],
      configPath: options[1],
      profileId,
      exposeProfiles: [],
      replace: false
    };
  }
  if (
    !command ||
    !["config-init", "preflight", "enroll", "run", "status", "revoke"].includes(command)
  ) {
    throw new Error("agent_host_cli_usage");
  }
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const configPath = option("--config");
  const code = option("--code");
  const preset = option("--preset");
  const expose = option("--expose");
  const portableEnrollment = command === "enroll" && args[0] && !args[0].startsWith("--");
  if (!portableEnrollment && !configPath) throw new Error("agent_host_cli_config_required");
  if (command === "enroll" && !portableEnrollment && !code) {
    throw new Error("agent_host_cli_enrollment_code_required");
  }
  if (command === "config-init" && preset !== "codex-acp") {
    throw new Error("agent_host_cli_preset_required");
  }
  if (
    (command !== "enroll" && (code || args.includes("--replace"))) ||
    (command !== "config-init" && preset)
  ) {
    throw new Error("agent_host_cli_usage");
  }
  const known = new Set([
    "--config",
    "--code",
    "--preset",
    "--replace",
    "--workspace-root",
    "--ca-certificate",
    "--expose",
    "--no-background",
    "--background-instance"
  ]);
  for (let index = portableEnrollment ? 1 : 0; index < args.length; index++) {
    const value = args[index];
    if (!known.has(value)) throw new Error("agent_host_cli_usage");
    if (value !== "--replace" && value !== "--no-background") {
      index++;
    }
  }
  if (portableEnrollment && (configPath || code || preset || args.includes("--replace"))) {
    throw new Error("agent_host_cli_usage");
  }
  if (
    (!portableEnrollment && args.includes("--expose")) ||
    (args.includes("--expose") && (!expose || expose.startsWith("--")))
  ) {
    throw new Error("agent_host_cli_usage");
  }
  if (args.includes("--background-instance") && command !== "run") {
    throw new Error("agent_host_cli_usage");
  }
  const backgroundInstance = option("--background-instance");
  if (
    args.includes("--background-instance") &&
    (!backgroundInstance || !/^[a-f0-9]{16}$/u.test(backgroundInstance))
  ) {
    throw new Error("agent_host_cli_usage");
  }
  const exposeProfiles = [
    ...new Set(
      (expose ?? "")
        .split(",")
        .map((profileId) => profileId.trim())
        .filter(Boolean)
    )
  ];
  if (args.includes("--expose") && exposeProfiles.length === 0) {
    throw new Error("agent_host_cli_usage");
  }
  return {
    command: command as ParsedCommand["command"],
    configPath,
    code,
    handoff: portableEnrollment ? args[0] : undefined,
    workspaceRoot: option("--workspace-root"),
    caCertificatePath: option("--ca-certificate"),
    installBackground: portableEnrollment ? !args.includes("--no-background") : undefined,
    exposeProfiles: portableEnrollment ? exposeProfiles : [],
    preset: preset === "codex-acp" ? preset : undefined,
    replace: args.includes("--replace")
  };
}

export async function waitForAgentHostSignal(
  composition: AgentHostComposition,
  processLike: Pick<NodeJS.Process, "once" | "off">
): Promise<void> {
  let resolveSignal!: () => void;
  const signal = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const stop = () => resolveSignal();
  let terminal = false;
  let unsubscribe = () => {};
  const terminalFailure = new Promise<never>((_resolve, reject) => {
    unsubscribe = composition.subscribeStatus((status) => {
      if (status.state === "auth-failed") {
        terminal = true;
        unsubscribe();
        reject(new Error("agent_host_auth_failed"));
      } else if (status.state === "reconciliation-required") {
        terminal = true;
        unsubscribe();
        reject(new Error("agent_host_mailbox_reconciliation_required"));
      } else if (status.state === "degraded") {
        terminal = true;
        unsubscribe();
        reject(new Error("agent_host_transport_degraded"));
      }
    });
    if (terminal) unsubscribe();
  });
  processLike.once("SIGINT", stop);
  processLike.once("SIGTERM", stop);
  try {
    await composition.start();
    await Promise.race([signal, terminalFailure]);
  } finally {
    unsubscribe();
    processLike.off("SIGINT", stop);
    processLike.off("SIGTERM", stop);
    await composition.shutdown();
  }
}

export async function runAgentHostCli(
  argv: readonly string[],
  options: {
    operator?: AgentHostOperatorService;
    io?: AgentHostCliIo;
    processLike?: Pick<NodeJS.Process, "once" | "off">;
    env?: Readonly<Record<string, string | undefined>>;
    launcher?: AgentHostBackgroundLauncher;
  } = {}
): Promise<number> {
  const io = options.io ?? { stdout: console.log, stderr: console.error };
  try {
    if (argv[0] === "--help" || argv[0] === "-h") {
      io.stdout(AGENT_HOST_CLI_USAGE);
      return 0;
    }
    if (argv[0] === "real-acp-smoke") {
      return await runRealAcpSmokeCli(argv.slice(1), { io, env: options.env });
    }
    const parsed = parseAgentHostArgs(argv);
    const operator = options.operator ?? new AgentHostOperator();
    if (parsed.command === "run") {
      if (!parsed.configPath) throw new Error("agent_host_cli_config_required");
      await waitForAgentHostSignal(
        await operator.createDaemon(parsed.configPath),
        options.processLike ?? process
      );
      return 0;
    }
    let result: unknown;
    if (parsed.command === "service-install") {
      if (!parsed.configPath) throw new Error("agent_host_cli_config_required");
      result = await operator.installBackground(
        parsed.configPath,
        options.launcher ?? defaultAgentHostLauncher()
      );
    } else if (parsed.command === "service-uninstall") {
      if (!parsed.configPath) throw new Error("agent_host_cli_config_required");
      result = await operator.uninstallBackground(parsed.configPath);
    } else if (parsed.command === "service-status") {
      if (!parsed.configPath) throw new Error("agent_host_cli_config_required");
      result = await operator.backgroundStatus(parsed.configPath);
    } else if (parsed.command === "service-restart") {
      if (!parsed.configPath) throw new Error("agent_host_cli_config_required");
      result = await operator.restartBackground(parsed.configPath);
    } else if (parsed.command === "service-logs") {
      if (!parsed.configPath) throw new Error("agent_host_cli_config_required");
      result = await operator.backgroundLogs(parsed.configPath);
    } else if (parsed.command === "agents-list") {
      if (!parsed.configPath) throw new Error("agent_host_cli_config_required");
      result = await operator.listAgents(parsed.configPath);
    } else if (parsed.command === "agents-expose" || parsed.command === "agents-hide") {
      if (!parsed.configPath) throw new Error("agent_host_cli_config_required");
      if (!parsed.profileId) throw new Error("agent_host_cli_agent_profile_required");
      result =
        parsed.command === "agents-expose"
          ? await operator.exposeAgent(parsed.configPath, parsed.profileId)
          : await operator.hideAgent(parsed.configPath, parsed.profileId);
    } else if (parsed.command === "config-init") {
      if (!parsed.configPath) throw new Error("agent_host_cli_config_required");
      if (!parsed.preset) throw new Error("agent_host_cli_preset_required");
      result = await operator.initializePreset(parsed.configPath, parsed.preset);
    } else if (parsed.command === "enroll") {
      if (parsed.handoff) {
        const launcher = options.launcher ?? {
          executablePath: process.execPath,
          fixedArgs: process.argv[1] ? [process.argv[1]] : []
        };
        const enrollment = await operator.enrollHandoff(parsed.handoff, {
          workspaceRoot: parsed.workspaceRoot,
          caCertificatePath: parsed.caCertificatePath,
          installBackground: parsed.installBackground,
          executablePath: launcher.executablePath,
          fixedArgs: launcher.fixedArgs
        });
        result =
          parsed.exposeProfiles.length > 0
            ? {
                ...enrollment,
                agents: (
                  await operator.reconcileAgentExposure(
                    enrollment.configPath,
                    parsed.exposeProfiles
                  )
                ).agents
              }
            : enrollment;
      } else {
        if (!parsed.configPath) throw new Error("agent_host_cli_config_required");
        if (!parsed.code) throw new Error("agent_host_cli_enrollment_code_required");
        result = await operator.enroll(parsed.configPath, parsed.code, parsed.replace);
      }
    } else if (parsed.command === "revoke") {
      if (!parsed.configPath) throw new Error("agent_host_cli_config_required");
      result = await operator.revoke(parsed.configPath);
    } else if (parsed.command === "preflight") {
      if (!parsed.configPath) throw new Error("agent_host_cli_config_required");
      result = await operator.preflight(parsed.configPath);
    } else {
      if (!parsed.configPath) throw new Error("agent_host_cli_config_required");
      result = await operator.status(parsed.configPath);
    }
    io.stdout(JSON.stringify(result));
    return 0;
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":", 1)[0] : "agent_host_failed";
    io.stderr(code.startsWith("agent_host_") ? code : "agent_host_failed");
    return code.startsWith("agent_host_cli_") ? 2 : 1;
  }
}
