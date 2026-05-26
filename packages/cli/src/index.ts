#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "node:module";
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
import { registerExplainCommand, registerWhyNotCommand } from "./commands/explain.js";
import { registerSubmitResultCommand } from "./commands/submitResult.js";
import { registerSubmitReviewCommand } from "./commands/submitReview.js";
import { registerSubmitFeedbackCommand } from "./commands/submitFeedback.js";
import { registerMarkDivergedCommand } from "./commands/markDiverged.js";
import { registerMarkBlockedCommand } from "./commands/markBlocked.js";
import { registerResolveDivergenceCommand } from "./commands/resolveDivergence.js";
import { registerUnblockCommand } from "./commands/unblock.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerPathsCommand } from "./commands/paths.js";
import { registerRunCommand } from "./commands/run.js";
import { registerExecutorsCommand } from "./commands/executors.js";
import { registerRunStatusCommand } from "./commands/runStatus.js";
import { registerHelpCommand } from "./commands/help.js";
import { registerSchemaCommand } from "./commands/schema.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

export function createProgram(): Command {
  const program = new Command();
  program
    .name("planweave")
    .description("PlanWeave CLI")
    .version(packageJson.version);
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
  registerResolveDivergenceCommand(program);
  registerUnblockCommand(program);
  registerStatusCommand(program);
  registerPathsCommand(program);
  registerRunCommand(program);
  registerExecutorsCommand(program);
  registerRunStatusCommand(program);
  registerSchemaCommand(program);
  registerHelpCommand(program);

  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await createProgram().parseAsync(process.argv);
}
