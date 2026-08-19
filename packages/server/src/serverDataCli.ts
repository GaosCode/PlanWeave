import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { loadServerConfig } from "./config.js";
import {
  ServerDataArchiveError,
  exportServerDataDirectory,
  restoreServerDataDirectory
} from "./serverDataArchive.js";
import {
  resolveComposeRestoreDirectory,
  restoreServerDataViaCompose,
  ServerDataComposeError,
  type DockerComposeRunner
} from "./serverDataCompose.js";

const absolutePathSchema = z.string().min(1).max(4096).refine(isAbsolute, "Path must be absolute.");

export type ServerDataCliIo = { stdout(value: string): void; stderr(value: string): void };

function takeFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error("server_cli_usage");
  return value;
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function resolveAbsolutePath(path: string, cwd: string): string {
  return absolutePathSchema.parse(resolve(cwd, path));
}

export async function runServerDataCli(
  args: readonly string[],
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    io: ServerDataCliIo;
    cwd?: string;
    runDockerCompose?: DockerComposeRunner;
  }
): Promise<number> {
  const [action, ...rest] = args;
  const cwd = options.cwd ?? process.cwd();
  const configFlag = takeFlag(rest, "--config");
  const composeDirFlag = takeFlag(rest, "--compose-dir");
  const configPath =
    configFlag ?? (composeDirFlag ? undefined : options.env?.PLANWEAVE_SERVER_CONFIG);
  if (action === "export") {
    if (!configPath) throw new Error("server_config_path_required");
    const outPath = takeFlag(rest, "--out");
    if (!outPath) throw new Error("server_cli_usage");
    const config = await loadServerConfig(resolveAbsolutePath(configPath, cwd));
    const manifest = await exportServerDataDirectory({
      dataDirectory: config.dataDirectory,
      archivePath: resolveAbsolutePath(outPath, cwd)
    });
    options.io.stdout(JSON.stringify(manifest));
    return 0;
  }
  if (action === "restore") {
    const fromPath = takeFlag(rest, "--from");
    if (!fromPath) throw new Error("server_cli_usage");
    const overwrite = hasFlag(rest, "--overwrite");
    const archivePath = resolveAbsolutePath(fromPath, cwd);
    if (configPath) {
      const config = await loadServerConfig(resolveAbsolutePath(configPath, cwd));
      const manifest = await restoreServerDataDirectory({
        dataDirectory: config.dataDirectory,
        archivePath,
        overwrite
      });
      options.io.stdout(JSON.stringify(manifest));
      return 0;
    }
    const candidate = composeDirFlag ? resolveAbsolutePath(composeDirFlag, cwd) : cwd;
    const composeDirectory = await resolveComposeRestoreDirectory(candidate);
    if (!composeDirectory) {
      throw new Error(
        composeDirFlag ? "server_compose_not_found" : "server_compose_or_config_required"
      );
    }
    const restored = await restoreServerDataViaCompose({
      composeDirectory,
      archivePath,
      overwrite,
      runDockerCompose: options.runDockerCompose
    });
    if (restored.manifestJson) options.io.stdout(restored.manifestJson);
    return 0;
  }
  throw new Error("server_cli_usage");
}

export function serverDataCliErrorCode(error: unknown): string {
  if (error instanceof ServerDataArchiveError || error instanceof ServerDataComposeError) {
    return error.code;
  }
  if (error instanceof Error) return error.message.split(":", 1)[0] ?? "server_failed";
  return "server_failed";
}
