import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertTunnelClientBinaryStartTarget } from "./binary.js";
import { StartLifecycle } from "./startLifecycle.js";
import { childClosed, terminateChild } from "./childLifecycle.js";
import type {
  TunnelClientArgsInput,
  TunnelClientBinaryStartTarget,
  TunnelClientExecutableName,
  TunnelClientStatus
} from "./types.js";

const profileName = "planweave-local-http";
const healthListenAddr = "127.0.0.1:0";
const defaultHealthUrlTimeoutMs = 15_000;
const defaultReadyTimeoutMs = 15_000;

export function buildTunnelClientInitArgs(input: TunnelClientArgsInput): string[] {
  return [
    "init",
    "--sample",
    "sample_mcp_with_dcr",
    "--profile",
    profileName,
    "--force",
    "--tunnel-id",
    input.tunnelId,
    "--mcp-server-url",
    input.mcpServerUrl
  ];
}

export function buildTunnelClientRunArgs(healthUrlFile: string): string[] {
  return [
    "run",
    "--profile",
    profileName,
    "--harpoon.allow-plaintext-http",
    "--health.listen-addr",
    healthListenAddr,
    "--health.url-file",
    healthUrlFile
  ];
}

function tunnelClientCommand(binary: TunnelClientBinaryStartTarget): TunnelClientExecutableName {
  return binary.executableName === "tunnel-client.exe" ? "tunnel-client.exe" : "tunnel-client";
}

function buildTunnelClientEnv(
  binary: TunnelClientBinaryStartTarget,
  runtimeApiKey: string,
  tunnelId: string
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: process.env.PATH
      ? `${binary.executableDir}${delimiter}${process.env.PATH}`
      : binary.executableDir,
    CONTROL_PLANE_TUNNEL_ID: tunnelId,
    CONTROL_PLANE_API_KEY: runtimeApiKey
  };
}

function execTunnelClient(
  binary: TunnelClientBinaryStartTarget,
  args: string[],
  runtimeApiKey: string,
  tunnelId: string,
  signal: AbortSignal
): Promise<void> {
  let child!: ChildProcess;
  const result = new Promise<void>((resolve, reject) => {
    child = execFile(
      tunnelClientCommand(binary),
      args,
      {
        cwd: binary.executableDir,
        env: buildTunnelClientEnv(binary, runtimeApiKey, tunnelId),
        shell: false,
        timeout: 30_000,
        signal
      },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }
    );
  });
  const closed = childClosed(child);
  return result.finally(async () => {
    if (signal.aborted) await terminateChild(child, closed);
    else await closed;
  });
}

function redactValue(message: string, value: string, replacement: string): string {
  return value ? message.split(value).join(replacement) : message;
}

function redactTunnelClientError(
  error: unknown,
  secrets: { runtimeApiKey: string; tunnelId: string }
): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactValue(
    redactValue(message, secrets.runtimeApiKey, "[redacted-runtime-api-key]"),
    secrets.tunnelId,
    "[redacted-tunnel-id]"
  );
}

export class TunnelClientProcessManager {
  private lifecycle = new StartLifecycle<TunnelClientStatus>();
  private child: ChildProcess | null = null;
  private closed: Promise<void> | null = null;
  private healthUrlTimeoutMs: number;
  private onStatusChange: (() => void) | null;
  private readyTimeoutMs: number;
  private status: TunnelClientStatus = {
    phase: "stopped",
    profile: profileName,
    tunnelId: null,
    pid: null,
    healthUrl: null,
    ready: false,
    error: null
  };

  constructor(
    options: {
      healthUrlTimeoutMs?: number;
      onStatusChange?: () => void;
      readyTimeoutMs?: number;
    } = {}
  ) {
    this.healthUrlTimeoutMs = options.healthUrlTimeoutMs ?? defaultHealthUrlTimeoutMs;
    this.onStatusChange = options.onStatusChange ?? null;
    this.readyTimeoutMs = options.readyTimeoutMs ?? defaultReadyTimeoutMs;
  }

