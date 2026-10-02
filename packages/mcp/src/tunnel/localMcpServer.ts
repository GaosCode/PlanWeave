import type { Server } from "node:http";
import { resolvePlanweaveHome } from "@planweave-ai/runtime";
import type { McpConfig, McpOAuthConfig } from "../config.js";
import type { LocalMcpServerStatus } from "./types.js";
import { StartLifecycle } from "./startLifecycle.js";

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
  private lifecycle = new StartLifecycle<LocalMcpServerStatus>();
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

  start(
    input: {
      host?: string | null;
      port?: number | null;
      oauth?: McpOAuthConfig | null;
      token?: string | null;
      trustForwardedHeaders?: boolean;
    } = {}
  ): Promise<LocalMcpServerStatus> {
    if (this.server && this.status.phase === "running") {
      return Promise.resolve(this.status);
    }
    return this.lifecycle.start((signal) => this.startOwned(input, signal));
  }

  private async startOwned(
    input: Parameters<LocalMcpServerManager["start"]>[0],
    signal: AbortSignal
  ): Promise<LocalMcpServerStatus> {
    input ??= {};
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
      if (this.server) {
        await this.closeServer(this.server);
        this.server = null;
        signal.throwIfAborted();
      }
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
      signal.throwIfAborted();
      this.server = await listenPlanweaveMcpServer(config);
      signal.throwIfAborted();
      const healthy = await this.checkHealth(host, port, signal);
      signal.throwIfAborted();
      this.status = nowStatus({
        phase: "running",
        endpoint: `http://${host}:${port}/mcp`,
        host,
        port,
        pid: process.pid,
        planweaveHome: resolvePlanweaveHome(),
        planweaveHomeFromEnv: Boolean(process.env.PLANWEAVE_HOME),
        healthy,
        error: null
      });
    } catch (error) {
      if (this.server) {
        await this.closeServer(this.server);
        this.server = null;
      }
      this.status = nowStatus({
        phase: signal.aborted ? "stopped" : "error",
        endpoint: null,
        host,
        port,
        pid: null,
        planweaveHome: resolvePlanweaveHome(),
        planweaveHomeFromEnv: Boolean(process.env.PLANWEAVE_HOME),
        healthy: false,
        error: signal.aborted ? null : error instanceof Error ? error.message : String(error)
      });
    }
    return this.status;
  }

  stop(): Promise<LocalMcpServerStatus> {
    this.status = { ...this.status, phase: "stopping", healthy: false };
    return this.lifecycle
      .stop(() => this.stopOwned())
      .catch((error: unknown) => {
        this.status = {
          ...this.status,
          phase: "error",
          healthy: false,
          error: error instanceof Error ? error.message : String(error)
        };
        throw error;
      });
  }

  private async stopOwned(): Promise<LocalMcpServerStatus> {
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
    await this.closeServer(server).catch((error: unknown) => {
      this.status = {
        ...this.status,
        phase: "error",
        healthy: false,
        error: error instanceof Error ? error.message : String(error)
      };
      throw error;
    });
    this.server = null;
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

  private closeServer(server: Server): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private resolveOAuth(planweaveHome: string): McpOAuthConfig | undefined {
    if (typeof this.options.oauth === "function") {
      return this.options.oauth(planweaveHome);
    }
    return this.options.oauth;
  }

  private async checkHealth(host: string, port: number, signal: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(`http://${host}:${port}/healthz`, { signal });
      return response.ok;
    } catch {
      signal.throwIfAborted();
      return false;
    }
  }
}
