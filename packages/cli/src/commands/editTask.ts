import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import { editTask } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

async function promptMarkdown(options: {
  prompt?: string;
  promptFile?: string;
}): Promise<string | undefined> {
  if (options.prompt !== undefined && options.promptFile !== undefined) {
    throw new Error("Use either --prompt or --prompt-file, not both.");
  }
  if (options.promptFile !== undefined) {
    return readFile(resolve(options.promptFile), "utf8");
  }
  return options.prompt;
}

export function registerEditTaskCommand(program: Command): void {
  addCanvasOption(
    program
      .command("edit-task")
      .argument("<task-id>")
      .description("Edit one task by exact task id")
      .option("--title <title>", "set task title")
      .option("--prompt <markdown>", "set task prompt markdown directly")
      .option("--prompt-file <path>", "read task prompt markdown from a file")
      .option("--executor <name>", "set task executor")
      .option("--clear-executor", "remove task executor")
  ).action(
    async (
      taskId: string,
      options: {
        title?: string;
        prompt?: string;
        promptFile?: string;
        executor?: string;
        clearExecutor?: boolean;
      } & CanvasCommandOptions
    ) => {
      if (options.executor !== undefined && options.clearExecutor) {
        throw new Error("Use either --executor or --clear-executor, not both.");
      }
      const result = await editTask({
        projectRoot: await resolveCliPackageWorkspace(options),
        taskId,
        title: options.title,
        promptMarkdown: await promptMarkdown(options),
        executor: options.clearExecutor ? null : options.executor
      });
      const { graph: _graph, ...serializable } = result;
      console.log(JSON.stringify(serializable, null, 2));
    }
  );
}
