import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnManagedProcess, type ManagedProcessTree } from "@planweave-ai/runtime";
import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { redactRunnerEventText } from "@planweave-ai/runtime";
import { operatorEnrollmentGrantResponseSchema } from "@planweave-ai/agent-host-protocol";
import { z } from "zod";
import { createTestWorkspace } from "../../../../runtime/src/__tests__/promptTestHelpers.js";
import { hashOperatorToken } from "../../operatorAuth.js";
import { parseServerConfig, serverConfigSummarySchema } from "../../config.js";
import { legacyWorkspaceIdForProject } from "./legacyWorkspaceId.js";
import { seedOperatorSessions } from "./operatorAuthFixture.js";
import { remoteAcpManifest } from "./realProcessAcpManifests.js";
import {
  createAgentExecutableProbe,
  runAgentHostCommand,
  type HostCommandResult
} from "./realProcessAgentExposure.js";
import { configureHostWorkspace } from "./realProcessHostConfig.js";
import { TEST_REMOTE_AGENT_OWNER_ID } from "./remoteAgentOwnerFixture.js";

function resolveHarnessPath(relativeUrl: string, workspacePath: string): string {
  try {
    return fileURLToPath(new URL(relativeUrl, import.meta.url));
  } catch {
    return join(process.cwd(), workspacePath);
  }
}

const serverBinPath = resolveHarnessPath("../../../dist/bin.js", "packages/server/dist/bin.js");
const agentHostBinPath = resolveHarnessPath(
  "../../../../agent-host/dist/bin.js",
  "packages/agent-host/dist/bin.js"
);
export const acpMockAgentPath = resolveHarnessPath(
  "../../../../runtime/src/__tests__/support/acpMockAgent.mjs",
  "packages/runtime/src/__tests__/support/acpMockAgent.mjs"
);

export const REAL_PROCESS_ACP_HARNESS_DEFAULT_TIMEOUT_MS = 15_000;

const serverReadyOutputSchema = serverConfigSummarySchema
  .pick({ advertisedOrigin: true })
  .extend({ status: z.literal("ready") })
  .passthrough();

export type ProcessLogBuffer = {
  stdout: string;
  stderr: string;
};

export type ProcessExitSnapshot = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type ManagedChild = {
  child: ChildProcessWithoutNullStreams;
  tree: ManagedProcessTree;
  logs: ProcessLogBuffer;
  exit: Promise<ProcessExitSnapshot>;
  exitSnapshot: ProcessExitSnapshot | undefined;
};

export async function stopManagedChildForCleanup(
  child: ManagedChild,
  reason: string
): Promise<void> {
  try {
    if (child.tree.isAlive()) {
      await child.tree.terminate(reason);
    }
    await child.exit;
    return;
  } catch (treeError) {
    if (child.child.exitCode !== null || child.child.signalCode !== null) {
      await child.exit;
      return;
    }
    try {
      if (!child.child.kill("SIGKILL")) {
        throw new Error("root_sigkill_not_sent");
      }
      await child.exit;
    } catch (fallbackError) {
      throw new AggregateError(
        [treeError, fallbackError],
        `real_process_harness_cleanup_failed:${reason}`
      );
    }
  }
}

export type RealProcessServerLimits = {
  leaseDurationMs?: number;
  hostOfflineAfterMs?: number;
  heartbeatIntervalMs?: number;
  busyTimeoutMs?: number;
};

export type RealProcessAcpHarnessOptions = {
  acpScenario?: string;
  hostDisplayName?: string;
  hostCapacity?: number;
  hostCapabilities?: string[];
  hostAgentProfile?: { id: string; agentId: "codex" | "opencode" };
  operatorToken?: string;
  projectOperatorToken?: string;
  readinessTimeoutMs?: number;
  corruptServerConfigOnCreate?: boolean;
  graceMs?: number;
  manifest?: PlanPackageManifest;
  serverLimits?: RealProcessServerLimits;
};

export type SecondaryHostOptions = {
  key?: string;
  displayName: string;
  capacity?: number;
  capabilities?: string[];
  acpScenario?: string;
};

export type SecondaryHostHandle = {
  key: string;
  displayName: string;
  capacity: number;
  capabilities: readonly string[];
  dataDir: string;
  configPath: string;
  controlDir: string;
};

export type HarnessPaths = {
  root: string;
  projectRoot: string;
  projectHome: string;
  serverData: string;
  hostData: string;
  workspaceRoot: string;
  workspaceProject: string;
  artifacts: string;
  logs: string;
  control: string;
  agentBin: string;
  serverConfig: string;
  hostConfig: string;
  acpLifecycle: string;
};

function redactLogText(value: string): string {
  try {
    return redactRunnerEventText(value).text;
  } catch {
    return value.replace(
      /\b(?:token|password|api[_-]?key|secret|authorization)\s*[:=]\s*\S+/gi,
      "credential=[REDACTED:CREDENTIAL]"
    );
  }
}

