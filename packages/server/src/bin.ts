#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadServerConfig, resolveServerConfigPath, serverConfigSummary } from "./config.js";
import { migrateServerConfigFile } from "./configMigration.js";
import { runReleaseGateCli } from "./releaseGate/cli.js";
import { serveDistributedServer, type DistributedServerProcess } from "./serverServe.js";
import { runVpsE2eCli } from "./vpsE2e/cli.js";
import { runServerDataCli } from "./serverDataCli.js";
import type { DockerComposeRunner } from "./serverDataCompose.js";

export type ServerCliIo = { stdout(value: string): void; stderr(value: string): void };

/** Public usage text for `planweave-server --help` (stdout, exit 0). */
export const SERVER_CLI_USAGE = [
  "Usage: planweave-server <command> [options]",
  "",
  "Commands:",
  "  serve --config <absolute-path>",
  "  config migrate --config <absolute-path>",
  "  data export --config <absolute-path> --out <absolute-path>",
  "  data restore --from <path> [--overwrite] [--config <absolute-path>] [--compose-dir <absolute-path>]",
  "  vps-e2e [options]",
  "  release-gate [options]",
  "",
  "Environment:",
  "  PLANWEAVE_SERVER_CONFIG  absolute config path (alternative to serve --config)"
].join("\n");

export async function waitForServerSignal(
  server: Pick<DistributedServerProcess, "close">,
  processLike: Pick<NodeJS.Process, "once" | "off">
): Promise<void> {
  let resolveSignal!: () => void;
  const signal = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const stop = () => resolveSignal();
  processLike.once("SIGINT", stop);
  processLike.once("SIGTERM", stop);
  try {
    await signal;
  } finally {
    processLike.off("SIGINT", stop);
    processLike.off("SIGTERM", stop);
    await server.close();
  }
}

export async function runServerCli(
  argv: readonly string[],
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    io?: ServerCliIo;
    cwd?: string;
    processLike?: Pick<NodeJS.Process, "once" | "off">;
    serve?: typeof serveDistributedServer;
    migrateConfig?: typeof migrateServerConfigFile;
    runDockerCompose?: DockerComposeRunner;
  } = {}
): Promise<number> {
  const io = options.io ?? { stdout: console.log, stderr: console.error };
  try {
    const [command, ...args] = argv;
    if (command === "--help" || command === "-h") {
      io.stdout(SERVER_CLI_USAGE);
      return 0;
    }
    if (command === "vps-e2e") {
      return await runVpsE2eCli(args, { io, env: options.env ? { ...options.env } : undefined });
    }
    if (command === "release-gate") {
      return await runReleaseGateCli(args, {
        io,
        env: options.env ? { ...options.env } : undefined
      });
    }
    if (command === "config") {
      if (args[0] !== "migrate") throw new Error("server_cli_usage");
      const configPath = resolveServerConfigPath(args.slice(1), {});
      const result = await (options.migrateConfig ?? migrateServerConfigFile)(configPath);
      io.stdout(JSON.stringify(result));
      return 0;
    }
    if (command === "data") {
      return await runServerDataCli(args, {
        env: options.env,
        io,
        cwd: options.cwd,
        runDockerCompose: options.runDockerCompose
      });
    }
    if (command !== "serve") throw new Error("server_cli_usage");
    const config = await loadServerConfig(resolveServerConfigPath(args, options.env));
    const server = await (options.serve ?? serveDistributedServer)(config);
    io.stdout(
      JSON.stringify({
        ...serverConfigSummary(config),
        status: "ready",
        serverVersion: server.version
      })
    );
    await waitForServerSignal(server, options.processLike ?? process);
    return 0;
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":", 1)[0] : "server_failed";
    io.stderr(code.startsWith("server_") ? code : "server_failed");
    return code === "server_cli_usage" ||
      code === "server_config_path_required" ||
      code === "server_compose_or_config_required" ||
      code === "server_compose_not_found"
      ? 2
      : 1;
  }
}

export function isServerCliEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isServerCliEntrypoint(import.meta.url, process.argv[1])) {
  process.exitCode = await runServerCli(process.argv.slice(2));
}
