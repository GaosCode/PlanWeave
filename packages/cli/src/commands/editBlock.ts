import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import { editBlock } from "@planweave-ai/runtime";
import type { ReviewHookDefinition } from "@planweave-ai/runtime";
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

function parseBoolean(value: string, optionName: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${optionName} must be true or false.`);
}

function parseNonNegativeInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be a non-negative integer.`);
  }
  return parsed;
}

function parseLocks(value: string): string[] {
  if (value.trim() === "") {
    return [];
  }
  return value.split(",").map((item) => item.trim());
}

async function reviewHook(options: {
  reviewHookJson?: string;
  clearReviewHook?: boolean;
}): Promise<ReviewHookDefinition | null | undefined> {
  if (options.reviewHookJson !== undefined && options.clearReviewHook) {
    throw new Error("Use either --review-hook-json or --clear-review-hook, not both.");
  }
  if (options.clearReviewHook) {
    return null;
  }
  if (options.reviewHookJson !== undefined) {
    return JSON.parse(
      await readFile(resolve(options.reviewHookJson), "utf8")
    ) as ReviewHookDefinition;
  }
  return undefined;
}

export function registerEditBlockCommand(program: Command): void {
  addCanvasOption(
    program
      .command("edit-block")
      .argument("<block-ref>")
      .description("Edit one block by exact task#block ref")
      .option("--title <title>", "set block title")
      .option("--prompt <markdown>", "set block prompt markdown directly")
      .option("--prompt-file <path>", "read block prompt markdown from a file")
      .option("--executor <name>", "set block executor")
      .option("--clear-executor", "remove block executor")
      .option(
        "--exclusive <true|false>",
        "set reserved exclusive lock (true = locks include exclusive)"
      )
      .option(
        "--parallel-safe <true|false>",
        "deprecated alias of --exclusive with inverted boolean (false ⇒ exclusive)"
      )
      .option(
        "--parallel-locks <locks>",
        "set implementation parallel locks as a comma-separated list"
      )
      .option(
        "--shared-resources <resources>",
        "set non-blocking shared resource hints as a comma-separated list"
      )
      .option("--review-required <true|false>", "set whether a review block is required")
      .option("--max-feedback-cycles <count>", "set review max feedback cycles")
      .option("--review-hook-json <path>", "read review hook JSON from a file")
      .option("--clear-review-hook", "remove review hook")
  ).action(
    async (
      ref: string,
      options: {
        title?: string;
        prompt?: string;
        promptFile?: string;
        executor?: string;
        clearExecutor?: boolean;
        exclusive?: string;
        parallelSafe?: string;
        parallelLocks?: string;
        sharedResources?: string;
        reviewRequired?: string;
        maxFeedbackCycles?: string;
        reviewHookJson?: string;
        clearReviewHook?: boolean;
      } & CanvasCommandOptions
    ) => {
      if (options.executor !== undefined && options.clearExecutor) {
        throw new Error("Use either --executor or --clear-executor, not both.");
      }
      let exclusive: boolean | undefined =
        options.exclusive === undefined
          ? undefined
          : parseBoolean(options.exclusive, "--exclusive");
      let parallelSafe: boolean | undefined;
      if (options.parallelSafe !== undefined) {
        console.error(
          'Warning: --parallel-safe is deprecated; use --exclusive <true|false> (or locks: ["exclusive"]).'
        );
        const safe = parseBoolean(options.parallelSafe, "--parallel-safe");
        if (exclusive === undefined) {
          exclusive = !safe;
        }
        parallelSafe = safe;
      }
      const result = await editBlock({
        projectRoot: await resolveCliPackageWorkspace(options),
        ref,
        title: options.title,
        promptMarkdown: await promptMarkdown(options),
        executor: options.clearExecutor ? null : options.executor,
        exclusive,
        parallelSafe,
        parallelLocks:
          options.parallelLocks === undefined ? undefined : parseLocks(options.parallelLocks),
        sharedResources:
          options.sharedResources === undefined ? undefined : parseLocks(options.sharedResources),
        reviewRequired:
          options.reviewRequired === undefined
            ? undefined
            : parseBoolean(options.reviewRequired, "--review-required"),
        maxFeedbackCycles:
          options.maxFeedbackCycles === undefined
            ? undefined
            : parseNonNegativeInteger(options.maxFeedbackCycles, "--max-feedback-cycles"),
        reviewHook: await reviewHook(options)
      });
      const { graph: _graph, ...serializable } = result;
      console.log(JSON.stringify(serializable, null, 2));
    }
  );
}
