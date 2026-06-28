import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { assertTunnelClientBinaryStartTarget } from "./binary.js";
import type { TunnelClientArgsInput, TunnelClientBinaryStartTarget, TunnelClientExecutableName, TunnelClientStatus } from "./types.js";

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
  return ["run", "--profile", profileName, "--harpoon.allow-plaintext-http", "--health.listen-addr", healthListenAddr, "--health.url-file", healthUrlFile];
}

function tunnelClientCommand(binary: TunnelClientBinaryStartTarget): TunnelClientExecutableName {
  return binary.executableName === "tunnel-client.exe" ? "tunnel-client.exe" : "tunnel-client";
}

function buildTunnelClientEnv(binary: TunnelClientBinaryStartTarget, runtimeApiKey: string, tunnelId: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: process.env.PATH ? `${binary.executableDir}${delimiter}${process.env.PATH}` : binary.executableDir,
    CONTROL_PLANE_TUNNEL_ID: tunnelId,
    CONTROL_PLANE_API_KEY: runtimeApiKey
  };
}

function execTunnelClient(binary: TunnelClientBinaryStartTarget, args: string[], runtimeApiKey: string, tunnelId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      tunnelClientCommand(binary),
      args,
      {
        cwd: binary.executableDir,
        env: buildTunnelClientEnv(binary, runtimeApiKey, tunnelId),
        shell: false,
        timeout: 30_000
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
}

function redactValue(message: string, value: string, replacement: string): string {
  return value ? message.split(value).join(replacement) : message;
}

function redactTunnelClientError(error: unknown, secrets: { runtimeApiKey: string; tunnelId: string }): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactValue(redactValue(message, secrets.runtimeApiKey, "[redacted-runtime-api-key]"), secrets.tunnelId, "[redacted-tunnel-id]");
}

export class TunnelClientProcessManager {
  private child: ChildProcess | null = null;
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

  constructor(options: { healthUrlTimeoutMs?: number; onStatusChange?: () => void; readyTimeoutMs?: number } = {}) {
    this.healthUrlTimeoutMs = options.healthUrlTimeoutMs ?? defaultHealthUrlTimeoutMs;
    this.onStatusChange = options.onStatusChange ?? null;
    this.readyTimeoutMs = options.readyTimeoutMs ?? defaultReadyTimeoutMs;
  }

  getStatus(): TunnelClientStatus {
    return this.status;
  }

  async start(options: {
    binary: TunnelClientBinaryStartTarget;
    localMcpEndpoint: string;
    input: {
      tunnelId: string;
      runtimeApiKey: string;
    };
  }): Promise<TunnelClientStatus> {
    if (this.child && this.status.phase === "running") {
      return this.status;
    }
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
      const binary = assertTunnelClientBinaryStartTarget(options.binary);
      await execTunnelClient(
        binary,
        buildTunnelClientInitArgs({
          tunnelId,
          mcpServerUrl: options.localMcpEndpoint
        }),
        runtimeApiKey,
        tunnelId
      );
      let healthDir: string | null = null;
      let child: ChildProcess | null = null;
      try {
        healthDir = await mkdtemp(join(tmpdir(), "planweave-tunnel-health-"));
        const healthUrlFile = join(healthDir, "url");
        child = spawn(tunnelClientCommand(binary), buildTunnelClientRunArgs(healthUrlFile), {
          cwd: binary.executableDir,
          env: buildTunnelClientEnv(binary, runtimeApiKey, tunnelId),
          shell: false,
          stdio: ["ignore", "ignore", "ignore"]
        });
        this.child = child;
        let lastHealthUrl: string | null = null;
        child.once("exit", (code, signal) => {
          if (this.child !== child) {
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
            error: code === 0 ? null : `tunnel-client exited with code ${code ?? "null"} signal ${signal ?? "null"}.`
          };
          this.onStatusChange?.();
        });
        const healthUrl = await this.waitForHealthUrl(child, healthUrlFile, this.healthUrlTimeoutMs);
        lastHealthUrl = healthUrl;
        const ready = await this.waitForReady(healthUrl, this.readyTimeoutMs);
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
          child.kill("SIGTERM");
        }
      } catch (error) {
        if (child && !child.killed) {
          child.kill("SIGTERM");
        }
        throw error;
      } finally {
        if (healthDir) {
          void rm(healthDir, { recursive: true, force: true });
        }
      }
    } catch (error) {
      this.child = null;
      this.status = {
        phase: "error",
        profile: profileName,
        tunnelId,
        pid: null,
        healthUrl: null,
        ready: false,
        error: redactTunnelClientError(error, { runtimeApiKey, tunnelId })
      };
    }
    return this.status;
  }

  async stop(): Promise<TunnelClientStatus> {
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
    await new Promise<void>((resolve) => {
      let exited = false;
      child.once("exit", () => {
        exited = true;
        resolve();
      });
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!exited) {
          child.kill("SIGKILL");
        }
        resolve();
      }, 3_000).unref();
    });
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

  private waitForHealthUrl(child: ChildProcess, healthUrlFile: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for tunnel-client health URL."));
      }, timeoutMs);
      const interval = setInterval(() => {
        void readFile(healthUrlFile, "utf8").then((content) => {
          if (settled) {
            return;
          }
          const healthUrl = content.trim();
          if (!/^https?:\/\/127\.0\.0\.1:\d+$/.test(healthUrl)) {
            return;
          }
          settled = true;
          cleanup();
          resolve(healthUrl);
        }).catch(() => undefined);
      }, 100);
      const handleExit = () => {
        settled = true;
        cleanup();
        reject(new Error("tunnel-client exited before reporting a health URL."));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(interval);
        child.off("exit", handleExit);
      };
      child.once("exit", handleExit);
    });
  }

  private async checkReady(healthUrl: string): Promise<boolean> {
    try {
      const response = await fetch(`${healthUrl}/readyz`);
      return response.ok;
    } catch {
      return false;
    }
  }

  private async waitForReady(healthUrl: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = Math.min(250, Math.max(25, timeoutMs));
    while (Date.now() <= deadline) {
      if (await this.checkReady(healthUrl)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return false;
  }
}
