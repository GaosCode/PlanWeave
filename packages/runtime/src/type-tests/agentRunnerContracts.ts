import type {
  AcpAgentRunner,
  AgentAcpBlockInput,
  AgentCliBlockInput,
  CliAgentRunner
} from "../autoRun/agentRunner.js";

declare const acpRunner: AcpAgentRunner;
declare const cliRunner: CliAgentRunner;
declare const acpInput: AgentAcpBlockInput;
declare const cliInput: AgentCliBlockInput;

void cliRunner.runBlock;
void cliInput.runtime?.tmuxEnabled;

void acpRunner.runBlock;

void acpInput.runtime?.signal;
void acpInput.runtime?.desktopRunId;

// @ts-expect-error ACP runner does not expose CLI process execution.
void acpRunner.executeProcess;

// @ts-expect-error ACP runner configuration cannot select tmux.
void acpInput.profile.runner.tmuxEnabled;
