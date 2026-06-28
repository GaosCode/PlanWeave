import { EventEmitter } from "node:events";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMcpTunnel } from "../tunnel/run.js";
import type { LocalMcpServerStatus, TunnelClientStatus, TunnelConfig, TunnelConfigStore } from "../tunnel/types.js";

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
        env: { OPENAI_RUNTIME_API_KEY: "runtime-key" }
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
          env: { OPENAI_RUNTIME_API_KEY: "runtime-key" }
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
          env: { OPENAI_RUNTIME_API_KEY: "runtime-key" }
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
});
