import type { Server } from "node:http";
import type { Command } from "commander";
import {
  createFileTunnelConfigStore,
  defaultTunnelClientInstallRoot,
  defaultTunnelMcpUrl,
  downloadOfficialTunnelClient,
  getTunnelStatusReport,
  listenPlanweaveMcpServer,
  parseLoopbackMcpUrl,
  readMcpConfig,
  renderSystemdTemplates,
  resolveRuntimeApiKey,
  resolveTunnelClientBinary,
  runMcpTunnel,
  type TunnelConfig,
  type TunnelStatusReport
} from "@planweave-ai/mcp";

type ServeOptions = {
  host?: string;
  port?: string;
  token?: string;
  oauth?: boolean;
  json?: boolean;
};

type JsonOption = {
  json?: boolean;
};

type ConfigureOptions = {
  tunnelId?: string;
  mcpUrl?: string;
  port?: string;
};

type PrintSystemdOptions = {
  serviceName?: string;
  workingDirectory?: string;
  planweaveHome?: string;
  envFile?: string;
  planweaveBin?: string;
  user?: string;
};

function parsePort(value: string | undefined, optionName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${optionName} must be an integer between 1 and 65535.`);
  }
  const port = Number(trimmed);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${optionName} must be an integer between 1 and 65535.`);
  }
  return port;
}

function configureMcpUrl(options: ConfigureOptions): string {
  if (options.mcpUrl && options.port) {
    throw new Error("--mcp-url cannot be combined with --port.");
  }
  const port = parsePort(options.port, "--port");
  const mcpUrl = options.mcpUrl?.trim() || (port ? `http://127.0.0.1:${port}/mcp` : defaultTunnelMcpUrl);
  parseLoopbackMcpUrl(mcpUrl);
  return mcpUrl;
}

function formatTunnelStatusHuman(report: TunnelStatusReport): string {
  const binaryState = report.binary.available
    ? `${report.binary.source ?? "unknown"}${report.binary.verified ? " verified" : " unverified"}`
    : `missing${report.binary.error ? ` (${report.binary.error})` : ""}`;
  const runtimeApiKey = report.runtimeApiKey.available ? `from ${report.runtimeApiKey.source}` : "missing";
  return [
    `MCP tunnel: ${report.configured ? "configured" : "not configured"}`,
    `config: ${report.configPath}`,
    `binary: ${report.binary.available ? "ready" : "not ready"} ${binaryState}`,
    `tunnel id: ${report.config.tunnelId ? "configured" : "missing"}`,
    `runtime api key: ${runtimeApiKey}`,
    `mcp url: ${report.config.mcpUrl}`
  ].join("\n");
}

function formatTunnelDoctorHuman(report: TunnelStatusReport): string {
  return report.checks.map((item) => `${item.status === "passed" ? "ok" : "fail"} ${item.check}: ${item.message}`).join("\n");
}

function redactTunnelStatusReport(report: TunnelStatusReport): Omit<TunnelStatusReport, "config"> & {
  config: Omit<TunnelStatusReport["config"], "tunnelId"> & { tunnelIdConfigured: boolean };
} {
  const { tunnelId, ...config } = report.config;
  return {
    ...report,
    config: {
      ...config,
      tunnelIdConfigured: Boolean(tunnelId)
    }
  };
}

function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function serveMcp(options: ServeOptions): Promise<void> {
  const env = { ...process.env };
  if (options.host !== undefined) {
    env.PLANWEAVE_MCP_HOST = options.host;
  }
  const port = parsePort(options.port, "--port");
  if (port !== undefined) {
    env.PLANWEAVE_MCP_PORT = String(port);
  }
  if (options.token !== undefined) {
    env.PLANWEAVE_MCP_TOKEN = options.token;
  }
  if (options.oauth === true) {
    env.PLANWEAVE_MCP_OAUTH_ENABLED = "1";
  }
  const config = readMcpConfig(env);
  const server = await listenPlanweaveMcpServer(config);
  const endpoint = `http://${config.host}:${config.port}/mcp`;
  if (options.json) {
    writeJson({ endpoint, host: config.host, port: config.port, oauth: config.oauth?.enabled === true, tokenConfigured: Boolean(config.token) });
  } else {
    console.log(`PlanWeave MCP server listening on ${endpoint}`);
  }
  await waitForMcpServerStop(server);
}

