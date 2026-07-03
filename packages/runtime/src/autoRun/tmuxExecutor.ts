import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isNodeFileNotFoundError, optionalStat } from "../fs/optionalFile.js";
import { tmuxRunnerSource } from "./tmuxRunnerScript.js";

export type TmuxSessionInfo = {
  sessionName: string;
  tmuxOwnerRunId?: string;
  attachCommand: string;
  readOnlyAttachCommand: string;
};

type ActiveTmuxSessionRecord = {
  sessionName: string;
  tmuxOwnerRunId?: string;
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
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  tmux: TmuxSessionInfo;
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
};

type TmuxDone = {
  exitCode: number;
  timedOut: boolean;
  limitExceeded?: TmuxOutputLimitExceeded;
};

type TmuxOutputLimitExceeded = {
  stream: "stdout" | "stderr";
  limitBytes: number;
};

let tmuxAvailable: boolean | null = null;
const activeTmuxSessions = new Map<string, ActiveTmuxSessionRecord>();
const runtimePathEntries = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
const TMUX_TERMINATE_FORCE_KILL_GRACE_MS = 500;
const TMUX_SESSION_RELEASE_POLL_COUNT = 50;

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

async function runCommand(command: string, args: string[], cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: [process.env.PATH, ...runtimePathEntries].filter(Boolean).join(":") };
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

async function hasTmuxSession(sessionName: string): Promise<boolean> {
  const result = await runCommand("tmux", ["has-session", "-t", sessionName]);
  return result.exitCode === 0;
}

function trySignalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroupOrProcess(pid: number, signal: NodeJS.Signals): void {
  if (!trySignalProcess(-pid, signal)) {
    trySignalProcess(pid, signal);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function tmuxPanePid(sessionName: string): Promise<number | null> {
  const result = await runCommand("tmux", ["display-message", "-p", "-t", sessionName, "#{pane_pid}"]);
  if (result.exitCode !== 0) {
    return null;
  }
  const pid = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function descendantPids(rootPid: number): Promise<number[]> {
  const result = await runCommand("ps", ["-axo", "pid=,ppid="]);
  if (result.exitCode !== 0) {
    return [];
  }
  const childrenByParent = new Map<number, number[]>();
  for (const line of result.stdout.split("\n")) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number.parseInt(pidText, 10);
    const ppid = Number.parseInt(ppidText, 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
      continue;
    }
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  const descendants: number[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    descendants.push(pid);
    queue.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

async function terminateTmuxSession(sessionName: string): Promise<boolean> {
  const panePid = await tmuxPanePid(sessionName);
  const pids = panePid === null ? [] : [panePid, ...(await descendantPids(panePid))];
  for (const pid of pids.slice().reverse()) {
    signalProcessGroupOrProcess(pid, "SIGTERM");
  }
  const killedSession = await runCommand("tmux", ["kill-session", "-t", sessionName]);
  await sleep(TMUX_TERMINATE_FORCE_KILL_GRACE_MS);
  for (const pid of pids.slice().reverse()) {
    if (isProcessAlive(pid)) {
      signalProcessGroupOrProcess(pid, "SIGKILL");
    }
  }
  if (await hasTmuxSession(sessionName)) {
    await runCommand("tmux", ["kill-session", "-t", sessionName]);
  }
  return killedSession.exitCode === 0 || pids.length > 0;
}

export async function killActiveTmuxSessions(): Promise<string[]> {
  const sessionNames = [...activeTmuxSessions.keys()];
  const killed: string[] = [];
  await Promise.all(
    sessionNames.map(async (sessionName) => {
      const terminated = await terminateTmuxSession(sessionName);
      activeTmuxSessions.delete(sessionName);
      if (terminated) {
        killed.push(sessionName);
      }
    })
  );
  return killed;
}

export async function killTmuxSessionsForRun(runId: string): Promise<string[]> {
  const records = [...activeTmuxSessions.values()].filter((record) => record.tmuxOwnerRunId === runId);
  const killed: string[] = [];
  await Promise.all(
    records.map(async (record) => {
      const terminated = await terminateTmuxSession(record.sessionName);
      activeTmuxSessions.delete(record.sessionName);
      if (terminated) {
        killed.push(record.sessionName);
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
  tmuxOwnerRunId?: string;
  ref?: string;
  kind: "block" | "feedback";
  enabled?: boolean;
}): Promise<TmuxSessionInfo | null> {
  if (options.enabled === false) {
    return null;
  }
  if (!(await isTmuxAvailable())) {
    return null;
  }
  const label = safeRef(options.ref ?? options.kind);
  const name = `planweave-${label}-${safeRef(options.runId)}-${shortHash(options.runDir)}`.slice(0, 100);
  return {
    sessionName: name,
    tmuxOwnerRunId: options.tmuxOwnerRunId,
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

export async function tmuxPathExists(path: string): Promise<boolean> {
  return (await optionalStat(path)) !== null;
}

export async function readNewTmuxText(path: string, offset: number, maxOffset?: number): Promise<{ text: string; offset: number; limitExceeded: boolean }> {
  const metadata = await optionalStat(path);
  if (!metadata) {
    return { text: "", offset, limitExceeded: false };
  }
  const size = metadata.size;
  if (size <= offset) {
    return { text: "", offset, limitExceeded: false };
  }
  if (maxOffset !== undefined && offset >= maxOffset) {
    return { text: "", offset, limitExceeded: size > maxOffset };
  }
  const nextOffset = maxOffset === undefined ? size : Math.min(size, maxOffset);
  const length = nextOffset - offset;
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return { text: "", offset, limitExceeded: false };
    }
    throw error;
  }
  try {
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, offset);
    return { text: buffer.toString("utf8"), offset: nextOffset, limitExceeded: maxOffset !== undefined && size > maxOffset };
  } finally {
    await file.close();
  }
}

async function flushTail(options: {
  path: string;
  offset: number;
  maxBytes?: number;
  onChunk?: (chunk: string) => void | Promise<void>;
}): Promise<{ offset: number; limitExceeded: boolean }> {
  const result = await readNewTmuxText(options.path, options.offset, options.maxBytes);
  if (result.text && options.onChunk) {
    await options.onChunk(result.text);
  }
  return { offset: result.offset, limitExceeded: result.limitExceeded };
}

async function waitForDoneFile(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await tmuxPathExists(path)) {
      return true;
    }
    await sleep(100);
  }
  return tmuxPathExists(path);
}

export async function runCommandInTmux(
  options: RunInTmuxOptions
): Promise<{ stdoutPath: string; stderrPath: string; exitCode: number; timedOut: boolean; limitExceeded?: TmuxOutputLimitExceeded }> {
  await mkdir(dirname(options.stdoutPath), { recursive: true });
  await mkdir(dirname(options.stderrPath), { recursive: true });
  await writeFile(options.stdoutPath, "", "utf8");
  await writeFile(options.stderrPath, "", "utf8");

  const tmuxRoot = join(dirname(options.stdoutPath), `.tmux-${safeRef(basename(options.stdoutPath))}`);
  await mkdir(tmuxRoot, { recursive: true });
  const stdinPath = join(tmuxRoot, "stdin.txt");
  const donePath = join(tmuxRoot, "done.json");
  const configPath = join(tmuxRoot, "command.json");
  const releasePath = join(tmuxRoot, "release");
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
        timeoutMs: options.timeoutMs ?? null,
        maxStdoutBytes: options.maxStdoutBytes ?? null,
        maxStderrBytes: options.maxStderrBytes ?? null
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
set +e
${shellQuote(process.execPath)} ${shellQuote(runnerPath)}
runner_exit=$?
for _ in {1..${TMUX_SESSION_RELEASE_POLL_COUNT}}; do
  if [ -f ${shellQuote(releasePath)} ]; then
    exit "$runner_exit"
  fi
  sleep 0.1
done
exit "$runner_exit"
`,
    "utf8"
  );
  await chmod(scriptPath, 0o755);

  const started = await runCommand("tmux", ["new-session", "-d", "-s", options.tmux.sessionName, "-c", options.cwd, scriptPath], options.cwd);
  if (started.exitCode !== 0) {
    throw new Error(started.stderr.trim() || `tmux failed to start session '${options.tmux.sessionName}'.`);
  }
  activeTmuxSessions.set(options.tmux.sessionName, {
    sessionName: options.tmux.sessionName,
    tmuxOwnerRunId: options.tmux.tmuxOwnerRunId
  });

  let stdoutOffset = 0;
  let stderrOffset = 0;
  let observedLimitExceeded: TmuxOutputLimitExceeded | undefined;
  try {
    while (!(await tmuxPathExists(donePath))) {
      await sleep(100);
      const stdoutTail = await flushTail({ path: options.stdoutPath, offset: stdoutOffset, maxBytes: options.maxStdoutBytes, onChunk: options.onStdout });
      stdoutOffset = stdoutTail.offset;
      if (stdoutTail.limitExceeded && options.maxStdoutBytes !== undefined) {
        observedLimitExceeded = { stream: "stdout", limitBytes: options.maxStdoutBytes };
      }
      const stderrTail = await flushTail({ path: options.stderrPath, offset: stderrOffset, maxBytes: options.maxStderrBytes, onChunk: options.onStderr });
      stderrOffset = stderrTail.offset;
      if (stderrTail.limitExceeded && options.maxStderrBytes !== undefined) {
        observedLimitExceeded = observedLimitExceeded ?? { stream: "stderr", limitBytes: options.maxStderrBytes };
      }
      if (!(await hasTmuxSession(options.tmux.sessionName))) {
        await waitForDoneFile(donePath);
        const finalStdoutTail = await flushTail({ path: options.stdoutPath, offset: stdoutOffset, maxBytes: options.maxStdoutBytes, onChunk: options.onStdout });
        stdoutOffset = finalStdoutTail.offset;
        if (finalStdoutTail.limitExceeded && options.maxStdoutBytes !== undefined) {
          observedLimitExceeded = { stream: "stdout", limitBytes: options.maxStdoutBytes };
        }
        const finalStderrTail = await flushTail({ path: options.stderrPath, offset: stderrOffset, maxBytes: options.maxStderrBytes, onChunk: options.onStderr });
        stderrOffset = finalStderrTail.offset;
        if (finalStderrTail.limitExceeded && options.maxStderrBytes !== undefined) {
          observedLimitExceeded = observedLimitExceeded ?? { stream: "stderr", limitBytes: options.maxStderrBytes };
        }
        if (await tmuxPathExists(donePath)) {
          break;
        }
        return {
          stdoutPath: options.stdoutPath,
          stderrPath: options.stderrPath,
          exitCode: observedLimitExceeded ? 1 : 130,
          timedOut: false,
          limitExceeded: observedLimitExceeded
        };
      }
    }
    const stdoutTail = await flushTail({ path: options.stdoutPath, offset: stdoutOffset, maxBytes: options.maxStdoutBytes, onChunk: options.onStdout });
    stdoutOffset = stdoutTail.offset;
    if (stdoutTail.limitExceeded && options.maxStdoutBytes !== undefined) {
      observedLimitExceeded = { stream: "stdout", limitBytes: options.maxStdoutBytes };
    }
    const stderrTail = await flushTail({ path: options.stderrPath, offset: stderrOffset, maxBytes: options.maxStderrBytes, onChunk: options.onStderr });
    stderrOffset = stderrTail.offset;
    if (stderrTail.limitExceeded && options.maxStderrBytes !== undefined) {
      observedLimitExceeded = observedLimitExceeded ?? { stream: "stderr", limitBytes: options.maxStderrBytes };
    }

    const done = JSON.parse(await readFile(donePath, "utf8")) as TmuxDone;
    const limitExceeded = done.limitExceeded ?? observedLimitExceeded;
    return {
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath,
      exitCode: limitExceeded ? 1 : done.exitCode,
      timedOut: done.timedOut,
      limitExceeded
    };
  } catch (error) {
    await terminateTmuxSession(options.tmux.sessionName);
    throw error;
  } finally {
    await writeFile(releasePath, "release\n", "utf8").catch(() => undefined);
    activeTmuxSessions.delete(options.tmux.sessionName);
  }
}
