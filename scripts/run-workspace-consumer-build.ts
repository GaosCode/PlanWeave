import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AdvisoryLockScope,
  withAdvisoryDirectoryLock
} from "../packages/runtime/src/fs/advisoryDirectoryLock.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildLockPath = join(repoRoot, ".planweave-workspace-consumer-build.lock");
const BUILD_LOCK_TIMEOUT_MS = 900_000;
const STALE_BUILD_LOCK_MS = 1_800_000;

const targets = {
  cli: {
    cwd: join(repoRoot, "packages/cli"),
    script: "build:workspace"
  },
  desktop: {
    cwd: join(repoRoot, "packages/desktop"),
    script: "build:standalone"
  }
} as const;

type BuildTarget = keyof typeof targets;

function resolveTarget(value: string | undefined): BuildTarget {
  if (value === "cli" || value === "desktop") {
    return value;
  }
  throw new Error("Workspace consumer build target must be 'cli' or 'desktop'.");
}

async function runPackageScript(buildTarget: BuildTarget, scope: AdvisoryLockScope): Promise<void> {
  const definition = targets[buildTarget];
  const pnpmPath = process.env.npm_execpath;
  if (!pnpmPath) throw new Error("Workspace consumer builds must be invoked through pnpm 10.32.1.");
  const executable = await realpath(pnpmPath);
  const manifest: unknown = JSON.parse(
    await readFile(resolve(dirname(executable), "../package.json"), "utf8")
  );
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("name" in manifest) ||
    manifest.name !== "pnpm" ||
    !("version" in manifest) ||
    manifest.version !== "10.32.1"
  ) {
    throw new Error("Managed workspace builds require the audited pnpm 10.32.1 toolchain.");
  }
  if (process.platform === "win32" && !process.env.SystemRoot)
    throw new Error("Managed build requires SystemRoot for the audited command interpreter.");
  const scriptShell = process.platform === "win32" ? "" : "/bin/sh";
  const commandInterpreter =
    process.platform === "win32"
      ? join(String(process.env.SystemRoot), "System32", "cmd.exe")
      : undefined;
  const env = Object.fromEntries(
    Object.entries(process.env).map(([key, value]) => [
      key,
      key.toLowerCase() === "npm_config_script_shell"
        ? scriptShell
        : key.toLowerCase() === "comspec" && commandInterpreter
          ? commandInterpreter
          : value
    ])
  );
  env.npm_config_script_shell = scriptShell;
  if (commandInterpreter) env.ComSpec = commandInterpreter;
  await scope.runManagedCommand({
    command: process.execPath,
    args: [executable, `--config.script-shell=${scriptShell}`, "run", definition.script],
    cwd: definition.cwd,
    env
  });
}

const selectedTarget = resolveTarget(process.argv[2]);
await withAdvisoryDirectoryLock(
  {
    lockPath: buildLockPath,
    operation: `${selectedTarget} workspace consumer build`,
    timeoutMs: BUILD_LOCK_TIMEOUT_MS,
    staleMs: STALE_BUILD_LOCK_MS
  },
  async (scope) => runPackageScript(selectedTarget, scope)
);