function waitForMcpServerStop(server: Server): Promise<void> {
  return new Promise((resolve) => {
    const close = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      server.close(() => resolve());
    };
    const onSigint = () => close();
    const onSigterm = () => close();
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
}

export function registerMcpCommand(program: Command): void {
  const mcp = program.command("mcp").description("Run and configure PlanWeave MCP server and tunnel");

  mcp
    .command("serve")
    .description("Run the PlanWeave MCP HTTP server in the foreground")
    .option("--host <host>", "host to listen on")
    .option("--port <port>", "port to listen on")
    .option("--token <token>", "bearer token for MCP requests")
    .option("--oauth", "enable OAuth authorization")
    .option("--json", "print machine-readable startup output")
    .action(serveMcp);

  const tunnel = mcp.command("tunnel").description("Configure and run the OpenAI tunnel-client for PlanWeave MCP");

  tunnel
    .command("download")
    .description("Download the official tunnel-client and save its verification metadata")
    .action(async () => {
      const store = createFileTunnelConfigStore();
      const config = await store.read();
      const result = await downloadOfficialTunnelClient(defaultTunnelClientInstallRoot());
      const nextConfig: TunnelConfig = {
        ...config,
        tunnelClientPath: result.binaryPath,
        verification: result.verification
      };
      await store.write(nextConfig);
      console.log(`downloaded tunnel-client: ${result.binaryPath}`);
    });

  tunnel
    .command("set-binary")
    .description("Record a manually installed tunnel-client binary")
    .argument("<path>", "path to tunnel-client")
    .action(async (path: string) => {
      const binary = await resolveTunnelClientBinary(path, null);
      if (!binary.available) {
        throw new Error(binary.error ?? "Tunnel client binary is not available.");
      }
      const store = createFileTunnelConfigStore();
      const config = await store.read();
      await store.write({
        ...config,
        tunnelClientPath: binary.path,
        verification: null
      });
      console.log(`configured tunnel-client: ${binary.path}`);
    });

  tunnel
    .command("configure")
    .description("Save tunnel id and local MCP endpoint")
    .requiredOption("--tunnel-id <id>", "OpenAI tunnel id")
    .option("--mcp-url <url>", "loopback MCP endpoint URL")
    .option("--port <port>", "loopback MCP port; equivalent to http://127.0.0.1:<port>/mcp")
    .action(async (options: ConfigureOptions) => {
      const tunnelId = options.tunnelId?.trim();
      if (!tunnelId) {
        throw new Error("--tunnel-id is required.");
      }
      const store = createFileTunnelConfigStore();
      const config = await store.read();
      const nextConfig: TunnelConfig = {
        ...config,
        tunnelId,
        mcpUrl: configureMcpUrl(options)
      };
      await store.write(nextConfig);
      console.log(`configured MCP tunnel: ${nextConfig.mcpUrl}`);
    });

  tunnel
    .command("status")
    .description("Print MCP tunnel configuration status without starting processes")
    .option("--json", "print machine-readable output")
    .action(async (options: JsonOption) => {
      const report = await getTunnelStatusReport(createFileTunnelConfigStore());
      if (options.json) {
        writeJson(redactTunnelStatusReport(report));
      } else {
        console.log(formatTunnelStatusHuman(report));
      }
    });

  tunnel
    .command("doctor")
    .description("Run MCP tunnel preflight checks without starting long-running processes")
    .option("--json", "print machine-readable output")
    .action(async (options: JsonOption) => {
      const report = await getTunnelStatusReport(createFileTunnelConfigStore());
      if (options.json) {
        writeJson({ ok: report.checks.every((item) => item.status === "passed"), checks: report.checks, status: redactTunnelStatusReport(report) });
      } else {
        console.log(formatTunnelDoctorHuman(report));
      }
    });

  tunnel
    .command("run")
    .description("Run the configured tunnel-client in the foreground")
    .option("--serve", "start the local MCP server in the same process")
    .action(async (options: { serve?: boolean }) => {
      await runMcpTunnel({
        store: createFileTunnelConfigStore(),
        serve: options.serve === true
      });
    });

  tunnel
    .command("print-systemd")
    .description("Print systemd service and EnvironmentFile templates")
    .option("--service-name <name>", "systemd service name", "planweave-mcp-tunnel")
    .option("--working-directory <path>", "service working directory", "/srv/planweave")
    .option("--planweave-home <path>", "PLANWEAVE_HOME value", "/srv/planweave")
    .option("--env-file <path>", "EnvironmentFile path", "/etc/planweave/mcp-tunnel.env")
    .option("--planweave-bin <path>", "planweave executable path", "/usr/local/bin/planweave")
    .option("--user <user>", "system user for the service")
    .action((options: PrintSystemdOptions) => {
      const runtimeKey = resolveRuntimeApiKey();
      const output = renderSystemdTemplates({
        serviceName: options.serviceName ?? "planweave-mcp-tunnel",
        workingDirectory: options.workingDirectory ?? "/srv/planweave",
        planweaveHome: options.planweaveHome ?? "/srv/planweave",
        envFile: options.envFile ?? "/etc/planweave/mcp-tunnel.env",
        planweaveBin: options.planweaveBin ?? "/usr/local/bin/planweave",
        user: options.user ?? null
      });
      if (runtimeKey.available && output.includes(runtimeKey.value)) {
        throw new Error("systemd template rendering attempted to include a Runtime API key.");
      }
      console.log(output);
    });
}
