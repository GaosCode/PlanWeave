import { basename } from "node:path";
import type { OpencodeExecExecutorProfile } from "../types.js";

export type OpencodeInvocation = {
  args: string[];
  stdin: string;
  jsonMode: boolean;
};

function hasOption(args: string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function optionValue(args: string[], name: string): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      return args[index + 1] ?? null;
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return null;
}

function withWorkingDirectory(args: string[], cwd: string): string[] {
  if (hasOption(args, "--dir")) {
    return args;
  }
  const next = [...args];
  const runIndex = next.indexOf("run");
  next.splice(runIndex + 1, 0, "--dir", cwd);
  return next;
}

function isDirectOpencodeRun(profile: OpencodeExecExecutorProfile): boolean {
  return basename(profile.command) === "opencode" && profile.args.includes("run");
}

export function opencodeInvocation(profile: OpencodeExecExecutorProfile, prompt: string, cwd: string): OpencodeInvocation {
  if (!isDirectOpencodeRun(profile)) {
    return { args: profile.args, stdin: prompt, jsonMode: false };
  }

  const args = withWorkingDirectory(profile.args, cwd);
  const runIndex = args.indexOf("run");
  const promptPlaceholderIndex = args.lastIndexOf("-");
  if (promptPlaceholderIndex > runIndex) {
    args[promptPlaceholderIndex] = prompt;
  } else {
    args.push(prompt);
  }
  return { args, stdin: "", jsonMode: optionValue(args, "--format") === "json" };
}
