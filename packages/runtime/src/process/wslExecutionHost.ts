import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ExecutionHost } from "../types/executor.js";
import {
  DEFAULT_PROCESS_TREE_GRACE_MS,
  type ManagedProcessTree,
  type ProcessTerminationOptions,
  type ProcessTerminationResult
} from "./managedProcessTree.js";

const WSL_PATH_BEGIN = "__PLANWEAVE_PATH_BEGIN__";
const WSL_PATH_END = "__PLANWEAVE_PATH_END__";
const WSL_LOGIN_PATH_SCRIPT = [
  'pw_shell="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f7)"',
  '[ -x "$pw_shell" ] || pw_shell=/bin/sh',
  `exec "$pw_shell" -l -i -c 'printf "\\n${WSL_PATH_BEGIN}%s${WSL_PATH_END}\\n" "$PATH"'`
].join("; ");

const WSL_PROCESS_WRAPPER_SCRIPT = [
  'pw_pid_file="$1"',
  "shift",
  "command -v setsid >/dev/null 2>&1 || { echo 'PlanWeave WSL host requires setsid.' >&2; exit 69; }",
  `setsid sh -c 'pw_pid_file="$1"; shift; printf "%s\\n" "$$" > "$pw_pid_file"; exec "$@"' planweave-wsl-child "$pw_pid_file" "$@"`,
  "pw_status=$?",
  "exit $pw_status"
].join("; ");

const WSL_PROCESS_GROUP_CONTROL_SCRIPT = [
  'pw_mode="$1"',
  'pw_pid_file="$2"',
  'pw_grace_steps="$3"',
  'pw_confirm_steps="$4"',
  '[ -r "$pw_pid_file" ] || { printf "exited\\n"; exit 0; }',
  'pw_pid="$(cat "$pw_pid_file")"',
  `case "$pw_pid" in ''|*[!0-9]*) echo 'Invalid PlanWeave WSL pid file.' >&2; exit 70;; esac`,
  '[ "$pw_pid" -gt 1 ] || { echo "Unsafe PlanWeave WSL pid: $pw_pid" >&2; exit 70; }',
  'pw_alive() { /bin/kill -0 -- "-$pw_pid" 2>/dev/null; }',
  'pw_wait() { pw_attempt=0; while pw_alive && [ "$pw_attempt" -lt "$1" ]; do sleep 0.01; pw_attempt=$((pw_attempt + 1)); done; ! pw_alive; }',
  'if [ "$pw_mode" = probe ]; then if pw_alive; then printf "alive\\n"; else rm -f "$pw_pid_file"; printf "exited\\n"; fi; exit 0; fi',
  'if [ "$pw_mode" = wait ]; then if pw_wait "$pw_confirm_steps"; then rm -f "$pw_pid_file"; printf "exited\\n"; else printf "alive\\n"; fi; exit 0; fi',
  '[ "$pw_mode" = terminate ] || { echo "Invalid PlanWeave WSL process-group mode." >&2; exit 70; }',
  '/bin/kill -TERM -- "-$pw_pid" 2>/dev/null || true',
  'if pw_wait "$pw_grace_steps"; then rm -f "$pw_pid_file"; printf "exited\\n"; exit 0; fi',
  '/bin/kill -KILL -- "-$pw_pid" 2>/dev/null || true',
  'if ! pw_wait "$pw_confirm_steps"; then echo "PlanWeave WSL process group $pw_pid is still running." >&2; exit 70; fi',
  'rm -f "$pw_pid_file"',
  'printf "exited\\n"'
].join("; ");

const WSL_LAUNCHER_ENVIRONMENT_KEYS = new Set([
  "comspec",
  "path",
  "pathext",
  "systemroot",
  "temp",
  "tmp",
  "windir"
]);

export type WslCommandOutput = { stdout: Buffer; stderr: Buffer };
export type WslCommandRunner = (args: readonly string[]) => Promise<WslCommandOutput>;

export type WslDistributionsResult = {
  available: boolean;
  distributions: string[];
  unavailableReason: string | null;
};