async function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Allocate a free loopback port for a not-yet-started Server process.
 * Narrows classic listen(0)/close TOCTOU races by re-binding the chosen port
 * exclusively once before returning; callers should still retry on EADDRINUSE.
 */
export async function allocateEphemeralPort(maxAttempts = 16): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const probe = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => resolve());
      });
      const address = probe.address();
      if (!address || typeof address === "string") {
        throw new Error("real_process_harness_port_unavailable");
      }
      const port = address.port;
      await closeHttpServer(probe);

      // Re-claim exclusively then release so we do not hand out a still-busy port.
      const verify = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          verify.once("error", reject);
          verify.listen(port, "127.0.0.1", () => resolve());
        });
        await closeHttpServer(verify);
        return port;
      } catch (error) {
        await closeHttpServer(verify).catch(() => undefined);
        lastError = error;
      }
    } catch (error) {
      await closeHttpServer(probe).catch(() => undefined);
      lastError = error;
    }
  }
  throw new Error(
    `real_process_harness_port_unavailable:${
      lastError instanceof Error ? lastError.message : String(lastError ?? "exhausted")
    }`
  );
}

async function removeDirectoryWithRetries(directory: string, attempts = 8): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      // Child log writers or antivirus may briefly hold files after process exit.
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`real_process_harness_cleanup_failed:${String(lastError)}`);
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  options: { timeoutMs: number; intervalMs?: number; label: string; diagnostics?: () => string }
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  const intervalMs = options.intervalMs ?? 50;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const detail = options.diagnostics?.() ?? "";
  throw new Error(
    `real_process_harness_timeout:${options.label}${detail ? `\n${detail}` : ""}${
      lastError instanceof Error ? `\ncause: ${lastError.message}` : ""
    }`
  );
}

function attachLogCapture(child: ChildProcessWithoutNullStreams): ProcessLogBuffer {
  const logs: ProcessLogBuffer = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    logs.stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    logs.stderr += chunk;
  });
  return logs;
}

function trackExit(child: ChildProcessWithoutNullStreams): {
  exit: Promise<ProcessExitSnapshot>;
  getSnapshot: () => ProcessExitSnapshot | undefined;
} {
  let snapshot: ProcessExitSnapshot | undefined;
  const exit = new Promise<ProcessExitSnapshot>((resolve) => {
    child.once("exit", (code, signal) => {
      snapshot = { code, signal };
      resolve(snapshot);
    });
    child.once("error", () => {
      snapshot = { code: null, signal: null };
      resolve(snapshot);
    });
  });
  return { exit, getSnapshot: () => snapshot };
}

/**
 * File-based control plane for the harness-owned fake ACP process.
 * Production binaries never import this; only acpMockAgent.mjs honors the control dir.
 */
export class FakeAcpControl {
  constructor(readonly controlDir: string) {}

  async pause(at?: readonly string[]): Promise<void> {
    await mkdir(this.controlDir, { recursive: true });
    if (at && at.length > 0) {
      await writeFile(join(this.controlDir, "pause-at"), `${at.join("\n")}\n`, "utf8");
    } else if (existsSync(join(this.controlDir, "pause-at"))) {
      await rm(join(this.controlDir, "pause-at"), { force: true });
    }
    await writeFile(join(this.controlDir, "pause"), "1\n", "utf8");
  }

  async resume(): Promise<void> {
    await rm(join(this.controlDir, "pause"), { force: true });
  }

  async corruptNextStdoutFrame(): Promise<void> {
    await mkdir(this.controlDir, { recursive: true });
    await writeFile(join(this.controlDir, "corrupt-next"), "1\n", "utf8");
  }

  async forceExit(code = 42): Promise<void> {
    await mkdir(this.controlDir, { recursive: true });
    await writeFile(join(this.controlDir, "force-exit"), `${code}\n`, "utf8");
  }

  async waitUntilReady(timeoutMs = REAL_PROCESS_ACP_HARNESS_DEFAULT_TIMEOUT_MS): Promise<void> {
    await waitFor(() => existsSync(join(this.controlDir, "ready")), {
      timeoutMs,
      label: "acp-control-ready",
      diagnostics: () => `controlDir=${this.controlDir}`
    });
  }

  async waitUntilLifecycleContains(
    fragment: string,
    timeoutMs = REAL_PROCESS_ACP_HARNESS_DEFAULT_TIMEOUT_MS
  ): Promise<string[]> {
    const lifecyclePath = join(this.controlDir, "lifecycle.log");
    let lines: string[] = [];
    await waitFor(
      async () => {
        if (!existsSync(lifecyclePath)) return false;
        const text = await readFile(lifecyclePath, "utf8");
        lines = text.split("\n").filter(Boolean);
        return lines.some((line) => line.includes(fragment));
      },
      {
        timeoutMs,
        label: `acp-lifecycle:${fragment}`,
        diagnostics: () => redactLogText(lines.join("\n") || "(empty lifecycle)")
      }
    );
    return lines;
  }

