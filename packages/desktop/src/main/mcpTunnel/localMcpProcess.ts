import type { Server } from "node:http";
import { join } from "node:path";
import { listenPlanweaveMcpServer } from "@planweave-ai/mcp";
import { resolvePlanweaveHome } from "@planweave-ai/runtime";
import type { LocalMcpServerStatus } from "../../shared/mcpTunnel.js";

const defaultHost = "127.0.0.1";
const defaultPort = 8787;
const desktopOAuthAccessTokenTtlMs = 30 * 24 * 60 * 60 * 1000;

function nowStatus(status: Omit<LocalMcpServerStatus, "host">): LocalMcpServerStatus {
  return {
    host: defaultHost,
    ...status
  };
}

export class LocalMcpServerManager {
  private server: Server | null = null;
  private status: LocalMcpServerStatus = nowStatus({
    phase: "stopped",
    endpoint: null,
    port: defaultPort,
    pid: null,
    planweaveHome: resolvePlanweaveHome(),
    planweaveHomeFromEnv: Boolean(process.env.PLANWEAVE_HOME),
    healthy: false,
    error: null
  });

  getStatus(): LocalMcpServerStatus {
    return this.status;
  }

  async start(input: { port?: number | null } = {}): Promise<LocalMcpServerStatus> {
    if (this.server && this.status.phase === "running") {
      return this.status;
    }
    const port = input.port ?? defaultPort;
    this.status = nowStatus({
      phase: "starting",
      endpoint: `http://${defaultHost}:${port}/mcp`,
      port,
      pid: process.pid,
      planweaveHome: resolvePlanweaveHome(),
      planweaveHomeFromEnv: Boolean(process.env.PLANWEAVE_HOME),
      healthy: false,
      error: null
    });
    try {
      this.server = await listenPlanweaveMcpServer({
        host: defaultHost,
        maxRequestBodyBytes: 1_048_576,
        oauth: {
          enabled: true,
          accessTokenTtlMs: desktopOAuthAccessTokenTtlMs,
          clientStorePath: join(resolvePlanweaveHome(), "desktop", "mcp-oauth-clients.json"),
          tokenStorePath: join(resolvePlanweaveHome(), "desktop", "mcp-oauth-tokens.json")
        },
        port,
        planweaveHomeFromEnv: Boolean(process.env.PLANWEAVE_HOME)
      });
      this.status = nowStatus({
        phase: "running",
        endpoint: `http://${defaultHost}:${port}/mcp`,
        port,
        pid: process.pid,
        planweaveHome: resolvePlanweaveHome(),
        planweaveHomeFromEnv: Boolean(process.env.PLANWEAVE_HOME),
        healthy: await this.checkHealth(port),
        error: null
      });
    } catch (error) {
      this.server = null;
      this.status = nowStatus({
        phase: "error",
        endpoint: null,
        port,
        pid: null,
        planweaveHome: resolvePlanweaveHome(),
        planweaveHomeFromEnv: Boolean(process.env.PLANWEAVE_HOME),
        healthy: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return this.status;
  }

  async stop(): Promise<LocalMcpServerStatus> {
    if (!this.server) {
      this.status = nowStatus({
        phase: "stopped",
        endpoint: null,
        port: this.status.port,
        pid: null,
        planweaveHome: resolvePlanweaveHome(),
        planweaveHomeFromEnv: Boolean(process.env.PLANWEAVE_HOME),
        healthy: false,
        error: null
      });
      return this.status;
    }
    const server = this.server;
    this.status = { ...this.status, phase: "stopping" };
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }).catch((error: unknown) => {
      this.status = {
        ...this.status,
        phase: "error",
        healthy: false,
        error: error instanceof Error ? error.message : String(error)
      };
    });
    this.server = null;
    if (this.status.phase !== "error") {
      this.status = nowStatus({
        phase: "stopped",
        endpoint: null,
        port: this.status.port,
        pid: null,
        planweaveHome: resolvePlanweaveHome(),
        planweaveHomeFromEnv: Boolean(process.env.PLANWEAVE_HOME),
        healthy: false,
        error: null
      });
    }
    return this.status;
  }

  private async checkHealth(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://${defaultHost}:${port}/healthz`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