export type WslExecutionOptions = {
  platform?: NodeJS.Platform;
  run?: WslCommandRunner;
};

const WSL_RESOLVE_EXECUTABLE_SCRIPT = [
  'pw_command="$1"',
  'case "$pw_command" in /*) pw_candidate="$pw_command";; */*) echo "Relative WSL command paths are not allowed." >&2; exit 71;; *) pw_candidate="$(command -v -- "$pw_command")" || exit 127;; esac',
  '[ -x "$pw_candidate" ] || { echo "WSL command is not executable." >&2; exit 126; }',
  'pw_resolved="$(readlink -f -- "$pw_candidate")" || exit 72',
  'case "$pw_resolved" in /*) printf "%s\\n" "$pw_resolved";; *) exit 72;; esac'
].join("; ");

export async function resolveWslExecutable(
  command: string,
  distribution: string,
  options: WslExecutionOptions = {}
): Promise<string> {
  requireWindows(options.platform ?? process.platform);
  const selectedDistribution = distribution.trim();
  if (!selectedDistribution) throw new Error("WSL distribution must be selected explicitly.");
  if (command.includes("\0")) throw new Error("WSL command must not contain NUL.");
  try {
    const { stdout } = await commandRunner(options)([
      "--distribution",
      selectedDistribution,
      "--exec",
      "sh",
      "-c",
      WSL_RESOLVE_EXECUTABLE_SCRIPT,
      "planweave-wsl-resolve",
      command
    ]);
    const resolved = decodeCommandOutput(stdout).replaceAll("\0", "").trim();
    if (!resolved.startsWith("/")) throw new Error("WSL resolver returned a non-absolute path.");
    return resolved;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `ACP command '${command}' is not executable in WSL distribution '${selectedDistribution}': ${detail}`,
      { cause: error }
    );
  }
}

export type PreparedWslProcessInvocation = {
  command: "wsl.exe";
  args: string[];
  spawnEnvironment: Record<string, string>;
  sessionCwd: string;
  pidFile: string;
  cleanupExitedProcessTree(options?: ProcessTerminationOptions): Promise<void>;
  decorateProcessTree(tree: ManagedProcessTree): ManagedProcessTree;
};

export type PreparedExecutionHostInvocation = {
  command: string;
  args: string[];
  spawnCwd: string | undefined;
  spawnEnvironment: Record<string, string>;
  sessionCwd: string;
  executionHost: ExecutionHost;
  cleanupExitedProcessTree?: (options?: ProcessTerminationOptions) => Promise<void>;
  decorateProcessTree(tree: ManagedProcessTree): ManagedProcessTree;
};

export function wslLauncherEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && WSL_LAUNCHER_ENVIRONMENT_KEYS.has(entry[0].toLowerCase())
    )
  );
}

export function availableExecutionHostEnvironmentVariables(
  host: ExecutionHost,
  environment: Readonly<Record<string, string | undefined>>
): ReadonlySet<string> {
  return new Set(host.kind === "native" ? Object.keys(environment) : ["PATH", "PLANWEAVE_HOME"]);
}

const WSL_COMMAND_TIMEOUT_MS = 15_000;
const WSL_CLEANUP_WAIT_MS = 8_000;

function logWslHost(event: string, extra: Record<string, unknown> = {}): void {
  console.info(
    JSON.stringify({
      scope: "wsl-execution-host",
      event,
      at: new Date().toISOString(),
      ...extra
    })
  );
}

function summarizeWslArgs(args: readonly string[]): string {
  const mode = args.find((arg) => arg.startsWith("planweave-wsl-")) ?? args[0] ?? "wsl";
  const distributionIndex = args.indexOf("--distribution");
  const distribution = distributionIndex >= 0 ? args[distributionIndex + 1] : undefined;
  return distribution ? `${mode} distro=${distribution}` : mode;
}

function forceKillWindowsProcessTree(pid: number): void {
  spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
    stdio: "ignore",
    windowsHide: true,
    shell: false
  }).unref();
}

function isTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (errorCode(current) === "ETIMEDOUT") return true;
    if (current instanceof Error && /timed out after \d+ms/i.test(current.message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function raceTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(message), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function defaultWslCommandRunner(args: readonly string[]): Promise<WslCommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn("wsl.exe", [...args], {
      env: wslLauncherEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const settle = (work: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      work();
    };
    const timer = setTimeout(() => {
      logWslHost("command-timeout", {
        command: summarizeWslArgs(args),
        pid: child.pid ?? null,
        timeoutMs: WSL_COMMAND_TIMEOUT_MS
      });
      if (child.pid) forceKillWindowsProcessTree(child.pid);
      else child.kill();
      settle(() => {
        reject(
          Object.assign(
            new Error(`WSL command timed out after ${String(WSL_COMMAND_TIMEOUT_MS)}ms.`),
            { code: "ETIMEDOUT" }
          )
        );
      });
    }, WSL_COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.once("error", (error) => {
      settle(() => reject(error));
    });
    child.once("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      settle(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const detail = decodeCommandOutput(stderr).trim();
        reject(
          new Error(
            detail
              ? `WSL command exited ${String(code)}: ${detail}`
              : `WSL command exited ${String(code)}.`
          )
        );
      });
    });
  });
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function decodeCommandOutput(value: Buffer): string {
  if (value.length >= 2) {
    const startsWithBom = value[0] === 0xff && value[1] === 0xfe;
    let nulCount = 0;
    for (let index = 1; index < Math.min(value.length, 512); index += 2) {
      if (value[index] === 0) nulCount += 1;
    }
    if (startsWithBom || nulCount >= Math.min(3, Math.floor(value.length / 4))) {
      return value.toString("utf16le").replace(/^\uFEFF/, "");
    }
  }
  return value.toString("utf8");
}

function requireWindows(platform: NodeJS.Platform): void {
  if (platform !== "win32") {
    throw new Error("WSL execution host is only available on Windows.");
  }
}

function commandRunner(options: WslExecutionOptions): WslCommandRunner {
  return options.run ?? defaultWslCommandRunner;
}

export async function listWslDistributions(
  options: WslExecutionOptions = {}
): Promise<WslDistributionsResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      available: false,
      distributions: [],
      unavailableReason: "WSL is only available on Windows."
    };
  }
  try {
    const { stdout } = await commandRunner(options)(["--list", "--quiet"]);
    const distributions = decodeCommandOutput(stdout)
      .replaceAll("\0", "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    return {
      available: true,
      distributions: [...new Set(distributions)],
      unavailableReason: distributions.length === 0 ? "No WSL distributions are installed." : null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = errorCode(error) === "ENOENT" || /ENOENT|not found|cannot find/i.test(message);
    return {
      available: false,
      distributions: [],
      unavailableReason: missing
        ? "WSL is not installed or wsl.exe is unavailable."
        : `WSL distributions could not be listed: ${message}`
    };
  }
}

type ParsedWslUncPath = { distribution: string; path: string };

function parseWslUncPath(path: string): ParsedWslUncPath | null {
  const match = /^\\\\(?:wsl(?:\.localhost|\$))\\([^\\]+)(?:\\(.*))?$/i.exec(path);
  if (!match) return null;
  return {
    distribution: match[1]!,
    path: `/${(match[2] ?? "").replaceAll("\\", "/")}`.replace(/\/$/, "") || "/"
  };
}

