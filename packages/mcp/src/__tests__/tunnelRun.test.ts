import { EventEmitter } from "node:events";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMcpTunnel } from "../tunnel/run.js";
import type {
  LocalMcpServerStatus,
  TunnelClientStatus,
  TunnelConfig,
  TunnelConfigStore
} from "../tunnel/types.js";

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function localStatus(phase: LocalMcpServerStatus["phase"]): LocalMcpServerStatus {
  return {
    phase,
    endpoint: phase === "running" ? "http://127.0.0.1:8787/mcp" : null,
    host: "127.0.0.1",
    port: 8787,
    pid: phase === "running" ? process.pid : null,
    planweaveHome: "/tmp/planweave",
    planweaveHomeFromEnv: false,
    healthy: phase === "running",
    error: null
  };
}

function tunnelStatus(phase: TunnelClientStatus["phase"]): TunnelClientStatus {
  return {
    phase,
    profile: "planweave-local-http",
    tunnelId: "tunnel_test",
    pid: phase === "running" ? 123 : null,
    healthUrl: phase === "running" ? "http://127.0.0.1:12345" : null,
    ready: phase === "running",
    error: null
  };
}

describe("MCP tunnel runner", () => {
  it("cleans up tunnel-client and local MCP server on SIGTERM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-mcp-run-"));
    const binaryPath = join(dir, "tunnel-client");
    await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(binaryPath, 0o700);
    const config: TunnelConfig = {
      version: "mcp-tunnel/v1",
      tunnelClientPath: binaryPath,
      verification: null,
      tunnelId: "tunnel_test",
      mcpUrl: "http://127.0.0.1:8787/mcp"
    };
    const store: TunnelConfigStore = {
      read: async () => config,
      write: async () => undefined,
      path: () => join(dir, "config.json")
    };
    const signals = new EventEmitter();
    let localStopped = false;
    let tunnelStopped = false;

    const running = runMcpTunnel(
      {
        store,
        serve: true,
        env: { OPENAI_RUNTIME_API_KEY: "runtime-key", PLANWEAVE_MCP_TOKEN: "mcp-token" }
      },
      {
        localMcp: {
          start: async () => localStatus("running"),
          stop: async () => {
            localStopped = true;
            return localStatus("stopped");
          }
        },
        tunnelClient: {
          start: async () => tunnelStatus("running"),
          stop: async () => {
            tunnelStopped = true;
            return tunnelStatus("stopped");
          },
          getStatus: () => tunnelStatus("running")
        },
        signals,
        exit: (code: number): never => {
          throw new ExitSignal(code);
        }
      }
    );
    const interval = setInterval(() => signals.emit("SIGTERM"), 5);
    try {
      await expect(running).rejects.toMatchObject({ code: 0 });
    } finally {
      clearInterval(interval);
    }
    expect(localStopped).toBe(true);
    expect(tunnelStopped).toBe(true);
  });

  it("cleans up the local MCP server when a running tunnel-client exits with an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-mcp-run-error-"));
    const binaryPath = join(dir, "tunnel-client");
    await writeFile(
      binaryPath,
      [
        "#!/usr/bin/env node",
        "const http = require('node:http');",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'init') process.exit(0);",
        "const file = args[args.indexOf('--health.url-file') + 1];",
        "const server = http.createServer((req, res) => {",
        "  res.writeHead(req.url === '/readyz' ? 200 : 404);",
        "  res.end('ok');",
        "});",
        "server.listen(0, '127.0.0.1', () => {",
        "  const { port } = server.address();",
        "  fs.writeFileSync(file, `http://127.0.0.1:${port}`);",
        "  setTimeout(() => process.exit(2), 1000);",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(binaryPath, 0o700);
    const config: TunnelConfig = {
      version: "mcp-tunnel/v1",
      tunnelClientPath: binaryPath,
      verification: null,
      tunnelId: "tunnel_test",
      mcpUrl: "http://127.0.0.1:8787/mcp"
    };
    const store: TunnelConfigStore = {
      read: async () => config,
      write: async () => undefined,
      path: () => join(dir, "config.json")
    };
    let localStopped = false;

    await expect(
      runMcpTunnel(
        {
          store,
          serve: true,
          env: { OPENAI_RUNTIME_API_KEY: "runtime-key", PLANWEAVE_MCP_TOKEN: "mcp-token" }
        },
        {
          localMcp: {
            start: async () => localStatus("running"),
            stop: async () => {
              localStopped = true;
              return localStatus("stopped");
            }
          }
        }
      )
    ).rejects.toThrow("tunnel-client exited with code 2");
    expect(localStopped).toBe(true);
  }, 20_000);

  it("handles a tunnel-client exit that happens before the wait promise is installed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-mcp-run-missed-exit-"));
    const binaryPath = join(dir, "tunnel-client");
    await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(binaryPath, 0o700);
    const config: TunnelConfig = {
      version: "mcp-tunnel/v1",
      tunnelClientPath: binaryPath,
      verification: null,
      tunnelId: "tunnel_test",
      mcpUrl: "http://127.0.0.1:8787/mcp"
    };
    const store: TunnelConfigStore = {
      read: async () => config,
      write: async () => undefined,
      path: () => join(dir, "config.json")
    };
    let localStopped = false;
    let tunnelStopped = false;

    await expect(
      runMcpTunnel(
        {
          store,
          serve: true,
          env: { OPENAI_RUNTIME_API_KEY: "runtime-key", PLANWEAVE_MCP_TOKEN: "mcp-token" }
        },
        {
          localMcp: {
            start: async () => localStatus("running"),
            stop: async () => {
              localStopped = true;
              return localStatus("stopped");
            }
          },
          tunnelClient: {
            start: async () => tunnelStatus("running"),
            stop: async () => {
              tunnelStopped = true;
              return tunnelStatus("stopped");
            },
            getStatus: () => ({
              ...tunnelStatus("error"),
              error: "tunnel-client exited before wait registration."
            })
          }
        }
      )
    ).rejects.toThrow("tunnel-client exited before wait registration.");
    expect(localStopped).toBe(true);
    expect(tunnelStopped).toBe(true);
  });

  it("refuses to serve MCP through a tunnel without authentication", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-mcp-run-no-auth-"));
    const binaryPath = join(dir, "tunnel-client");
    await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(binaryPath, 0o700);
    const config: TunnelConfig = {
      version: "mcp-tunnel/v1",
      tunnelClientPath: binaryPath,
      verification: null,
      tunnelId: "tunnel_test",
      mcpUrl: "http://127.0.0.1:8787/mcp"
    };
    const store: TunnelConfigStore = {
      read: async () => config,
      write: async () => undefined,
      path: () => join(dir, "config.json")
    };
    let localStarted = false;

    await expect(
      runMcpTunnel(
        {
          store,
          serve: true,
          env: { OPENAI_RUNTIME_API_KEY: "runtime-key" }
        },
        {
          localMcp: {
            start: async () => {
              localStarted = true;
              return localStatus("running");
            },
            stop: async () => localStatus("stopped")
          }
        }
      )
    ).rejects.toThrow(/requires authentication/);
    expect(localStarted).toBe(false);
  });

  it("passes PLANWEAVE_MCP_TOKEN into the local MCP server when serving", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-mcp-run-with-token-"));
    const binaryPath = join(dir, "tunnel-client");
    await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(binaryPath, 0o700);
    const config: TunnelConfig = {
      version: "mcp-tunnel/v1",
      tunnelClientPath: binaryPath,
      verification: null,
      tunnelId: "tunnel_test",
      mcpUrl: "http://127.0.0.1:8787/mcp"
    };
    const store: TunnelConfigStore = {
      read: async () => config,
      write: async () => undefined,
      path: () => join(dir, "config.json")
    };
    const signals = new EventEmitter();
    let startInput:
      | {
          host?: string | null;
          port?: number | null;
          token?: string | null;
          oauth?: { enabled: boolean } | null;
          trustForwardedHeaders?: boolean;
        }
      | undefined;

    const running = runMcpTunnel(
      {
        store,
        serve: true,
        env: {
          OPENAI_RUNTIME_API_KEY: "runtime-key",
          PLANWEAVE_MCP_TOKEN: "mcp-serve-token"
        }
      },
      {
        localMcp: {
          start: async (input) => {
            startInput = input;
            return localStatus("running");
          },
          stop: async () => localStatus("stopped")
        },
        tunnelClient: {
          start: async () => tunnelStatus("running"),
          stop: async () => tunnelStatus("stopped"),
          getStatus: () => tunnelStatus("running")
        },
        signals,
        exit: (code: number): never => {
          throw new ExitSignal(code);
        }
      }
    );
    const interval = setInterval(() => signals.emit("SIGTERM"), 5);
    try {
      await expect(running).rejects.toMatchObject({ code: 0 });
    } finally {
      clearInterval(interval);
    }
    expect(startInput?.token).toBe("mcp-serve-token");
    expect(startInput?.oauth).toBeNull();
    expect(startInput?.trustForwardedHeaders).toBe(true);
  });

  it("passes oauth.enabled when serving with PLANWEAVE_MCP_OAUTH_ENABLED only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-mcp-run-with-oauth-"));
    const binaryPath = join(dir, "tunnel-client");
    await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(binaryPath, 0o700);
    const config: TunnelConfig = {
      version: "mcp-tunnel/v1",
      tunnelClientPath: binaryPath,
      verification: null,
      tunnelId: "tunnel_test",
      mcpUrl: "http://127.0.0.1:8787/mcp"
    };
    const store: TunnelConfigStore = {
      read: async () => config,
      write: async () => undefined,
      path: () => join(dir, "config.json")
    };
    const signals = new EventEmitter();
    let startInput:
      | {
          host?: string | null;
          port?: number | null;
          token?: string | null;
          oauth?: {
            enabled: boolean;
            clientStorePath?: string;
            tokenStorePath?: string;
            redirectUriPrefixes?: string[];
          } | null;
          trustForwardedHeaders?: boolean;
        }
      | undefined;

    const running = runMcpTunnel(
      {
        store,
        serve: true,
        env: {
          OPENAI_RUNTIME_API_KEY: "runtime-key",
          PLANWEAVE_MCP_OAUTH_ENABLED: "true",
          PLANWEAVE_MCP_OAUTH_CLIENT_STORE: "/tmp/planweave-oauth-clients.json",
          PLANWEAVE_MCP_OAUTH_TOKEN_STORE: "/tmp/planweave-oauth-tokens.json",
          PLANWEAVE_MCP_OAUTH_REDIRECT_URI_PREFIXES:
            " https://chat.openai.com/, ,https://chatgpt.com/ "
        }
      },
      {
        localMcp: {
          start: async (input) => {
            startInput = input;
            return localStatus("running");
          },
          stop: async () => localStatus("stopped")
        },
        tunnelClient: {
          start: async () => tunnelStatus("running"),
          stop: async () => tunnelStatus("stopped"),
          getStatus: () => tunnelStatus("running")
        },
        signals,
        exit: (code: number): never => {
          throw new ExitSignal(code);
        }
      }
    );
    const interval = setInterval(() => signals.emit("SIGTERM"), 5);
    try {
      await expect(running).rejects.toMatchObject({ code: 0 });
    } finally {
      clearInterval(interval);
    }
    expect(startInput?.token).toBeNull();
    expect(startInput?.trustForwardedHeaders).toBe(true);
    expect(startInput?.oauth).toEqual({
      enabled: true,
      clientStorePath: "/tmp/planweave-oauth-clients.json",
      tokenStorePath: "/tmp/planweave-oauth-tokens.json",
      redirectUriPrefixes: ["https://chat.openai.com/", "https://chatgpt.com/"]
    });
  });
});
