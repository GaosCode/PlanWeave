import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export const PLANWEAVE_COMPOSE_FILE = "compose.yaml";
export const PLANWEAVE_COMPOSE_SERVICE = "server";
export const PLANWEAVE_COMPOSE_CONTAINER_CONFIG = "/run/planweave/input/config/server.json";
export const PLANWEAVE_COMPOSE_CONTAINER_ARCHIVE = "/tmp/planweave-server-data.tgz";
export const PLANWEAVE_COMPOSE_INNER_BIN = "/app/dist/bin.js";

export type DockerComposeResult = { exitCode: number; stdout: string; stderr: string };
export type DockerComposeRunner = (
  args: readonly string[],
  options: { cwd: string }
) => Promise<DockerComposeResult>;

export class ServerDataComposeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ServerDataComposeError";
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function resolveComposeRestoreDirectory(directory: string): Promise<string | null> {
  const root = resolve(directory);
  const composePath = join(root, PLANWEAVE_COMPOSE_FILE);
  const bundleConfigPath = join(root, "server.json");
  if (!(await pathExists(composePath)) || !(await pathExists(bundleConfigPath))) return null;
  return root;
}

export function composeProjectArgs(composeDirectory: string): string[] {
  return [
    "--project-directory",
    composeDirectory,
    "-f",
    join(composeDirectory, PLANWEAVE_COMPOSE_FILE)
  ];
}

export function composeStopArgs(composeDirectory: string): string[] {
  return [...composeProjectArgs(composeDirectory), "stop"];
}

export function composeUpArgs(composeDirectory: string): string[] {
  return [...composeProjectArgs(composeDirectory), "up", "-d", "--wait"];
}

export function composeRestoreRunArgs(input: {
  composeDirectory: string;
  archivePath: string;
  overwrite: boolean;
}): string[] {
  const restore = [
    PLANWEAVE_COMPOSE_INNER_BIN,
    "data",
    "restore",
    "--config",
    PLANWEAVE_COMPOSE_CONTAINER_CONFIG,
    "--from",
    PLANWEAVE_COMPOSE_CONTAINER_ARCHIVE,
    ...(input.overwrite ? ["--overwrite"] : [])
  ];
  return [
    ...composeProjectArgs(input.composeDirectory),
    "run",
    "-T",
    "--rm",
    "--no-deps",
    "--user",
    "node",
    "--entrypoint",
    "node",
    "-v",
    `${input.archivePath}:${PLANWEAVE_COMPOSE_CONTAINER_ARCHIVE}:ro`,
    PLANWEAVE_COMPOSE_SERVICE,
    ...restore
  ];
}

/** Host-side script packed into the self-host zip. Stops compose, restores, then starts. */
export const restoreServerDataScript = `#!/bin/sh
set -eu
cd "$(dirname "$0")"

OVERWRITE=""
ARCHIVE=""
for arg in "$@"; do
  if [ "$arg" = "--overwrite" ]; then
    OVERWRITE=1
  elif [ -z "$ARCHIVE" ]; then
    ARCHIVE=$arg
  else
    echo "restore-server-data: unexpected argument" >&2
    exit 2
  fi
done

if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Usage: ./restore-server-data.sh [--overwrite] <server-data.tgz>" >&2
  exit 2
fi
if [ ! -f ${PLANWEAVE_COMPOSE_FILE} ] || [ ! -f server.json ]; then
  echo "restore-server-data: run this from the PlanWeave Server compose directory" >&2
  exit 2
fi

ARCHIVE=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$ARCHIVE")
COMPOSE_DIR=$(pwd)

docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/${PLANWEAVE_COMPOSE_FILE}" stop

set -- docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/${PLANWEAVE_COMPOSE_FILE}" \\
  run -T --rm --no-deps --user node --entrypoint node \\
  -v "$ARCHIVE:${PLANWEAVE_COMPOSE_CONTAINER_ARCHIVE}:ro" \\
  ${PLANWEAVE_COMPOSE_SERVICE} \\
  ${PLANWEAVE_COMPOSE_INNER_BIN} data restore \\
  --config ${PLANWEAVE_COMPOSE_CONTAINER_CONFIG} \\
  --from ${PLANWEAVE_COMPOSE_CONTAINER_ARCHIVE}
if [ -n "$OVERWRITE" ]; then
  set -- "$@" --overwrite
fi
"$@"

docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/${PLANWEAVE_COMPOSE_FILE}" up -d --wait
`;

export async function runDockerComposeCommand(
  args: readonly string[],
  options: { cwd: string }
): Promise<DockerComposeResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new ServerDataComposeError("server_docker_unavailable"));
        return;
      }
      reject(error);
    });
    child.once("close", (code) => {
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function composeFailureCode(result: DockerComposeResult): string {
  const detail = result.stderr.trim().split("\n").at(-1)?.trim() ?? "";
  if (detail === "server_cli_usage") return "server_data_restore_image_unsupported";
  if (detail.startsWith("server_")) return detail;
  return "server_docker_compose_failed";
}

export async function restoreServerDataViaCompose(input: {
  composeDirectory: string;
  archivePath: string;
  overwrite: boolean;
  runDockerCompose?: DockerComposeRunner;
}): Promise<{ manifestJson: string }> {
  const composeDirectory = await resolveComposeRestoreDirectory(input.composeDirectory);
  if (!composeDirectory) throw new ServerDataComposeError("server_compose_not_found");
  const run = input.runDockerCompose ?? runDockerComposeCommand;
  const runCompose = async (subArgs: string[]): Promise<DockerComposeResult> =>
    run(["compose", ...subArgs], { cwd: composeDirectory });

  const stopped = await runCompose(composeStopArgs(composeDirectory));
  if (stopped.exitCode !== 0) throw new ServerDataComposeError(composeFailureCode(stopped));

  const restored = await runCompose(
    composeRestoreRunArgs({
      composeDirectory,
      archivePath: input.archivePath,
      overwrite: input.overwrite
    })
  );
  if (restored.exitCode !== 0) throw new ServerDataComposeError(composeFailureCode(restored));

  const started = await runCompose(composeUpArgs(composeDirectory));
  if (started.exitCode !== 0) throw new ServerDataComposeError(composeFailureCode(started));

  return { manifestJson: restored.stdout.trim() };
}