export async function mapWindowsPathToWsl(
  path: string,
  distribution: string,
  options: WslExecutionOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  requireWindows(platform);
  const selectedDistribution = distribution.trim();
  if (!selectedDistribution) throw new Error("WSL distribution must be selected explicitly.");
  if (path.startsWith("/")) return path;

  const wslUnc = parseWslUncPath(path);
  if (wslUnc) {
    if (wslUnc.distribution.toLocaleLowerCase() !== selectedDistribution.toLocaleLowerCase()) {
      throw new Error(
        `Path '${path}' belongs to WSL distribution '${wslUnc.distribution}', not selected distribution '${selectedDistribution}'.`
      );
    }
    return wslUnc.path;
  }

  if (!/^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(
      `Windows path '${path}' cannot be mapped into WSL distribution '${selectedDistribution}'.`
    );
  }
  try {
    const { stdout } = await commandRunner(options)([
      "--distribution",
      selectedDistribution,
      "--exec",
      "wslpath",
      "-a",
      "-u",
      path
    ]);
    const mapped = decodeCommandOutput(stdout).replaceAll("\0", "").trim();
    if (!mapped.startsWith("/")) {
      throw new Error(`wslpath returned an invalid path: ${mapped || "<empty>"}`);
    }
    return mapped;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Windows path '${path}' could not be mapped in WSL distribution '${selectedDistribution}': ${detail}`,
      { cause: error }
    );
  }
}

export async function readWslLoginPath(
  distribution: string,
  options: WslExecutionOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  requireWindows(platform);
  const selectedDistribution = distribution.trim();
  if (!selectedDistribution) throw new Error("WSL distribution must be selected explicitly.");
  let output: WslCommandOutput;
  try {
    output = await commandRunner(options)([
      "--distribution",
      selectedDistribution,
      "--exec",
      "sh",
      "-lc",
      WSL_LOGIN_PATH_SCRIPT
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Login-shell PATH could not be read from WSL distribution '${selectedDistribution}': ${detail}`,
      { cause: error }
    );
  }
  const stdout = decodeCommandOutput(output.stdout).replaceAll("\0", "");
  const begin = stdout.lastIndexOf(WSL_PATH_BEGIN);
  const end = begin < 0 ? -1 : stdout.indexOf(WSL_PATH_END, begin + WSL_PATH_BEGIN.length);
  if (begin < 0 || end < 0) {
    throw new Error(
      `Login-shell PATH probe in WSL distribution '${selectedDistribution}' did not return the expected marker.`
    );
  }
  const path = stdout.slice(begin + WSL_PATH_BEGIN.length, end).trim();
  if (!path) {
    throw new Error(`Login-shell PATH in WSL distribution '${selectedDistribution}' is empty.`);
  }
  return path;
}

async function mappedPlanWeaveEnvironment(
  env: NodeJS.ProcessEnv | undefined,
  distribution: string,
  options: WslExecutionOptions
): Promise<string[]> {
  const result: string[] = [];
  for (const key of ["PLANWEAVE_HOME", "PLANWEAVE_REVIEW_RESULT_PATH"] as const) {
    const value = env?.[key];
    if (!value) continue;
    result.push(`${key}=${await mapWindowsPathToWsl(value, distribution, options)}`);
  }
  for (const key of ["PLANWEAVE_REVIEW_BLOCK_REF", "PLANWEAVE_REVIEW_TASK_ID"] as const) {
    const value = env?.[key];
    if (value) result.push(`${key}=${value}`);
  }
  return result;
}

function validateToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(token)) {
    throw new Error("WSL execution token contains unsupported characters.");
  }
  return token;
}

function wslWaitSteps(timeoutMs: number): number {
  return Math.max(0, Math.ceil(timeoutMs / 10));
}

async function controlWslProcessGroup(options: {
  distribution: string;
  pidFile: string;
  run: WslCommandRunner;
  mode: "probe" | "wait" | "terminate";
  graceMs?: number;
  confirmMs?: number;
}): Promise<boolean> {
  try {
    const output = await options.run([
      "--distribution",
      options.distribution,
      "--exec",
      "sh",
      "-c",
      WSL_PROCESS_GROUP_CONTROL_SCRIPT,
      `planweave-wsl-${options.mode}`,
      options.mode,
      options.pidFile,
      String(wslWaitSteps(options.graceMs ?? 0)),
      String(wslWaitSteps(options.confirmMs ?? 0))
    ]);
    const state = decodeCommandOutput(output.stdout).trim();
    if (state === "exited") return false;
    if (state === "alive") return true;
    if (options.mode === "terminate") return false;
    throw new Error(`WSL process group ${options.mode} returned an invalid state.`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `WSL process group ${options.mode} failed in distribution '${options.distribution}': ${detail}`,
      { cause: error }
    );
  }
}