  async readLifecycle(): Promise<string[]> {
    const lifecyclePath = join(this.controlDir, "lifecycle.log");
    if (!existsSync(lifecyclePath)) return [];
    return (await readFile(lifecyclePath, "utf8")).split("\n").filter(Boolean);
  }
}

export class RealProcessAcpHarness {
  readonly paths: HarnessPaths;
  readonly operatorToken: string;
  /** Mutable so startServer can rebind after EADDRINUSE without recreating the harness. */
  origin: string;
  port: number;
  readonly projectId: string;
  readonly acpControl: FakeAcpControl;
  readonly acpScenario: string;
  readonly readinessTimeoutMs: number;
  readonly hostDisplayName: string;
  readonly hostCapacity: number;
  readonly hostCapabilities: readonly string[];
  readonly hostAgentProfileId: string;
  readonly graceMs: number;

  private server: ManagedChild | undefined;
  private host: ManagedChild | undefined;
  private remoteAgentOwnerIdentityToken: string | undefined;
  private enrolled = false;
  private disposed = false;
  private readonly ownedRoots: string[] = [];
  private readonly logFlushTasks = new Set<Promise<void>>();
  private readonly secondaryHosts = new Map<
    string,
    { handle: SecondaryHostHandle; child: ManagedChild | undefined; enrolled: boolean }
  >();

  private constructor(init: {
    paths: HarnessPaths;
    operatorToken: string;
    origin: string;
    port: number;
    projectId: string;
    acpScenario: string;
    readinessTimeoutMs: number;
    hostDisplayName: string;
    hostCapacity: number;
    hostCapabilities: readonly string[];
    hostAgentProfileId: string;
    graceMs: number;
    ownedRoots: string[];
  }) {
    this.paths = init.paths;
    this.operatorToken = init.operatorToken;
    this.origin = init.origin;
    this.port = init.port;
    this.projectId = init.projectId;
    this.acpScenario = init.acpScenario;
    this.readinessTimeoutMs = init.readinessTimeoutMs;
    this.hostDisplayName = init.hostDisplayName;
    this.hostCapacity = init.hostCapacity;
    this.hostCapabilities = init.hostCapabilities;
    this.hostAgentProfileId = init.hostAgentProfileId;
    this.graceMs = init.graceMs;
    this.ownedRoots = init.ownedRoots;
    this.acpControl = new FakeAcpControl(init.paths.control);
  }

