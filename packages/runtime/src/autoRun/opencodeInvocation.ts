import { basename } from "node:path";
import type { OpencodeExecExecutorProfile } from "../types.js";

export type OpencodeInvocation = {
  args: string[];
  stdin: string;
  jsonMode: boolean;
  sessionId: string | null;
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

function shortOptionValue(args: string[], name: string): string | null {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      return args[index + 1] ?? null;
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

function withSandbox(args: string[], sandbox?: OpencodeExecExecutorProfile["sandbox"]): string[] {
  if (sandbox !== "danger-full-access" || hasOption(args, "--auto")) {
    return args;
  }
  const runIndex = args.indexOf("run");
  if (runIndex === -1) {
    return args;
  }
  const next = [...args];
  next.splice(runIndex + 1, 0, "--auto");
  return next;
}

function isDirectOpencodeRun(profile: OpencodeExecExecutorProfile): boolean {
  return basename(profile.command) === "opencode" && profile.args.includes("run");
}

export function opencodeInvocation(
  profile: OpencodeExecExecutorProfile,
  prompt: string,
  cwd: string
): OpencodeInvocation {
  if (!isDirectOpencodeRun(profile)) {
    return { args: profile.args, stdin: prompt, jsonMode: false, sessionId: null };
  }

  const args = withSandbox(withWorkingDirectory(profile.args, cwd), profile.sandbox);
  const sessionId = optionValue(args, "--session") ?? shortOptionValue(args, "-s");
  const runIndex = args.indexOf("run");
  const promptPlaceholderIndex = args.lastIndexOf("-");
  if (promptPlaceholderIndex > runIndex) {
    args[promptPlaceholderIndex] = prompt;
  } else {
    args.push(prompt);
  }
  return { args, stdin: "", jsonMode: optionValue(args, "--format") === "json", sessionId };
}
