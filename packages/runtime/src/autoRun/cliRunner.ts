import type { CliAgentRunner } from "./agentRunner.js";
import { runnerProfileMismatch } from "./agentRunner.js";
import { executeCliProcess, type CliProcessExecutor } from "./cliProcess.js";
import { executorSpawnFailureCode } from "./executorPreflightTypes.js";
import { execWithStdin, executorRuntimeLimits } from "./executorShared.js";

export function createCliRunner(options?: { executeProcess?: CliProcessExecutor }): CliAgentRunner {
  const executionContext = { executeProcess: options?.executeProcess ?? executeCliProcess };
  return {
    transport: "cli",
    availability(definition) {
      if (!definition.cli) {
        return {
          supported: false,
          integration: null,
          message: `CLI runner for agent '${definition.agent}' is not implemented.`
        };
      }
      return {
        supported: true,
        integration: definition.cli.integration,
        message: `Executor integration '${definition.cli.integration}' is supported.`
      };
    },
    async preflight({ profile, definition, cwd, timeoutMs }) {
      const availability = this.availability(definition);
      if (!availability.supported) {
        return {
          executionIntegration: null,
          negotiatedCapabilities: null,
          checks: [{ check: "adapter_supported", status: "failed", message: availability.message }]
        };
      }
      if (profile.runner.transport !== "cli" || !("command" in profile)) {
        return {
          executionIntegration: availability.integration,
          negotiatedCapabilities: null,
          checks: [
            {
              check: "command_started",
              status: "failed",
              failureCode: "missing_command",
              message: `CLI runner profile for agent '${profile.agent}' does not define a command.`
            }
          ]
        };
      }
      let result;
      try {
        const limits = executorRuntimeLimits({ ...profile, timeoutMs });
        result = await execWithStdin({
          command: profile.command,
          args: ["--version"],
          cwd,
          stdin: "",
          timeoutMs: limits.timeoutMs,
          maxStdoutBytes: limits.maxStdoutBytes,
          maxStderrBytes: limits.maxStderrBytes
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          executionIntegration: availability.integration,
          negotiatedCapabilities: null,
          checks: [
            {
              check: "command_started",
              status: "failed",
              failureCode: executorSpawnFailureCode(error),
              message: `Command '${profile.command}' could not be started: ${message}`,
              command: profile.command,
              cwd
            },
            {
              check: "command_version",
              status: "skipped",
              message: "Command could not be started."
            }
          ]
        };
      }
      const output = result.stdout.trim() || result.stderr.trim();
      return {
        executionIntegration: availability.integration,
        negotiatedCapabilities: null,
        checks: [
          {
            check: "command_started",
            status: "passed",
            message: `Command '${profile.command}' started.`,
            command: profile.command,
            cwd
          },
          result.timedOut
            ? {
                check: "command_version",
                status: "failed",
                failureCode: "timeout",
                message: `Command version check timed out after ${timeoutMs}ms.`,
                command: profile.command,
                cwd,
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
                  cwd,
                  output,
                  exitCode: result.exitCode,
                  timedOut: false
                }
              : {
                  check: "command_version",
                  status: "failed",
                  failureCode: "initialization_failed",
                  message: output || `Command version check exited with code ${result.exitCode}.`,
                  command: profile.command,
                  cwd,
                  output,
                  exitCode: result.exitCode,
                  timedOut: false
                }
        ]
      };
    },
    runBlock(input, definition) {
      if (
        input.profile.runner.transport !== "cli" ||
        input.profile.agent !== definition.agent ||
        !("command" in input.profile) ||
        !definition.cli
      ) {
        throw runnerProfileMismatch("cli", input.profile);
      }
      return definition.cli.runBlock(input, executionContext);
    },
    runFeedback(input, definition) {
      if (
        input.profile.runner.transport !== "cli" ||
        input.profile.agent !== definition.agent ||
        !("command" in input.profile) ||
        !definition.cli
      ) {
        throw runnerProfileMismatch("cli", input.profile);
      }
      return definition.cli.runFeedback(input, executionContext);
    }
  };
}

export const cliRunner = createCliRunner();