function decorateWslProcessTree(options: {
  tree: ManagedProcessTree;
  isWslTreeAlive: () => Promise<boolean>;
  awaitWslTreeExit: (timeoutMs: number) => Promise<boolean>;
  cleanupExitedProcessTree: (termination?: ProcessTerminationOptions) => Promise<void>;
}): ManagedProcessTree {
  let termination: Promise<ProcessTerminationResult> | undefined;
  return {
    pid: options.tree.pid,
    exited: options.tree.exited,
    isAlive: () => options.tree.isAlive(),
    async isTreeAlive() {
      const [nativeAlive, wslAlive] = await Promise.all([
        options.tree.isTreeAlive(),
        options.isWslTreeAlive()
      ]);
      return nativeAlive || wslAlive;
    },
    async awaitTreeExit(timeoutMs) {
      const [nativeExited, wslAlive] = await Promise.all([
        options.tree.awaitTreeExit(timeoutMs),
        options.awaitWslTreeExit(timeoutMs)
      ]);
      return nativeExited && !wslAlive;
    },
    terminate(reason, terminationOptions) {
      termination ??= (async () => {
        // WSL 1 serializes distro entry. A concurrent wsl.exe --exec for
        // process-group cleanup can block forever while the launcher is still
        // inside the same distribution. Reap the Windows launcher first.
        logWslHost("terminate-start", { reason });
        let nativeResult: ProcessTerminationResult;
        try {
          nativeResult = terminationOptions
            ? await options.tree.terminate(reason, terminationOptions)
            : await options.tree.terminate(reason);
          logWslHost("native-terminate-done", { reason, outcome: nativeResult.outcome });
        } catch (nativeError) {
          logWslHost("native-terminate-failed", {
            reason,
            error: nativeError instanceof Error ? nativeError.message : String(nativeError)
          });
          try {
            await raceTimeout(
              options.cleanupExitedProcessTree(terminationOptions),
              WSL_CLEANUP_WAIT_MS,
              `WSL process-group cleanup timed out after ${String(WSL_CLEANUP_WAIT_MS)}ms.`
            );
          } catch (cleanupError) {
            logWslHost("cleanup-after-native-failure", {
              timedOut: isTimeoutError(cleanupError),
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            });
            if (!isTimeoutError(cleanupError)) {
              throw new AggregateError(
                [cleanupError, nativeError],
                "WSL and Windows process-tree cleanup both failed."
              );
            }
          }
          throw nativeError;
        }
        try {
          logWslHost("cleanup-start", { reason, waitMs: WSL_CLEANUP_WAIT_MS });
          await raceTimeout(
            options.cleanupExitedProcessTree(terminationOptions),
            WSL_CLEANUP_WAIT_MS,
            `WSL process-group cleanup timed out after ${String(WSL_CLEANUP_WAIT_MS)}ms.`
          );
          logWslHost("cleanup-done", { reason });
        } catch (cleanupError) {
          // After the Windows launcher is gone, a hung WSL 1 cleanup must not
          // keep the executor promise open. Explicit cleanup failures still surface.
          logWslHost("cleanup-failed", {
            reason,
            timedOut: isTimeoutError(cleanupError),
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          });
          if (!isTimeoutError(cleanupError)) throw cleanupError;
        }
        logWslHost("terminate-done", { reason, outcome: nativeResult.outcome });
        return nativeResult;
      })();
      return termination;
    }
  };
}

