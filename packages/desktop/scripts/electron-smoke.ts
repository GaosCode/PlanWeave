import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initWorkspace } from "@planweave-ai/runtime";

const mainEntry = resolve(process.cwd(), "dist", "main", "main.js");
const electronBin = resolve(process.cwd(), "node_modules", ".bin", "electron");
const repoRoot = resolve(process.cwd(), "../..");
const usePackagedApp = process.env.PLANWEAVE_DESKTOP_SMOKE_PACKAGED === "1";

async function resolvePackagedExecutable(): Promise<string> {
  const releaseDir = resolve(process.cwd(), "release");
  const entries = await readdir(releaseDir, { withFileTypes: true }).catch(() => []);
  const appPath = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
    .map((entry) => resolve(releaseDir, entry.name, "PlanWeave.app"))
    .sort()[0];
  return resolve(
    appPath ?? resolve(releaseDir, "mac-arm64", "PlanWeave.app"),
    "Contents",
    "MacOS",
    "PlanWeave"
  );
}

const smokeHome = await mkdtemp(join(tmpdir(), "planweave-desktop-smoke-home-"));
const smokeUserData = await mkdtemp(join(tmpdir(), "planweave-desktop-smoke-user-data-"));
const smokeProjectRoot = await mkdtemp(join(tmpdir(), "planweave-desktop-smoke-project-"));
process.env.PLANWEAVE_HOME = smokeHome;
const init = await initWorkspace({ projectRoot: smokeProjectRoot });

await cp(
  resolve(repoRoot, "examples", "basic-plan-package", "package"),
  init.workspace.packageDir,
  {
    recursive: true,
    force: true
  }
);
await writeFile(init.workspace.projectPromptFile, "Desktop smoke project prompt.\n", "utf8");

const smokeCommand = usePackagedApp ? await resolvePackagedExecutable() : electronBin;
const smokeArgs = usePackagedApp ? [] : [mainEntry];

const child = spawn(smokeCommand, smokeArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PLANWEAVE_HOME: smokeHome,
    PLANWEAVE_DESKTOP_SMOKE_PROJECT_ROOT: smokeProjectRoot,
    PLANWEAVE_DESKTOP_SMOKE_EXTERNAL_PROMPT_PATH: join(
      init.workspace.packageDir,
      "nodes",
      "T-001",
      "prompt.md"
    ),
    PLANWEAVE_DESKTOP_SMOKE_USER_DATA_DIR: smokeUserData,
    PLANWEAVE_DESKTOP_SMOKE: "1"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";

child.stdout.on("data", (chunk: Buffer) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
});

child.stderr.on("data", (chunk: Buffer) => {
  const text = chunk.toString();
  output += text;
  process.stderr.write(text);
});

const timeout = setTimeout(() => {
  child.kill("SIGTERM");
  console.error("Electron smoke timed out.");
  process.exit(1);
}, 15_000);

child.on("exit", (code) => {
  clearTimeout(timeout);
  if (code !== 0) {
    process.exit(code ?? 1);
  }
  if (!output.includes("PLANWEAVE_DESKTOP_SMOKE_READY")) {
    console.error("Electron smoke did not report readiness.");
    process.exit(1);
  }
});
