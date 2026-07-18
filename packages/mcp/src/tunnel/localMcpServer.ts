import type { Server } from "node:http";
import { resolvePlanweaveHome } from "@planweave-ai/runtime";
import type { McpConfig, McpOAuthConfig } from "../config.js";
import type { LocalMcpServerStatus } from "./types.js";

const defaultHost = "127.0.0.1";
const defaultPort = 8787;
const defaultMaxRequestBodyBytes = 1_048_576;

function nowStatus(status: LocalMcpServerStatus): LocalMcpServerStatus {
  return status;
}

export type LocalMcpServerManagerOptions = {
  host?: string;
  port?: number;
  maxRequestBodyBytes?: number;
  oauth?: McpOAuthConfig | ((planweaveHome: string) => McpOAuthConfig | undefined);
  trustForwardedHeaders?: boolean;
};

export class LocalMcpServerManager {
  private server: Server | null = null;
  private options: Required<
    Pick<
      LocalMcpServerManagerOptions,
      "host" | "maxRequestBodyBytes" | "port" | "trustForwardedHeaders"
    >
  > &
    Pick<LocalMcpServerManagerOptions, "oauth">;
  private status: LocalMcpServerStatus;

  constructor(options: LocalMcpServerManagerOptions = {}) {
    this.options = {
      host: options.host ?? defaultHost,
      maxRequestBodyBytes: options.maxRequestBodyBytes ?? defaultMaxRequestBodyBytes,
      port: options.port ?? defaultPort,
      oauth: options.oauth,
      trustForwardedHeaders: options.trustForwardedHeaders ?? false
    };
    this.status = nowStatus({
      phase: "stopped",
      endpoint: null,
      host: this.options.host,
      port: this.options.port,
      pid: null,
      planweaveHome: resolvePlanweaveHome(),
      planweaveHomeFromEnv: Boolean(process.env.PLANWEAVE_HOME),
      healthy: false,
      error: null
    });
  }

  getStatus(): LocalMcpServerStatus {
    return this.status;
  }

  async start(
    input: {
      host?: string | null;
      port?: number | null;
      oauth?: McpOAuthConfig | null;
      token?: string | null;
      trustForwardedHeaders?: boolean;
    } = {}
  ): Promise<LocalMcpServerStatus> {
    if (this.server && this.status.phase === "running") {
      return this.status;
    }
    const host = input.host?.trim() || this.options.host;
    const port = input.port ?? this.options.port;
    const planweaveHome = resolvePlanweaveHome();
    this.status = nowStatus({
      phase: "starting",
      endpoint: `http://${host}:${port}/mcp`,
      host,
      port,
      pid: process.pid,
      planweaveHome,
      planweaveHomeFromEnv: Boolean(process.env.PLANWEAVE_HOME),
      healthy: false,
      error: null
    });
    try {
      const config: McpConfig = {
        host,
        maxRequestBodyBytes: this.options.maxRequestBodyBytes,
        oauth: input.oauth ?? this.resolveOAuth(planweaveHome),
        port,
        token: input.token?.trim() || undefined,
        planweaveHomeFromEnv: Boolean(process.env.PLANWEAVE_HOME),
        trustForwardedHeaders: input.trustForwardedHeaders ?? this.options.trustForwardedHeaders
      };
      const { listenPlanweaveMcpServer } = await import("../server.js");
      this.server = await listenPlanweaveMcpServer(config);
      this.status = nowStatus({
        phase: "running",
        endpoint: `http://${host}:${port}/mcp`,
        host,
        port,
        pid: process.pid,
        planweaveHome: resolvePlanweaveHome(),
        planweaveHomeFromEnv: Boolean(process.env.PLANWEAVE_HOME),
        healthy: await this.checkHealth(host, port),
        error: null
      });
    } catch (error) {
      this.server = null;
      this.status = nowStatus({
        phase: "error",
        endpoint: null,
        host,
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
        host: this.status.host,
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
        host: this.status.host,
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

  private resolveOAuth(planweaveHome: string): McpOAuthConfig | undefined {
    if (typeof this.options.oauth === "function") {
      return this.options.oauth(planweaveHome);
    }
    return this.options.oauth;
  }

  private async checkHealth(host: string, port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://${host}:${port}/healthz`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