  getStatus(): TunnelClientStatus {
    return this.status;
  }

  start(options: {
    binary: TunnelClientBinaryStartTarget;
    localMcpEndpoint: string;
    input: {
      tunnelId: string;
      runtimeApiKey: string;
    };
  }): Promise<TunnelClientStatus> {
    if (this.child && this.status.phase === "running") {
      return Promise.resolve(this.status);
    }
    return this.lifecycle.start((signal) => this.startOwned(options, signal));
  }

  private async startOwned(
    options: Parameters<TunnelClientProcessManager["start"]>[0],
    signal: AbortSignal
  ): Promise<TunnelClientStatus> {
    const tunnelId = options.input.tunnelId.trim();
    const runtimeApiKey = options.input.runtimeApiKey.trim();
    if (!tunnelId) {
      throw new Error("tunnel_id is required.");
    }
    if (!runtimeApiKey) {
      throw new Error("Runtime API key is required.");
    }
    this.status = {
      phase: "starting",
      profile: profileName,
      tunnelId,
      pid: null,
      healthUrl: null,
      ready: false,
      error: null
    };
    try {
      if (this.child && this.closed) {
        await terminateChild(this.child, this.closed);
        this.child = null;
        signal.throwIfAborted();
      }
      const binary = assertTunnelClientBinaryStartTarget(options.binary);
      await execTunnelClient(
        binary,
        buildTunnelClientInitArgs({
          tunnelId,
          mcpServerUrl: options.localMcpEndpoint
        }),
        runtimeApiKey,
        tunnelId,
        signal
      );
      let healthDir: string | null = null;
      let child: ChildProcess | null = null;
      try {
        healthDir = await mkdtemp(join(tmpdir(), "planweave-tunnel-health-"));
        signal.throwIfAborted();
        const healthUrlFile = join(healthDir, "url");
        child = spawn(tunnelClientCommand(binary), buildTunnelClientRunArgs(healthUrlFile), {
          cwd: binary.executableDir,
          env: buildTunnelClientEnv(binary, runtimeApiKey, tunnelId),
          shell: false,
          stdio: ["ignore", "ignore", "ignore"]
        });
        this.child = child;
        const closed = childClosed(child);
        this.closed = closed;
        let lastHealthUrl: string | null = null;
        child.once("exit", (code, exitSignal) => {
          if (this.child !== child || !this.lifecycle.owns(signal)) {
            return;
          }
          this.child = null;
          if (this.status.phase === "error") {
            this.status = {
              ...this.status,
              pid: null,
              ready: false
            };
            this.onStatusChange?.();
            return;
          }
          this.status = {
            phase: code === 0 ? "stopped" : "error",
            profile: profileName,
            tunnelId,
            pid: null,
            healthUrl: lastHealthUrl,
            ready: false,
            error:
              code === 0
                ? null
                : `tunnel-client exited with code ${code ?? "null"} signal ${exitSignal ?? "null"}.`
          };
          this.onStatusChange?.();
        });
        child.on("error", (error) => {
          if (this.child !== child || !this.lifecycle.owns(signal)) return;
          this.status = {
            ...this.status,
            phase: "error",
            ready: false,
            error: redactTunnelClientError(error, { runtimeApiKey, tunnelId })
          };
          this.onStatusChange?.();
        });
        const healthUrl = await this.waitForHealthUrl(
          child,
          healthUrlFile,
          this.healthUrlTimeoutMs,
          signal
        );
        lastHealthUrl = healthUrl;
        const ready = await this.waitForReady(healthUrl, this.readyTimeoutMs, signal);
        signal.throwIfAborted();
        this.status = {
          phase: ready ? "running" : "error",
          profile: profileName,
          tunnelId,
          pid: child.pid ?? null,
          healthUrl,
          ready,
          error: ready ? null : "tunnel-client started but /readyz is not ready."
        };
        if (!ready) {
          await terminateChild(child, closed);
          if (this.child === child) this.child = null;
          this.status = { ...this.status, pid: null };
        }
      } catch (error) {
        if (child && this.closed) {
          await terminateChild(child, this.closed);
        }
        throw error;
      } finally {
        if (healthDir) {
          await rm(healthDir, { recursive: true, force: true });
        }
      }
    } catch (error) {
      const cancelled = signal.aborted && error instanceof Error && error.name === "AbortError";
      const cleanupFailed =
        this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
      if (!cleanupFailed) this.child = null;
      this.status = {
        phase: cancelled && !cleanupFailed ? "stopped" : "error",
        profile: profileName,
        tunnelId,
        pid: cleanupFailed ? (this.child?.pid ?? null) : null,
        healthUrl: null,
        ready: false,
        error:
          cancelled && !cleanupFailed
            ? null
            : redactTunnelClientError(error, { runtimeApiKey, tunnelId })
      };
      if (signal.aborted && (!cancelled || cleanupFailed)) throw error;
    }
    return this.status;
  }