  static async create(options: RealProcessAcpHarnessOptions = {}): Promise<RealProcessAcpHarness> {
    const operatorToken = options.operatorToken ?? `pw_operator_${"H".repeat(43)}`;
    const acpScenario = options.acpScenario ?? "artifact-implementation";
    const readinessTimeoutMs =
      options.readinessTimeoutMs ?? REAL_PROCESS_ACP_HARNESS_DEFAULT_TIMEOUT_MS;
    const hostDisplayName = options.hostDisplayName ?? "Harness Host";
    const hostCapacity = options.hostCapacity ?? 2;
    const hostCapabilities = [...new Set(options.hostCapabilities ?? ["acp.codex"])];
    const hostAgentProfile = options.hostAgentProfile ?? {
      id: "codex-acp",
      agentId: "codex"
    };
    const graceMs = options.graceMs ?? 500;

    const workspace = await createTestWorkspace(options.manifest ?? remoteAcpManifest());
    const root = await mkdtemp(join(tmpdir(), "planweave-real-process-acp-"));
    const ownedRoots = [root, workspace.home, workspace.root];

    const paths: HarnessPaths = {
      root,
      projectRoot: workspace.root,
      projectHome: workspace.home,
      serverData: join(root, "server-data"),
      hostData: join(root, "host-data"),
      workspaceRoot: join(root, "workspaces"),
      workspaceProject: join(root, "workspaces", "project"),
      artifacts: join(root, "artifacts"),
      logs: join(root, "logs"),
      control: join(root, "acp-control"),
      agentBin: join(root, "agent-bin"),
      serverConfig: join(root, "server.json"),
      hostConfig: join(root, "agent-host.json"),
      acpLifecycle: join(root, "acp-control", "lifecycle.log")
    };

    await mkdir(paths.serverData, { recursive: true, mode: 0o700 });
    await mkdir(paths.hostData, { recursive: true, mode: 0o700 });
    await mkdir(paths.workspaceProject, { recursive: true });
    await mkdir(paths.artifacts, { recursive: true });
    await mkdir(paths.logs, { recursive: true });
    await mkdir(paths.control, { recursive: true });
    await createAgentExecutableProbe(paths.agentBin);

    const port = await allocateEphemeralPort();
    const origin = `http://127.0.0.1:${port}`;
    const projectId = workspace.init.workspace.id;

    if (options.corruptServerConfigOnCreate) {
      await writeFile(paths.serverConfig, "{not-valid-server-config\n", "utf8");
    } else {
      const serverConfig: Record<string, unknown> = {
        version: "server-config/v1",
        bind: { host: "127.0.0.1", port },
        publicUrl: origin,
        allowInsecureDevelopment: true,
        dataDirectory: paths.serverData,
        trustedProjects: [
          {
            workspaceId: legacyWorkspaceIdForProject(projectId),
            projectId,
            canvasId: "default",
            projectRoot: paths.projectRoot
          }
        ],
        operatorCredentials: [
          {
            operatorId: "harness-operator",
            tokenSha256: hashOperatorToken(operatorToken),
            projectIds: [],
            serverAdmin: true
          },
          ...(options.projectOperatorToken
            ? [
                {
                  operatorId: "harness-project-operator",
                  tokenSha256: hashOperatorToken(options.projectOperatorToken),
                  projectIds: [projectId],
                  serverAdmin: false
                }
              ]
            : [])
        ]
      };
      if (options.serverLimits) {
        serverConfig.limits = {
          busyTimeoutMs: options.serverLimits.busyTimeoutMs ?? 5_000,
          leaseDurationMs: options.serverLimits.leaseDurationMs ?? 30_000,
          hostOfflineAfterMs: options.serverLimits.hostOfflineAfterMs ?? 90_000,
          heartbeatIntervalMs: options.serverLimits.heartbeatIntervalMs ?? 15_000
        };
      }
      await writeFile(paths.serverConfig, JSON.stringify(serverConfig), "utf8");
    }

    await writeFile(
      paths.hostConfig,
      JSON.stringify({
        version: "agent-host-config/v1",
        coordinator: { url: origin, allowInsecureDevelopment: true },
        dataDirectory: paths.hostData,
        workspaceRoot: paths.workspaceRoot,
        host: {
          displayName: hostDisplayName,
          capacity: hostCapacity,
          capabilities: hostCapabilities
        },
        workspaces: [{ id: projectId, path: "project" }],
        agentProfiles: [
          {
            id: hostAgentProfile.id,
            agentId: hostAgentProfile.agentId,
            command: process.execPath,
            args: [acpMockAgentPath, acpScenario, `--control-dir=${paths.control}`],
            environment: []
          }
        ]
      }),
      "utf8"
    );

    return new RealProcessAcpHarness({
      paths,
      operatorToken,
      origin,
      port,
      projectId,
      acpScenario,
      readinessTimeoutMs,
      hostDisplayName,
      hostCapacity,
      hostCapabilities,
      hostAgentProfileId: hostAgentProfile.id,
      graceMs,
      ownedRoots
    });
  }

  authorizationHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.operatorToken}` };
  }

  remoteAgentOwnerIdentityHeaders(): Record<string, string> {
    if (!this.remoteAgentOwnerIdentityToken) {
      throw new Error("real_process_harness_remote_agent_identity_missing");
    }
    return {
      "x-planweave-human-identity": `Bearer ${this.remoteAgentOwnerIdentityToken}`
    };
  }

  redactedServerLogs(): ProcessLogBuffer {
    return {
      stdout: redactLogText(this.server?.logs.stdout ?? ""),
      stderr: redactLogText(this.server?.logs.stderr ?? "")
    };
  }

  redactedHostLogs(): ProcessLogBuffer {
    return {
      stdout: redactLogText(this.host?.logs.stdout ?? ""),
      stderr: redactLogText(this.host?.logs.stderr ?? "")
    };
  }

  serverExitSnapshot(): ProcessExitSnapshot | undefined {
    return this.server?.exitSnapshot;
  }

  hostExitSnapshot(): ProcessExitSnapshot | undefined {
    return this.host?.exitSnapshot;
  }

  serverPid(): number | undefined {
    return this.server?.child.pid;
  }

  hostPid(): number | undefined {
    return this.host?.child.pid;
  }

  advanceInjectedClock(_milliseconds: number): never {
    throw new Error("real_process_acp_harness_clock_not_supported");
  }

  private diagnostics(): string {
    const server = this.redactedServerLogs();
    const host = this.redactedHostLogs();
    return [
      `origin=${this.origin}`,
      `serverPid=${String(this.serverPid() ?? "none")} exit=${JSON.stringify(this.serverExitSnapshot() ?? null)}`,
      `hostPid=${String(this.hostPid() ?? "none")} exit=${JSON.stringify(this.hostExitSnapshot() ?? null)}`,
      `server.stdout:\n${server.stdout || "(empty)"}`,
      `server.stderr:\n${server.stderr || "(empty)"}`,
      `host.stdout:\n${host.stdout || "(empty)"}`,
      `host.stderr:\n${host.stderr || "(empty)"}`
    ].join("\n");
  }

  private spawnLongLived(command: string, args: readonly string[], label: string): ManagedChild {
    const managed = spawnManagedProcess({
      command,
      args: [...args],
      env: { ...process.env },
      graceMs: this.graceMs
    });
    const logs = attachLogCapture(managed.child);
    const { exit, getSnapshot } = trackExit(managed.child);
    const handle: ManagedChild = {
      child: managed.child,
      tree: managed.tree,
      logs,
      exit,
      get exitSnapshot() {
        return getSnapshot();
      }
    };
    // Track log flush so dispose does not race ENOTEMPTY against async writers.
    const flush = exit
      .then(async (snapshot) => {
        if (this.disposed && !existsSync(this.paths.logs)) return;
        await mkdir(this.paths.logs, { recursive: true }).catch(() => undefined);
        await writeFile(
          join(this.paths.logs, `${label}-exit.json`),
          JSON.stringify({ ...snapshot, at: new Date().toISOString() }, null, 2),
          "utf8"
        );
        await writeFile(
          join(this.paths.logs, `${label}.stdout.log`),
          redactLogText(logs.stdout),
          "utf8"
        );
        await writeFile(
          join(this.paths.logs, `${label}.stderr.log`),
          redactLogText(logs.stderr),
          "utf8"
        );
      })
      .catch(() => undefined);
    this.logFlushTasks.add(flush);
    void flush.finally(() => this.logFlushTasks.delete(flush));
    return handle;
  }

  private async rebindEphemeralPort(): Promise<void> {
    const port = await allocateEphemeralPort();
    const origin = `http://127.0.0.1:${port}`;
    this.port = port;
    this.origin = origin;
    if (existsSync(this.paths.serverConfig)) {
      const raw = await readFile(this.paths.serverConfig, "utf8");
      if (raw.startsWith("{")) {
        try {
          const config = JSON.parse(raw) as Record<string, unknown>;
          config.bind = { host: "127.0.0.1", port };
          config.publicUrl = origin;
          await writeFile(this.paths.serverConfig, JSON.stringify(config), "utf8");
        } catch {
          // Corrupt configs are intentional for failure tests; leave them alone.
        }
      }
    }
    if (existsSync(this.paths.hostConfig)) {
      try {
        const hostConfig = JSON.parse(await readFile(this.paths.hostConfig, "utf8")) as {
          coordinator?: { url?: string };
        };
        if (hostConfig.coordinator) {
          hostConfig.coordinator.url = origin;
          await writeFile(this.paths.hostConfig, JSON.stringify(hostConfig), "utf8");
        }
      } catch {
        // Host config may be intentionally corrupt.
      }
    }
  }

  private serverLogsIndicatePortBusy(): boolean {
    const combined = `${this.server?.logs.stdout ?? ""}\n${this.server?.logs.stderr ?? ""}`;
    return /EADDRINUSE|address already in use|listen EADDRINUSE/i.test(combined);
  }

  async startServer(): Promise<void> {
    if (this.disposed) throw new Error("real_process_harness_disposed");
    if (this.server?.tree.isAlive()) throw new Error("real_process_harness_server_already_running");
    // Drop a dead handle from a previous failed start so callers can retry after fixing config.
    this.server = undefined;

    const maxBindAttempts = 5;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxBindAttempts; attempt++) {
      if (attempt > 0) {
        await this.rebindEphemeralPort();
      }
      this.server = this.spawnLongLived(
        process.execPath,
        [serverBinPath, "serve", "--config", this.paths.serverConfig],
        "server"
      );
      try {
        await waitFor(
          () => {
            if (this.server?.exitSnapshot) {
              if (this.serverLogsIndicatePortBusy()) return false;
              return false;
            }
            try {
              const line = this.server?.logs.stdout
                .split("\n")
                .map((value) => value.trim())
                .find((value) => value.startsWith("{") && value.includes("status"));
              if (!line) return false;
              const parsed = serverReadyOutputSchema.safeParse(JSON.parse(line));
              return parsed.success && parsed.data.advertisedOrigin === this.origin;
            } catch {
              return false;
            }
          },
          {
            timeoutMs: this.readinessTimeoutMs,
            label: "server-ready",
            diagnostics: () => this.diagnostics()
          }
        );
        const config = parseServerConfig(
          JSON.parse(await readFile(this.paths.serverConfig, "utf8"))
        );
        await seedOperatorSessions(config.databasePath, config.operatorCredentials);
        return;
      } catch (error) {
        lastError = error;
        const busy = this.serverLogsIndicatePortBusy();
        if (this.server?.tree.isAlive()) {
          await this.stopServer("harness rebind after bind failure").catch(() => undefined);
        } else {
          this.server = undefined;
        }
        if (!busy) throw error;
        if (attempt === maxBindAttempts - 1) throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`real_process_harness_server_bind_failed:${String(lastError)}`);
  }

  async waitForServerReadyz(): Promise<void> {
    await waitFor(
      async () => {
        const response = await fetch(`${this.origin}/readyz`);
        if (!response.ok) return false;
        const body = (await response.json()) as { status?: string };
        return body.status === "ready";
      },
      {
        timeoutMs: this.readinessTimeoutMs,
        label: "server-readyz",
        diagnostics: () => this.diagnostics()
      }
    );
  }

  async stopServer(reason = "harness stopServer"): Promise<ProcessExitSnapshot | undefined> {
    if (!this.server) return undefined;
    const handle = this.server;
    if (handle.tree.isAlive()) {
      await handle.tree.terminate(reason);
    }
    const snapshot = await handle.exit;
    this.server = undefined;
    return snapshot;
  }

  /** Closes HTTP/WSS by terminating the Server process (no production debug endpoint). */
  async closeServerTransport(reason = "harness closeServerTransport"): Promise<void> {
    await this.stopServer(reason);
  }

  async restartServer(): Promise<void> {
    await this.stopServer("harness restartServer");
    await this.startServer();
    await this.waitForServerReadyz();
  }

  async killServer(signal: NodeJS.Signals = "SIGKILL"): Promise<ProcessExitSnapshot | undefined> {
    if (!this.server) return undefined;
    const handle = this.server;
    if (handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill(signal);
    }
    const snapshot = await handle.exit;
    this.server = undefined;
    return snapshot;
  }

  async runHostCommand(
    argv: readonly string[],
    environment: NodeJS.ProcessEnv = {}
  ): Promise<HostCommandResult> {
    const result = await runAgentHostCommand(agentHostBinPath, argv, environment);
    return {
      ...result,
      stdout: redactLogText(result.stdout),
      stderr: redactLogText(result.stderr)
    };
  }

  private async exposeProfile(
    configPath: string,
    profileId: string,
    errorCode: string
  ): Promise<void> {
    const result = await this.runHostCommand(
      ["agents", "expose", profileId, "--config", configPath],
      {
        PATH: [this.paths.agentBin, process.env.PATH].filter(Boolean).join(delimiter),
        PATHEXT: ".CMD"
      }
    );
    if (result.code !== 0) {
      throw new Error(`${errorCode}:${result.code}\n${result.stderr}\n${this.diagnostics()}`);
    }
  }

  async ensureRemoteAgentOwner(): Promise<void> {
    if (this.remoteAgentOwnerIdentityToken) return;
    const response = await fetch(
      `${this.origin}/api/v1/projects/${this.projectId}/human/bootstrap`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Test Remote Agent Owner",
          humanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
        })
      }
    );
    if (response.status !== 201) {
      throw new Error(
        `real_process_harness_remote_agent_owner_failed:${response.status}\n${this.diagnostics()}`
      );
    }
    const bootstrap = z
      .object({ deviceToken: z.string().min(1) })
      .passthrough()
      .parse(await response.json());
    const identityResponse = await fetch(`${this.origin}/api/v1/human-identity/recover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "human-identity/v1",
        existingDeviceToken: bootstrap.deviceToken
      })
    });
    if (identityResponse.status !== 200) {
      throw new Error(
        `real_process_harness_remote_agent_identity_failed:${identityResponse.status}\n${this.diagnostics()}`
      );
    }
    this.remoteAgentOwnerIdentityToken = z
      .object({ identityToken: z.string().min(1) })
      .passthrough()
      .parse(await identityResponse.json()).identityToken;
  }

  async enrollHost(): Promise<void> {
    if (this.disposed) throw new Error("real_process_harness_disposed");
    await this.ensureRemoteAgentOwner();
    const enrollmentExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const grantResponse = await fetch(`${this.origin}/api/v1/host-enrollments`, {
      method: "POST",
      headers: {
        ...this.authorizationHeaders(),
        "x-planweave-human-identity": `Bearer ${this.remoteAgentOwnerIdentityToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        workspaceId: legacyWorkspaceIdForProject(this.projectId),
        expiresAt: enrollmentExpiresAt,
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
        ownerHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID,
        accessMode: "unrestricted",
        createWorkspaceGrant: true
      })
    });
    if (grantResponse.status !== 201) {
      throw new Error(
        `real_process_harness_enroll_grant_failed:${grantResponse.status}\n${this.diagnostics()}`
      );
    }
    const grant = operatorEnrollmentGrantResponseSchema.parse(await grantResponse.json());
    await configureHostWorkspace(this.paths.hostConfig, grant.workspaceId);
    const enrollment = await this.runHostCommand([
      "enroll",
      "--config",
      this.paths.hostConfig,
      "--code",
      grant.enrollmentCode
    ]);
    if (enrollment.code !== 0) {
      throw new Error(
        `real_process_harness_enroll_failed:${enrollment.code}\n${enrollment.stderr}\n${this.diagnostics()}`
      );
    }
    await this.exposeProfile(
      this.paths.hostConfig,
      this.hostAgentProfileId,
      "real_process_harness_agent_expose_failed"
    );
    this.enrolled = true;
  }

  async startHost(): Promise<void> {
    if (this.disposed) throw new Error("real_process_harness_disposed");
    if (this.host?.tree.isAlive()) throw new Error("real_process_harness_host_already_running");
    this.host = undefined;
    if (!this.enrolled) await this.enrollHost();
    this.host = this.spawnLongLived(
      process.execPath,
      [agentHostBinPath, "run", "--config", this.paths.hostConfig],
      "host"
    );
    await this.waitForHostOnline();
  }

  async waitForHostOnline(options?: {
    displayName?: string;
    lastSeenAtNot?: string;
    timeoutMs?: number;
  }): Promise<{ id: string; lastSeenAt: string; displayName: string }> {
    const displayName = options?.displayName ?? this.hostDisplayName;
    let observed: { id: string; lastSeenAt: string; displayName: string } | undefined;
    await waitFor(
      async () => {
        const response = await fetch(`${this.origin}/api/v1/hosts`, {
          headers: this.authorizationHeaders()
        });
        if (!response.ok) return false;
        const page = (await response.json()) as {
          items: Array<{ id: string; lastSeenAt?: string; displayName?: string }>;
        };
        const match = page.items.find(
          (item) => item.displayName === displayName && typeof item.lastSeenAt === "string"
        );
        if (!match?.lastSeenAt) return false;
        if (options?.lastSeenAtNot !== undefined && match.lastSeenAt === options.lastSeenAtNot) {
          return false;
        }
        observed = { id: match.id, lastSeenAt: match.lastSeenAt, displayName };
        return true;
      },
      {
        timeoutMs: options?.timeoutMs ?? this.readinessTimeoutMs,
        label: options?.lastSeenAtNot ? "host-online-refreshed" : `host-online:${displayName}`,
        diagnostics: () => this.diagnostics()
      }
    );
    if (!observed) throw new Error("real_process_harness_host_online_missing");
    return observed;
  }

  /**
   * Enroll and start an additional Host process against the same Server.
   * Used for capability/capacity selection scenarios. Credentials are separate.
   */
  async startSecondaryHost(
    options: SecondaryHostOptions
  ): Promise<{ id: string; lastSeenAt: string; handle: SecondaryHostHandle }> {
    if (this.disposed) throw new Error("real_process_harness_disposed");
    const key = options.key ?? options.displayName.replace(/\s+/g, "-").toLowerCase();
    if (this.secondaryHosts.has(key))
      throw new Error(`real_process_harness_secondary_exists:${key}`);
    const capacity = options.capacity ?? 1;
    const capabilities = [...new Set(options.capabilities ?? ["acp.codex"])];
    const acpScenario = options.acpScenario ?? this.acpScenario;
    const dataDir = join(this.paths.root, `host-data-${key}`);
    const controlDir = join(this.paths.root, `acp-control-${key}`);
    const configPath = join(this.paths.root, `agent-host-${key}.json`);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await mkdir(controlDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        version: "agent-host-config/v1",
        coordinator: { url: this.origin, allowInsecureDevelopment: true },
        dataDirectory: dataDir,
        workspaceRoot: this.paths.workspaceRoot,
        host: {
          displayName: options.displayName,
          capacity,
          capabilities
        },
        workspaces: [{ id: this.projectId, path: "project" }],
        agentProfiles: [
          {
            id: "codex-acp",
            agentId: "codex",
            command: process.execPath,
            args: [acpMockAgentPath, acpScenario, `--control-dir=${controlDir}`],
            environment: []
          }
        ]
      }),
      "utf8"
    );
    const handle: SecondaryHostHandle = {
      key,
      displayName: options.displayName,
      capacity,
      capabilities,
      dataDir,
      configPath,
      controlDir
    };
    this.secondaryHosts.set(key, { handle, child: undefined, enrolled: false });

    await this.ensureRemoteAgentOwner();
    const enrollmentExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const grantResponse = await fetch(`${this.origin}/api/v1/host-enrollments`, {
      method: "POST",
      headers: {
        ...this.authorizationHeaders(),
        "x-planweave-human-identity": `Bearer ${this.remoteAgentOwnerIdentityToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        workspaceId: legacyWorkspaceIdForProject(this.projectId),
        expiresAt: enrollmentExpiresAt,
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
        ownerHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID,
        accessMode: "unrestricted",
        createWorkspaceGrant: true
      })
    });
    if (grantResponse.status !== 201) {
      throw new Error(
        `real_process_harness_secondary_enroll_grant_failed:${grantResponse.status}\n${this.diagnostics()}`
      );
    }
    const grant = operatorEnrollmentGrantResponseSchema.parse(await grantResponse.json());
    await configureHostWorkspace(configPath, grant.workspaceId);
    const enrollment = await this.runHostCommand([
      "enroll",
      "--config",
      configPath,
      "--code",
      grant.enrollmentCode
    ]);
    if (enrollment.code !== 0) {
      throw new Error(
        `real_process_harness_secondary_enroll_failed:${enrollment.code}\n${enrollment.stderr}\n${this.diagnostics()}`
      );
    }
    await this.exposeProfile(
      configPath,
      "codex-acp",
      "real_process_harness_secondary_agent_expose_failed"
    );
    const entry = this.secondaryHosts.get(key)!;
    entry.enrolled = true;
    entry.child = this.spawnLongLived(
      process.execPath,
      [agentHostBinPath, "run", "--config", configPath],
      `host-${key}`
    );
    const online = await this.waitForHostOnline({ displayName: options.displayName });
    return { id: online.id, lastSeenAt: online.lastSeenAt, handle };
  }

  async stopSecondaryHost(
    key: string,
    reason = "harness stopSecondaryHost"
  ): Promise<ProcessExitSnapshot | undefined> {
    const entry = this.secondaryHosts.get(key);
    if (!entry?.child) return undefined;
    const handle = entry.child;
    if (handle.tree.isAlive()) await handle.tree.terminate(reason);
    const snapshot = await handle.exit;
    entry.child = undefined;
    return snapshot;
  }

  async stopHost(reason = "harness stopHost"): Promise<ProcessExitSnapshot | undefined> {
    if (!this.host) return undefined;
    const handle = this.host;
    if (handle.tree.isAlive()) {
      await handle.tree.terminate(reason);
    }
    const snapshot = await handle.exit;
    this.host = undefined;
    return snapshot;
  }

  async restartHost(options?: { previousLastSeenAt?: string }): Promise<{
    id: string;
    lastSeenAt: string;
  }> {
    const previousLastSeenAt =
      options?.previousLastSeenAt ??
      (await this.waitForHostOnline().catch(() => undefined))?.lastSeenAt;
    await this.stopHost("harness restartHost");
    // Credential remains in host dataDirectory; do not re-enroll.
    this.host = this.spawnLongLived(
      process.execPath,
      [agentHostBinPath, "run", "--config", this.paths.hostConfig],
      "host"
    );
    return this.waitForHostOnline(
      previousLastSeenAt ? { lastSeenAtNot: previousLastSeenAt } : undefined
    );
  }

  async killHost(signal: NodeJS.Signals = "SIGKILL"): Promise<ProcessExitSnapshot | undefined> {
    if (!this.host) return undefined;
    const handle = this.host;
    if (handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill(signal);
    }
    const snapshot = await handle.exit;
    this.host = undefined;
    return snapshot;
  }

  async startAll(): Promise<void> {
    await this.startServer();
    await this.waitForServerReadyz();
    await this.startHost();
  }

  async corruptScopedPayload(
    kind: "server-config" | "host-config" | "acp-next-frame"
  ): Promise<void> {
    if (kind === "server-config") {
      await writeFile(this.paths.serverConfig, "{corrupt-server-config\n", "utf8");
      return;
    }
    if (kind === "host-config") {
      await writeFile(this.paths.hostConfig, "{corrupt-host-config\n", "utf8");
      return;
    }
    await this.acpControl.corruptNextStdoutFrame();
  }

  /**
   * Spawn the fake ACP executable directly (not via Host) for barrier/control self-tests.
   */
  spawnFakeAcpDirect(scenario = this.acpScenario): ManagedChild {
    return this.spawnLongLived(
      process.execPath,
      [acpMockAgentPath, scenario, `--control-dir=${this.paths.control}`],
      "fake-acp"
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    const forceStop = async (child: ManagedChild | undefined, reason: string): Promise<void> => {
      if (!child) return;
      try {
        await stopManagedChildForCleanup(child, reason);
      } catch (error) {
        errors.push(error);
      }
    };

    for (const [key, entry] of [...this.secondaryHosts.entries()]) {
      try {
        await forceStop(entry.child, `harness dispose secondary:${key}`);
      } catch (error) {
        errors.push(error);
      }
      entry.child = undefined;
    }
    this.secondaryHosts.clear();
    try {
      await forceStop(this.host, "harness dispose host");
    } catch (error) {
      errors.push(error);
    }
    this.host = undefined;
    try {
      await forceStop(this.server, "harness dispose server");
    } catch (error) {
      errors.push(error);
    }
    this.server = undefined;

    // Drain async log writers so recursive rm does not race ENOTEMPTY.
    await Promise.allSettled([...this.logFlushTasks]);
    this.logFlushTasks.clear();

    // Best-effort: only remove harness-created roots.
    for (const directory of this.ownedRoots.splice(0)) {
      try {
        await removeDirectoryWithRetries(directory);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `real_process_harness_dispose_failed:${errors
          .map((error) => (error instanceof Error ? error.message : String(error)))
          .join("; ")}`
      );
    }
  }
}