export async function prepareWslProcessInvocation(options: {
  host: Extract<ExecutionHost, { kind: "wsl" }>;
  command: string;
  args: readonly string[];
  pathArgIndexes?: readonly number[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: WslCommandRunner;
  token?: string;
}): Promise<PreparedWslProcessInvocation> {
  const platform = options.platform ?? process.platform;
  requireWindows(platform);
  const distribution = options.host.distribution.trim();
  if (!distribution) throw new Error("WSL distribution must be selected explicitly.");
  const executionOptions = { platform, run: options.run } satisfies WslExecutionOptions;
  const [sessionCwd, loginPath, planweaveEnvironment] = await Promise.all([
    mapWindowsPathToWsl(options.cwd, distribution, executionOptions),
    readWslLoginPath(distribution, executionOptions),
    mappedPlanWeaveEnvironment(options.env, distribution, executionOptions)
  ]);
  const pathIndexes = new Set(options.pathArgIndexes ?? []);
  const args = await Promise.all(
    options.args.map((argument, index) =>
      pathIndexes.has(index)
        ? mapWindowsPathToWsl(argument, distribution, executionOptions)
        : Promise.resolve(argument)
    )
  );
  const token = validateToken(options.token ?? randomUUID());
  const pidFile = `/tmp/planweave-${token}.pid`;
  const run = commandRunner(executionOptions);
  let cleanup: Promise<void> | undefined;
  const isWslTreeAlive = (): Promise<boolean> =>
    controlWslProcessGroup({ distribution, pidFile, run, mode: "probe" });
  const awaitWslTreeExit = (timeoutMs: number): Promise<boolean> =>
    controlWslProcessGroup({
      distribution,
      pidFile,
      run,
      mode: "wait",
      confirmMs: timeoutMs
    });
  const cleanupExitedProcessTree = (termination: ProcessTerminationOptions = {}): Promise<void> => {
    cleanup ??= controlWslProcessGroup({
      distribution,
      pidFile,
      run,
      mode: "terminate",
      graceMs: termination.graceMs ?? DEFAULT_PROCESS_TREE_GRACE_MS,
      confirmMs: termination.forceExitConfirmMs ?? DEFAULT_PROCESS_TREE_GRACE_MS
    }).then((alive) => {
      if (alive) throw new Error("WSL process group remained alive after force termination.");
    });
    return cleanup;
  };
  return {
    command: "wsl.exe",
    args: [
      "--distribution",
      distribution,
      "--cd",
      sessionCwd,
      "--exec",
      "sh",
      "-c",
      WSL_PROCESS_WRAPPER_SCRIPT,
      "planweave-wsl",
      pidFile,
      "env",
      `PATH=${loginPath}`,
      ...planweaveEnvironment,
      options.command,
      ...args
    ],
    spawnEnvironment: wslLauncherEnvironment(options.env),
    sessionCwd,
    pidFile,
    cleanupExitedProcessTree,
    decorateProcessTree: (tree) =>
      decorateWslProcessTree({
        tree,
        isWslTreeAlive,
        awaitWslTreeExit,
        cleanupExitedProcessTree
      })
  };
}

export async function prepareExecutionHostInvocation(options: {
  host: ExecutionHost;
  command: string;
  args: readonly string[];
  pathArgIndexes?: readonly number[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: WslCommandRunner;
  token?: string;
}): Promise<PreparedExecutionHostInvocation> {
  if (options.host.kind === "native") {
    return {
      command: options.command,
      args: [...options.args],
      spawnCwd: options.cwd,
      spawnEnvironment: Object.fromEntries(
        Object.entries(options.env ?? process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ),
      sessionCwd: options.cwd,
      executionHost: options.host,
      decorateProcessTree: (tree) => tree
    };
  }
  const prepared = await prepareWslProcessInvocation({
    ...options,
    host: options.host
  });
  return {
    command: prepared.command,
    args: prepared.args,
    spawnCwd: undefined,
    spawnEnvironment: prepared.spawnEnvironment,
    sessionCwd: prepared.sessionCwd,
    executionHost: options.host,
    cleanupExitedProcessTree: prepared.cleanupExitedProcessTree,
    decorateProcessTree: prepared.decorateProcessTree
  };
}