  stop(): Promise<TunnelClientStatus> {
    this.status = { ...this.status, phase: "stopping", ready: false };
    return this.lifecycle
      .stop(() => this.stopOwned())
      .catch((error: unknown) => {
        this.status = {
          ...this.status,
          phase: "error",
          ready: false,
          error: this.status.error ?? (error instanceof Error ? error.message : String(error))
        };
        throw error;
      });
  }

  private async stopOwned(): Promise<TunnelClientStatus> {
    if (!this.child) {
      this.status = {
        phase: "stopped",
        profile: profileName,
        tunnelId: this.status.tunnelId,
        pid: null,
        healthUrl: null,
        ready: false,
        error: null
      };
      return this.status;
    }
    const child = this.child;
    this.status = { ...this.status, phase: "stopping", ready: false };
    if (!this.closed) throw new Error("Tunnel child closure is missing.");
    await terminateChild(child, this.closed);
    if (this.child === child) {
      this.child = null;
    }
    this.status = {
      phase: "stopped",
      profile: profileName,
      tunnelId: this.status.tunnelId,
      pid: null,
      healthUrl: null,
      ready: false,
      error: null
    };
    return this.status;
  }

  private async waitForHealthUrl(
    child: ChildProcess,
    healthUrlFile: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<string> {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const onExit = () =>
      controller.abort(new Error("tunnel-client exited before reporting a health URL."));
    const onError = (error: Error) => controller.abort(error);
    child.once("exit", onExit);
    child.once("error", onError);
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() <= deadline) {
        combined.throwIfAborted();
        try {
          const healthUrl = (
            await readFile(healthUrlFile, { encoding: "utf8", signal: combined })
          ).trim();
          combined.throwIfAborted();
          if (/^https?:\/\/127\.0\.0\.1:\d+$/.test(healthUrl)) return healthUrl;
        } catch (error) {
          combined.throwIfAborted();
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        await delay(100, undefined, { signal: combined });
      }
      throw new Error("Timed out waiting for tunnel-client health URL.");
    } finally {
      child.off("exit", onExit);
      child.off("error", onError);
    }
  }

  private async waitForReady(
    healthUrl: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = Math.min(250, Math.max(25, timeoutMs));
    while (Date.now() <= deadline) {
      signal.throwIfAborted();
      try {
        const requestSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(1, deadline - Date.now()))
        ]);
        const response = await fetch(`${healthUrl}/readyz`, { signal: requestSignal });
        signal.throwIfAborted();
        if (response.ok) return true;
      } catch {
        signal.throwIfAborted();
        // Readiness can legitimately be unavailable while the child initializes.
      }
      if (Date.now() >= deadline) break;
      await delay(Math.min(pollIntervalMs, deadline - Date.now()), undefined, { signal });
    }
    return false;
  }
}
