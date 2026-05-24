import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmuxRunnerSource } from "./tmuxRunnerScript.js";

export type TmuxSessionInfo = {
  sessionName: string;
  attachCommand: string;
  readOnlyAttachCommand: string;
};

type RunInTmuxOptions = {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  env?: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs?: number;
  tmux: TmuxSessionInfo;
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
};

type TmuxDone = {
  exitCode: number;
  timedOut: boolean;
};

let tmuxAvailable: boolean | null = null;
const activeTmuxSessions = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeRef(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stderr });
    });
  });
}

async function hasTmuxSession(sessionName: string): Promise<boolean> {
  const result = await runCommand("tmux", ["has-session", "-t", sessionName]);
  return result.exitCode === 0;
}

export async function killActiveTmuxSessions(): Promise<string[]> {
  const sessionNames = [...activeTmuxSessions];
  const killed: string[] = [];
  await Promise.all(
    sessionNames.map(async (sessionName) => {
      const result = await runCommand("tmux", ["kill-session", "-t", sessionName]);
      activeTmuxSessions.delete(sessionName);
      if (result.exitCode === 0) {
        killed.push(sessionName);
      }
    })
  );
  return killed;
}

export async function isTmuxAvailable(): Promise<boolean> {
  if (process.env.PLANWEAVE_DISABLE_TMUX === "1" || process.env.PLANWEAVE_DISABLE_TMUX === "true") {
    return false;
  }
  if (tmuxAvailable !== null) {
    return tmuxAvailable;
  }
  try {
    const result = await runCommand("tmux", ["-V"]);
    tmuxAvailable = result.exitCode === 0;
  } catch {
    tmuxAvailable = false;
  }
  return tmuxAvailable;
}

export async function createTmuxSessionInfo(options: {
  runDir: string;
  runId: string;
  ref?: string;
  kind: "block" | "feedback";
}): Promise<TmuxSessionInfo | null> {
  if (!(await isTmuxAvailable())) {
    return null;
  }
  const label = safeRef(options.ref ?? options.kind);
  const name = `planweave-${label}-${safeRef(options.runId)}-${shortHash(options.runDir)}`.slice(0, 100);
  return {
    sessionName: name,
    attachCommand: `tmux attach-session -t ${name}`,
    readOnlyAttachCommand: `tmux attach-session -r -t ${name}`
  };
}

export function tmuxMetadataPatch(info: TmuxSessionInfo | null): Record<string, unknown> {
  if (!info) {
    return {};
  }
  return {
    tmuxSessionId: info.sessionName,
    tmuxSessionName: info.sessionName,
    tmuxAttachCommand: info.attachCommand,
    tmuxReadOnlyAttachCommand: info.readOnlyAttachCommand
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readNewText(path: string, offset: number): Promise<{ text: string; offset: number }> {
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch {
    return { text: "", offset };
  }
  if (size <= offset) {
    return { text: "", offset };
  }
  const length = size - offset;
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, offset);
    return { text: buffer.toString("utf8"), offset: size };
  } finally {
    await file.close();
  }
}

async function flushTail(options: {
  path: string;
  offset: number;
  onChunk?: (chunk: string) => void | Promise<void>;
}): Promise<number> {
  const result = await readNewText(options.path, options.offset);
  if (result.text && options.onChunk) {
    await options.onChunk(result.text);
  }
  return result.offset;
}

export async function runCommandInTmux(options: RunInTmuxOptions): Promise<{ stdoutPath: string; stderrPath: string; exitCode: number; timedOut: boolean }> {
  await mkdir(dirname(options.stdoutPath), { recursive: true });
  await mkdir(dirname(options.stderrPath), { recursive: true });
  await writeFile(options.stdoutPath, "", "utf8");
  await writeFile(options.stderrPath, "", "utf8");

  const tmuxRoot = join(dirname(options.stdoutPath), `.tmux-${safeRef(basename(options.stdoutPath))}`);
  await mkdir(tmuxRoot, { recursive: true });
  const stdinPath = join(tmuxRoot, "stdin.txt");
  const donePath = join(tmuxRoot, "done.json");
  const configPath = join(tmuxRoot, "command.json");
  const runnerPath = join(tmuxRoot, "runner.mjs");
  const scriptPath = join(tmuxRoot, "session.sh");
  await writeFile(stdinPath, options.stdin, "utf8");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        command: options.command,
        args: options.args,
        cwd: options.cwd,
        env: options.env ?? {},
        stdinPath,
        stdoutPath: options.stdoutPath,
        stderrPath: options.stderrPath,
        donePath,
        timeoutMs: options.timeoutMs ?? null
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(runnerPath, tmuxRunnerSource(configPath), "utf8");
  await writeFile(
    scriptPath,
    `#!/usr/bin/env bash
${shellQuote(process.execPath)} ${shellQuote(runnerPath)}
`,
    "utf8"
  );
  await chmod(scriptPath, 0o755);

  const started = await runCommand("tmux", ["new-session", "-d", "-s", options.tmux.sessionName, "-c", options.cwd, scriptPath], options.cwd);
  if (started.exitCode !== 0) {
    throw new Error(started.stderr.trim() || `tmux failed to start session '${options.tmux.sessionName}'.`);
  }
  activeTmuxSessions.add(options.tmux.sessionName);

  let stdoutOffset = 0;
  let stderrOffset = 0;
  try {
    while (!(await exists(donePath))) {
      await sleep(100);
      stdoutOffset = await flushTail({ path: options.stdoutPath, offset: stdoutOffset, onChunk: options.onStdout });
      stderrOffset = await flushTail({ path: options.stderrPath, offset: stderrOffset, onChunk: options.onStderr });
      if (!(await hasTmuxSession(options.tmux.sessionName))) {
        await sleep(200);
        stdoutOffset = await flushTail({ path: options.stdoutPath, offset: stdoutOffset, onChunk: options.onStdout });
        stderrOffset = await flushTail({ path: options.stderrPath, offset: stderrOffset, onChunk: options.onStderr });
        if (await exists(donePath)) {
          break;
        }
        return {
          stdoutPath: options.stdoutPath,
          stderrPath: options.stderrPath,
          exitCode: 130,
          timedOut: false
        };
      }
    }
    stdoutOffset = await flushTail({ path: options.stdoutPath, offset: stdoutOffset, onChunk: options.onStdout });
    stderrOffset = await flushTail({ path: options.stderrPath, offset: stderrOffset, onChunk: options.onStderr });

    const done = JSON.parse(await readFile(donePath, "utf8")) as TmuxDone;
    return {
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath,
      exitCode: done.exitCode,
      timedOut: done.timedOut
    };
  } finally {
    activeTmuxSessions.delete(options.tmux.sessionName);
  }
}
