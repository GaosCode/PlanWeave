import { runAgentHostCli } from "@planweave-ai/agent-host";
import type { Command } from "commander";

type AgentHostCliIo = { stdout(value: string): void; stderr(value: string): void };

type AgentHostCliRunner = (
  argv: readonly string[],
  options: {
    io?: AgentHostCliIo;
    launcher: { executablePath: string; fixedArgs: readonly string[] };
    onShutdownRequiresProcessExit: (code: number) => void;
  }
) => Promise<number>;

type AgentHostCommandDependencies = {
  argv?: readonly string[];
  executablePath?: string;
  io?: AgentHostCliIo;
  run?: AgentHostCliRunner;
  setExitCode?: (code: number) => void;
};

function agentHostLauncher(
  argv: readonly string[],
  executablePath: string
): { executablePath: string; fixedArgs: readonly string[] } {
  const cliEntrypoint = argv[1];
  if (!cliEntrypoint) {
    throw new Error("planweave_cli_entrypoint_missing");
  }
  return {
    executablePath,
    fixedArgs: [cliEntrypoint, "agent-host"]
  };
}

export function registerAgentHostCommand(
  program: Command,
  dependencies: AgentHostCommandDependencies = {}
): void {
  const processArgv = dependencies.argv ?? process.argv;
  const executablePath = dependencies.executablePath ?? process.execPath;
  const run = dependencies.run ?? runAgentHostCli;
  const setExitCode = dependencies.setExitCode ?? ((code: number) => (process.exitCode = code));

  program
    .command("agent-host")
    .description("Register and operate a PlanWeave Agent Host")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument("[arguments...]")
    .action(async (args: string[]) => {
      const code = await run(args, {
        io: dependencies.io,
        launcher: agentHostLauncher(processArgv, executablePath),
        onShutdownRequiresProcessExit: process.exit
      });
      if (code !== 0) {
        setExitCode(code);
      }
    });
}
