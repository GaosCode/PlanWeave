import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withAdvisoryDirectoryLock } from "../packages/runtime/src/fs/advisoryDirectoryLock.js";

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

async function runPackageScript(buildTarget: BuildTarget): Promise<void> {
  const definition = targets[buildTarget];
  const child = spawn("pnpm", ["run", definition.script], {
    cwd: definition.cwd,
    shell: process.platform === "win32",
    stdio: "inherit"
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveResult, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveResult({ code, signal }));
    }
  );
  if (result.code !== 0) {
    let detail = `exit code ${String(result.code)}`;
    if (result.signal) {
      detail = `signal ${result.signal}`;
    }
    throw new Error(`${buildTarget} workspace build failed with ${detail}.`);
  }
}

const selectedTarget = resolveTarget(process.argv[2]);
await withAdvisoryDirectoryLock(
  {
    lockPath: buildLockPath,
    operation: `${selectedTarget} workspace consumer build`,
    timeoutMs: BUILD_LOCK_TIMEOUT_MS,
    staleMs: STALE_BUILD_LOCK_MS
  },
  async () => runPackageScript(selectedTarget)
);
