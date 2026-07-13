#!/usr/bin/env node
import { Command } from "commander";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { registerInitCommand } from "./commands/init.js";
import { registerValidateCommand } from "./commands/validate.js";
import { registerRefreshPromptCommand } from "./commands/refreshPrompt.js";
import { registerRefreshPromptsCommand } from "./commands/refreshPrompts.js";
import { registerPromptCommand } from "./commands/prompt.js";
import { registerClaimCommand } from "./commands/claim.js";
import { registerClaimTaskCommand } from "./commands/claimTask.js";
import { registerClaimNextCommand } from "./commands/claimNext.js";
import { registerCurrentCommand } from "./commands/current.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerEditBlockCommand } from "./commands/editBlock.js";
import { registerEditTaskCommand } from "./commands/editTask.js";
import { registerExplainCommand, registerWhyNotCommand } from "./commands/explain.js";
import { registerSubmitResultCommand } from "./commands/submitResult.js";
import { registerSubmitReviewCommand } from "./commands/submitReview.js";
import { registerSubmitFeedbackCommand } from "./commands/submitFeedback.js";
import { registerMarkDivergedCommand } from "./commands/markDiverged.js";
import { registerMarkBlockedCommand } from "./commands/markBlocked.js";
import { registerRetryReviewCommand } from "./commands/retryReview.js";
import { registerResolveDivergenceCommand } from "./commands/resolveDivergence.js";
import { registerUnblockCommand } from "./commands/unblock.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerPathsCommand } from "./commands/paths.js";
import { registerCanvasCommand } from "./commands/canvas.js";
import { registerUseCommand } from "./commands/use.js";
import { registerProjectGraphCommand } from "./commands/projectGraph.js";
import { registerGraphCommand } from "./commands/graph.js";
import { registerPackageDraftCommand } from "./commands/packageDraft.js";
import { registerPackageImportCommand } from "./commands/packageImport.js";
import { registerImportRecoveryCommand } from "./commands/importRecovery.js";
import { registerRunCommand } from "./commands/run.js";
import { registerResetCommand } from "./commands/reset.js";
import { registerRunSessionsCommands } from "./commands/runSessions.js";
import { registerExecutorsCommand } from "./commands/executors.js";
import { registerRunStatusCommand } from "./commands/runStatus.js";
import { registerHelpCommand } from "./commands/help.js";
import { registerSchemaCommand } from "./commands/schema.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerRemoteServerCommand } from "./commands/remoteServer.js";
import { registerRemoteTaskCommand } from "./commands/remoteTask.js";
import { registerRemoteMergeQueueCommand } from "./commands/remoteMergeQueue.js";
import { registerGitCommand } from "./commands/git.js";
import { registerGitHubCommand } from "./commands/github.js";
import { formatCliError } from "./errors.js";
import { addProjectRootOption } from "./projectRoot.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

export function createProgram(): Command {
  const program = new Command();
  addProjectRootOption(program
    .name("planweave")
    .description("PlanWeave CLI")
    .version(packageJson.version));
  program.addHelpCommand(false);

  registerInitCommand(program);
  registerValidateCommand(program);
  registerRefreshPromptCommand(program);
  registerRefreshPromptsCommand(program);
  registerClaimCommand(program);
  registerClaimTaskCommand(program);
  registerClaimNextCommand(program);
  registerExplainCommand(program);
  registerWhyNotCommand(program);
  registerCurrentCommand(program);
  registerDoctorCommand(program);
  registerPromptCommand(program);
  registerSubmitResultCommand(program);
  registerSubmitReviewCommand(program);
  registerSubmitFeedbackCommand(program);
  registerMarkDivergedCommand(program);
  registerMarkBlockedCommand(program);
  registerRetryReviewCommand(program);
  registerEditTaskCommand(program);
  registerEditBlockCommand(program);
  registerResolveDivergenceCommand(program);
  registerUnblockCommand(program);
  registerStatusCommand(program);
  registerPathsCommand(program);
  registerCanvasCommand(program);
  registerUseCommand(program);
  registerProjectGraphCommand(program);
  registerGraphCommand(program);
  registerPackageDraftCommand(program);
  registerPackageImportCommand(program);
  registerImportRecoveryCommand(program);
  registerResetCommand(program);
  registerRunCommand(program);
  registerRunSessionsCommands(program);
  registerExecutorsCommand(program);
  registerRunStatusCommand(program);
  registerSchemaCommand(program);
  registerMcpCommand(program);
  registerRemoteServerCommand(program);
  registerRemoteTaskCommand(program);
  registerRemoteMergeQueueCommand(program);
  registerGitCommand(program);
  registerGitHubCommand(program);
  registerHelpCommand(program);

  return program;
}

export function isCliEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) {
    return false;
  }

  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  try {
    await createProgram().parseAsync(process.argv);
  } catch (error) {
    if (process.env.PLANWEAVE_DEBUG === "1") {
      console.error(error);
    } else {
      console.error(formatCliError(error));
    }
    process.exitCode = 1;
  }
}
