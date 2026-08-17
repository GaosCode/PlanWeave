import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  createWindowsJobOwnership,
  createWindowsProcessTreeAdapter,
  resolveWindowsCommand,
  type WindowsJobLaunchStrategy,
  windowsLauncherArgs,
  windowsPowerShellPath
} from "./windowsManagedProcess.js";

export {
  createWindowsProcessTreeAdapter,
  windowsTaskKillArgs
} from "./windowsManagedProcess.js";
export type {
  TaskKillSpawnFn,
  WindowsJobLaunchStrategy,
  WindowsProcessTreeAdapterOptions
} from "./windowsManagedProcess.js";

/** Default grace between graceful and force termination (matches executor force-kill grace). */
export const DEFAULT_PROCESS_TREE_GRACE_MS = 500;

export type ProcessTerminationOutcome = "already_exited" | "graceful" | "forced";

export type ProcessTerminationResult = {
  outcome: ProcessTerminationOutcome;
  reason: string;
};

export type ProcessTerminationOptions = {
  graceMs?: number;
  forceExitConfirmMs?: number;
};

/**
 * Runtime-owned handle for a PlanWeave-managed process tree root.
 * Callers depend only on this lifecycle contract, not on child_process internals.
 */
export type ManagedProcessTree = {
  /** POSIX target pid; Windows managed launcher/Job owner pid. */
  readonly pid: number;
  /** Resolves when the root child exits; it does not prove that descendants have exited. */
  readonly exited: Promise<void>;
  isAlive(): boolean;
  /** Probe the owned process group / Job, including descendants after root exit. */
  isTreeAlive(): Promise<boolean>;
  /** Resolves true only when the whole owned tree is confirmed terminal within the window. */
  awaitTreeExit(timeoutMs: number): Promise<boolean>;
  /** Graceful-then-force tree termination. Concurrent calls share one promise. */
  terminate(reason: string, options?: ProcessTerminationOptions): Promise<ProcessTerminationResult>;
};

export type ManagedChildProcess = {
  /** On Windows this proxies the target; child.pid identifies the managed launcher/owner. */
  readonly child: ChildProcessWithoutNullStreams;
  readonly tree: ManagedProcessTree;
};

export type SpawnManagedProcessOptions = {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Grace between graceful and force signals. Default: DEFAULT_PROCESS_TREE_GRACE_MS. */
  graceMs?: number;
  /** Maximum wait after force termination before reporting that the tree survived. */
  forceExitConfirmMs?: number;
  /** Optional platform adapter override (tests). Default: host platform adapter. */
  adapter?: ProcessTreePlatformAdapter;
  /** Windows-only Job launch behavior. Default: suspended target with explicit Job assignment. */
  windowsJobLaunchStrategy?: WindowsJobLaunchStrategy;
};

export type ProcessTreePlatformAdapter = {
  readonly name: "posix" | "windows" | "fake";
  /** Mutate/return spawn options so the child becomes a safe tree root. */
  configureSpawn(options: SpawnOptions): SpawnOptions;
  /** Send graceful termination to the managed tree rooted at pid. */
  signalGraceful(pid: number): void | Promise<void>;
  /** Send force termination to the managed tree rooted at pid. */
  signalForce(pid: number): void | Promise<void>;
  /** Probe whether the root pid still exists (ESRCH => false). */
  isAlive(pid: number): boolean;
  /** Probe authoritative tree ownership (POSIX group / Windows Job), not only the root. */
  isTreeAlive(pid: number): boolean | Promise<boolean>;
  /** Wait for authoritative tree ownership to become empty. */
  awaitTreeExit(pid: number, timeoutMs: number): Promise<boolean>;
};

export type FakeProcessTreeAdapterOptions = {
  /** Record of signals sent during terminate (for contract tests). */
  signals?: Array<{ kind: "graceful" | "force"; pid: number }>;
  /** When set, graceful signal invokes this instead of default no-op. */
  onGraceful?: (pid: number) => void | Promise<void>;
  /** When set, force signal invokes this instead of default no-op. */
  onForce?: (pid: number) => void | Promise<void>;
  /** Override liveness probe. */
  isAlive?: (pid: number) => boolean;
  /** Override whole-tree liveness probe. Defaults to isAlive. */
  isTreeAlive?: (pid: number) => boolean | Promise<boolean>;
  /** Override whole-tree exit wait. Defaults to polling isTreeAlive. */
  awaitTreeExit?: (pid: number, timeoutMs: number) => Promise<boolean>;
  /** Optional spawn configure (default: identity). */
  configureSpawn?: (options: SpawnOptions) => SpawnOptions;
};

function sleep(ms: number): Promise<void> {
  // Keep the timer ref'd so short-lived CLIs cannot exit during grace→force and orphan the tree.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function pollTreeExit(
  probe: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const expiresAt = performance.now() + Math.max(0, timeoutMs);
  while (await probe()) {
    const remaining = expiresAt - performance.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(10, remaining));
  }
  return true;
}

function errnoCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function assertSafeManagedPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid managed process pid: ${String(pid)}`);
  }
  if (pid === process.pid) {
    throw new Error("Refusing to terminate the current PlanWeave process.");
  }
}

function posixIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      // Process exists but we cannot signal it; treat as alive so callers surface permission issues.
      return true;
    }
    throw error;
  }
}

function posixTreeIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

/**
 * Signal a POSIX process group owned by a detached child (pgid === pid).
 * Never accepts a pre-negated pid. Refuses same-pid-as-self.
 */
function signalPosixProcessGroup(pid: number, signal: NodeJS.Signals): void {
  assertSafeManagedPid(pid);
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ESRCH") {
      return;
    }
    throw error;
  }
}

export function createPosixProcessTreeAdapter(): ProcessTreePlatformAdapter {
  return {
    name: "posix",
    configureSpawn(options) {
      // New session/process group leader so -pid signals only this managed tree.
      return { ...options, detached: true, shell: false };
    },
    signalGraceful(pid) {
      signalPosixProcessGroup(pid, "SIGTERM");
    },
    signalForce(pid) {
      signalPosixProcessGroup(pid, "SIGKILL");
    },
    isAlive: posixIsAlive,
    isTreeAlive: posixTreeIsAlive,
    awaitTreeExit: (pid, timeoutMs) => pollTreeExit(() => posixTreeIsAlive(pid), timeoutMs)
  };
}

export function createFakeProcessTreeAdapter(
  options: FakeProcessTreeAdapterOptions = {}
): ProcessTreePlatformAdapter {
  const signals = options.signals;
  return {
    name: "fake",
    configureSpawn(spawnOptions) {
      return options.configureSpawn?.(spawnOptions) ?? { ...spawnOptions, shell: false };
    },
    async signalGraceful(pid) {
      signals?.push({ kind: "graceful", pid });
      await options.onGraceful?.(pid);
    },
    async signalForce(pid) {
      signals?.push({ kind: "force", pid });
      await options.onForce?.(pid);
    },
    isAlive(pid) {
      return options.isAlive?.(pid) ?? false;
    },
    isTreeAlive(pid) {
      return options.isTreeAlive?.(pid) ?? options.isAlive?.(pid) ?? false;
    },
    awaitTreeExit(pid, timeoutMs) {
      return (
        options.awaitTreeExit?.(pid, timeoutMs) ??
        pollTreeExit(() => options.isTreeAlive?.(pid) ?? options.isAlive?.(pid) ?? false, timeoutMs)
      );
    }
  };
}

export function createHostProcessTreeAdapter(
  platform: NodeJS.Platform = process.platform
): ProcessTreePlatformAdapter {
  return platform === "win32" ? createWindowsProcessTreeAdapter() : createPosixProcessTreeAdapter();
}

const defaultAdapter = createHostProcessTreeAdapter();

function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

function createManagedProcessTree(options: {
  pid: number;
  child: ChildProcessWithoutNullStreams;
  adapter: ProcessTreePlatformAdapter;
  graceMs: number;
  forceExitConfirmMs: number;
}): ManagedProcessTree {
  const { pid, child, adapter, graceMs, forceExitConfirmMs } = options;
  const exited = waitForChildExit(child);
  let terminationPromise: Promise<ProcessTerminationResult> | undefined;

  const isAlive = (): boolean => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return false;
    }
    return adapter.isAlive(pid);
  };

  const isTreeAlive = (): Promise<boolean> =>
    Promise.resolve(adapter.isTreeAlive?.(pid) ?? adapter.isAlive(pid));

  const awaitTreeExit = (timeoutMs: number): Promise<boolean> =>
    adapter.awaitTreeExit?.(pid, timeoutMs) ?? pollTreeExit(isTreeAlive, timeoutMs);

  const waitForForcedExit = async (reason: string, confirmMs: number): Promise<void> => {
    const didNotExitError = (): Error =>
      new Error(
        `Managed process tree pid=${String(pid)} did not exit after force termination (${reason}).`
      );

    if (!(await awaitTreeExit(confirmMs))) throw didNotExitError();
    await Promise.race([exited, sleep(confirmMs)]);
  };

  const terminate = (
    reason: string,
    terminationOptions: ProcessTerminationOptions = {}
  ): Promise<ProcessTerminationResult> => {
    if (!terminationPromise) {
      terminationPromise = (async (): Promise<ProcessTerminationResult> => {
        const effectiveGraceMs = terminationOptions.graceMs ?? graceMs;
        const effectiveConfirmMs = terminationOptions.forceExitConfirmMs ?? forceExitConfirmMs;
        const treeWasAlive = await isTreeAlive();

        if (!treeWasAlive) {
          await exited;
          return { outcome: "already_exited", reason };
        }

        try {
          await adapter.signalGraceful(pid);
        } catch (error) {
          const code = errnoCode(error);
          const rootExitedBeforeGraceful = code === "ESRCH" || code === "ECHILD";
          if (!rootExitedBeforeGraceful && adapter.name !== "windows") {
            throw error;
          }
          // A Windows taskkill failure does not invalidate the owner-independent Job.
          // Force through that authoritative owner; any Job termination failure surfaces.
          try {
            await adapter.signalForce(pid);
          } catch (forceError) {
            if (adapter.name === "windows" && !rootExitedBeforeGraceful) {
              const forceDiagnostic =
                forceError instanceof Error ? forceError.message : String(forceError);
              throw new AggregateError(
                [error, forceError],
                `Windows managed process graceful termination failed and Job force termination also failed for pid=${String(pid)}. Force failure: ${forceDiagnostic}`
              );
            }
            throw forceError;
          }
          await waitForForcedExit(reason, effectiveConfirmMs);
          return {
            outcome: rootExitedBeforeGraceful ? "graceful" : "forced",
            reason
          };
        }

        if (await awaitTreeExit(effectiveGraceMs)) {
          await exited;
          return { outcome: "graceful", reason };
        }
        const rootExitedDuringGrace = !isAlive();

        // Always force the managed tree after grace. Root may already be gone while a
        // grandchild that ignored SIGTERM remains in the same process group / OS tree.
        try {
          await adapter.signalForce(pid);
        } catch (error) {
          const code = errnoCode(error);
          if (code !== "ESRCH") {
            throw error;
          }
        }

        await waitForForcedExit(reason, effectiveConfirmMs);
        return {
          outcome: rootExitedDuringGrace ? "graceful" : "forced",
          reason
        };
      })();
    }
    return terminationPromise;
  };

  return {
    pid,
    exited,
    isAlive,
    isTreeAlive,
    awaitTreeExit,
    terminate
  };
}

/**
 * Spawn a long-lived managed child with platform-safe tree ownership.
 * stdio is always piped; shell is never enabled.
 */
export function spawnManagedProcess(options: SpawnManagedProcessOptions): ManagedChildProcess {
  let adapter = options.adapter ?? defaultAdapter;
  const graceMs = options.graceMs ?? DEFAULT_PROCESS_TREE_GRACE_MS;
  const forceExitConfirmMs = options.forceExitConfirmMs ?? graceMs;
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error(
      `Managed process graceMs must be a non-negative number; got ${String(graceMs)}`
    );
  }
  if (!Number.isFinite(forceExitConfirmMs) || forceExitConfirmMs < 0) {
    throw new Error(
      `Managed process forceExitConfirmMs must be a non-negative number; got ${String(forceExitConfirmMs)}`
    );
  }

  let command = options.command;
  let args = [...options.args];
  if (!options.adapter && adapter.name === "windows") {
    const target = resolveWindowsCommand(options);
    if (target) {
      const job = createWindowsJobOwnership();
      adapter = createWindowsProcessTreeAdapter({ job });
      command = windowsPowerShellPath();
      args = windowsLauncherArgs(job, target, options.args, options.windowsJobLaunchStrategy);
    }
  }

  const spawnOptions = adapter.configureSpawn({
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false
  });

  if (spawnOptions.shell) {
    throw new Error("Managed process spawn refuses shell:true.");
  }

  const child = spawn(command, args, spawnOptions) as ChildProcessWithoutNullStreams;
  const pid = child.pid;
  if (pid === undefined) {
    // Spawn may still emit 'error' asynchronously for missing binaries; expose a fail-closed tree.
    const failedTree: ManagedProcessTree = {
      pid: -1,
      exited: waitForChildExit(child),
      isAlive: () => false,
      isTreeAlive: async () => false,
      awaitTreeExit: async () => true,
      terminate: async (reason) => ({ outcome: "already_exited", reason })
    };
    return { child, tree: failedTree };
  }

  assertSafeManagedPid(pid);
  const tree = createManagedProcessTree({ pid, child, adapter, graceMs, forceExitConfirmMs });
  return { child, tree };
}

/** Test helper: build a ManagedProcessTree over an existing child and adapter. */
export function attachManagedProcessTree(options: {
  child: ChildProcessWithoutNullStreams;
  pid: number;
  adapter: ProcessTreePlatformAdapter;
  graceMs?: number;
  forceExitConfirmMs?: number;
}): ManagedProcessTree {
  assertSafeManagedPid(options.pid);
  return createManagedProcessTree({
    pid: options.pid,
    child: options.child,
    adapter: options.adapter,
    graceMs: options.graceMs ?? DEFAULT_PROCESS_TREE_GRACE_MS,
    forceExitConfirmMs:
      options.forceExitConfirmMs ?? options.graceMs ?? DEFAULT_PROCESS_TREE_GRACE_MS
  });
}
